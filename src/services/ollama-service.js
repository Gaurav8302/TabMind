/**
 * TabMind Ollama Service
 * Handles all communication with the Ollama local LLM API.
 * Responsible for: connection testing, prompt building, response validation,
 * and tab organization requests with automatic retry on invalid responses.
 *
 * All fetch() calls are proxied through the service worker to bypass CORS.
 * No UI logic belongs here — this is a pure data service.
 */

import { CONFIG } from '../config.js';

// ── Proxy Fetch ─────────────────────────────────────────
// Manifest V3 popup pages don't get CORS bypass from host_permissions.
// Only the service worker does. Route all external fetches through it.

/**
 * Sends a fetch request through the background service worker.
 * @param {string} url
 * @param {object} options - { method, headers, body }
 * @returns {Promise<{ ok: boolean, status: number, text: string }>}
 */
async function proxyFetch(url, options = {}) {
  const response = await chrome.runtime.sendMessage({
    type: 'PROXY_FETCH',
    url,
    options: {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body || null,
    },
  });

  if (!response) {
    throw new Error('No response from service worker. Extension may need reload.');
  }

  if (response.error) {
    throw new Error(response.error);
  }

  return response;
}

// ── Connection ──────────────────────────────────────────

/**
 * Tests connectivity to the Ollama API and verifies the target model is available.
 * @param {string} endpoint - The Ollama base URL (e.g. http://localhost:11434).
 * @param {string} model - The model name to check (e.g. gemma3:1b).
 * @returns {Promise<{ ok: boolean, error?: string, models?: string[] }>}
 */
export async function testConnection(endpoint, model) {
  try {
    const res = await proxyFetch(`${endpoint}/api/tags`);

    if (!res.ok) {
      return { ok: false, error: `Ollama responded with status ${res.status}.` };
    }

    let tagData;
    try {
      tagData = JSON.parse(res.text);
    } catch {
      return { ok: false, error: 'Invalid response from Ollama.' };
    }

    const availableModels = (tagData.models || []).map((m) => m.name);

    const modelFound = availableModels.some(
      (m) => m === model || m.startsWith(`${model}:`) || model.startsWith(`${m.split(':')[0]}`)
    );

    if (!modelFound && availableModels.length > 0) {
      return {
        ok: false,
        error: `Model "${model}" not found. Available: ${availableModels.slice(0, 5).join(', ')}`,
        models: availableModels,
      };
    }

    return { ok: true, models: availableModels };
  } catch (err) {
    if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError') || err.message?.includes('Fetch failed')) {
      return { ok: false, error: 'Cannot reach Ollama. Is it running at this endpoint?' };
    }
    return { ok: false, error: err.message || 'Unknown connection error.' };
  }
}

// ── Prompt Building ─────────────────────────────────────

/**
 * Builds the system + user prompt for tab organization.
 * @param {Array<{title: string, domain: string}>} tabSummaries - Extracted tab info.
 * @returns {{ system: string, user: string }}
 */
function buildPrompt(tabSummaries) {
  const maxGroups = Math.min(8, Math.max(2, Math.ceil(tabSummaries.length / 2)));
  const system = `/no_think
You are a browser workspace organizer. Group tabs into logical workspaces.

Rules:
- Every tab must belong to exactly one group.
- No uncategorized tabs allowed.
- No duplicate tab assignments.
- Create between 1 and ${maxGroups} groups. Use multiple groups when tabs cover different topics.
- Prefer these category names when they fit: AI Research, Development, Education, Shopping, Entertainment, Finance, Work, Personal.
- If none of those categories fit, create a descriptive custom name.
- Tab indices in the "tabs" array must be integers (e.g. 0, 1, 2), not strings.
- Return ONLY valid JSON. No markdown, no explanation, no thinking.`;

  const tabList = tabSummaries
    .map((t, i) => `[${i}] ${t.title} (${t.domain})`)
    .join('\n');

  const user = `Group these ${tabSummaries.length} browser tabs into logical workspaces.

Tabs:
${tabList}

Return JSON in this exact format:
{"groups":[{"name":"Category Name","tabs":[0,1,2]}]}

Rules reminder: every tab index (0 to ${tabSummaries.length - 1}) must appear exactly once across all groups. Return ONLY the JSON object.`;

  return { system, user };
}

/**
 * Builds a stricter retry prompt when the first attempt produced invalid output.
 * @param {Array<{title: string, domain: string}>} tabSummaries
 * @param {string} previousError - Description of what went wrong.
 * @returns {{ system: string, user: string }}
 */
function buildRetryPrompt(tabSummaries, previousError) {
  const { system } = buildPrompt(tabSummaries);

  const tabList = tabSummaries
    .map((t, i) => `[${i}] ${t.title} (${t.domain})`)
    .join('\n');

  const user = `Your previous response was invalid: ${previousError}

Try again. Group these ${tabSummaries.length} tabs.

Tabs:
${tabList}

CRITICAL: Return ONLY a raw JSON object. No markdown. No code fences. No explanation.
Format: {"groups":[{"name":"Name","tabs":[0,1,2]}]}
Every index from 0 to ${tabSummaries.length - 1} must appear exactly once.`;

  return { system, user };
}

// ── Tab Extraction ──────────────────────────────────────

/**
 * Extracts title and domain from full tab objects for the LLM prompt.
 * @param {Array<object>} tabs - Full tab objects from ChromeService.
 * @returns {Array<{title: string, domain: string}>}
 */
export function extractTabSummaries(tabs) {
  return tabs.map((tab) => {
    let domain = '';
    try {
      domain = new URL(tab.url).hostname.replace('www.', '');
    } catch {
      domain = 'unknown';
    }
    return {
      title: tab.title || 'Untitled',
      domain,
    };
  });
}

// ── Response Validation ─────────────────────────────────

/**
 * Validates and auto-repairs the AI response.
 * - Removes out-of-range and duplicate indices
 * - If a small number of tabs are unassigned (≤20%), adds them to an "Other" group
 * - Only fails if the response is fundamentally broken
 * @param {object} data - Parsed JSON response from Ollama.
 * @param {number} totalTabs - Expected total number of tab indices.
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateOrganization(data, totalTabs) {
  if (!data || !Array.isArray(data.groups)) {
    return { valid: false, error: 'Response missing "groups" array.' };
  }

  if (data.groups.length < 1 || data.groups.length > 8) {
    return {
      valid: false,
      error: `Expected 1-8 groups, got ${data.groups.length}.`,
    };
  }

  // Pass 1: clean up each group — remove invalid/duplicate indices
  const seen = new Set();
  for (let i = 0; i < data.groups.length; i++) {
    const group = data.groups[i];

    if (!group.name || typeof group.name !== 'string') {
      group.name = `Group ${i + 1}`;
    }

    if (!Array.isArray(group.tabs)) {
      group.tabs = [];
      continue;
    }

    // Filter to valid, unique, in-range indices
    group.tabs = group.tabs.filter((idx) => {
      if (typeof idx !== 'number' || idx < 0 || idx >= totalTabs) return false;
      if (seen.has(idx)) return false;
      seen.add(idx);
      return true;
    });
  }

  // Remove empty groups
  data.groups = data.groups.filter((g) => g.tabs.length > 0);

  if (data.groups.length === 0) {
    return { valid: false, error: 'All groups were empty after cleanup.' };
  }

  // Pass 2: find unassigned tabs
  const missing = [];
  for (let i = 0; i < totalTabs; i++) {
    if (!seen.has(i)) missing.push(i);
  }

  if (missing.length > 0) {
    // Allow auto-repair if ≤20% of tabs are missing
    const threshold = Math.max(3, Math.ceil(totalTabs * 0.2));
    if (missing.length > threshold) {
      return {
        valid: false,
        error: `${missing.length} tab(s) unassigned — too many to auto-fix.`,
      };
    }

    // Auto-assign missing tabs to the last group or create "Other"
    console.log(`TabMind: Auto-assigning ${missing.length} missed tab(s).`);
    const lastGroup = data.groups[data.groups.length - 1];
    lastGroup.tabs.push(...missing);
  }

  return { valid: true };
}


// ── Core API Call ────────────────────────────────────────

/**
 * Sends a chat completion request to Ollama via the service worker proxy.
 * @param {string} endpoint
 * @param {string} model
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<string>} The raw response text from the model.
 */
async function callOllama(endpoint, model, systemPrompt, userPrompt) {
  const res = await proxyFetch(`${endpoint}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      think: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      options: {
        temperature: 0.3,
        num_predict: 4096,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${(res.text || '').slice(0, 200)}`);
  }

  let data;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new Error('Invalid JSON response from Ollama.');
  }

  // Primary: check message.content
  // Fallback: some models put output in different fields
  const content = data.message?.content || '';

  if (!content.trim()) {
    throw new Error('Empty response from Ollama. The model may need more tokens or a simpler prompt.');
  }

  return content;
}

/**
 * Parses raw LLM text into JSON. Aggressively cleans common small-model
 * artifacts: thinking tags, code fences, extra prose, XML tags.
 * @param {string} raw - Raw model output text.
 * @returns {object} Parsed JSON object.
 */
function parseResponse(raw) {
  let cleaned = raw.trim();

  // Strip <think>...</think> blocks (DeepSeek, Gemma thinking)
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  cleaned = cleaned.replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/m, '');

  // Strip any remaining XML/HTML-like tags
  cleaned = cleaned.replace(/<[^>]+>/g, '');

  cleaned = cleaned.trim();

  // Try direct parse first
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall through to extraction
  }

  // Extract JSON object from surrounding prose by finding { ... }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const extracted = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(extracted);
    } catch {
      // Fall through
    }
  }

  // Nothing worked
  throw new Error('Could not extract valid JSON from model response.');
}

// ── Organize Tabs (Main Entry Point) ────────────────────

/**
 * Normalizes the parsed AI response to handle common model quirks:
 * - Coerces string tab indices ("0") to numbers (0)
 * - Filters out NaN values
 * @param {object} data - Parsed JSON from the model.
 * @returns {object} Normalized data with numeric tab indices.
 */
function normalizeResponse(data) {
  if (!data || !Array.isArray(data.groups)) return data;

  for (const group of data.groups) {
    if (Array.isArray(group.tabs)) {
      group.tabs = group.tabs
        .map((idx) => (typeof idx === 'string' ? parseInt(idx, 10) : idx))
        .filter((idx) => !isNaN(idx));
    }
  }

  return data;
}

/**
 * Sends tabs to Ollama for AI-powered organization.
 * Automatically retries once with a stricter prompt if validation fails.
 *
 * @param {string} endpoint - Ollama API base URL.
 * @param {string} model - Model name.
 * @param {Array<object>} tabs - Full tab objects from ChromeService.
 * @returns {Promise<{ groups: Array<{ name: string, tabs: number[] }> }>}
 * @throws {Error} If both attempts fail.
 */
export async function organizeTabs(endpoint, model, tabs) {
  const summaries = extractTabSummaries(tabs);
  const { system, user } = buildPrompt(summaries);

  let raw;
  try {
    raw = await callOllama(endpoint, model, system, user);
  } catch (err) {
    throw err;
  }

  let parsed;
  try {
    parsed = normalizeResponse(parseResponse(raw));
  } catch {
    return retryOrganize(endpoint, model, summaries, 'Response was not valid JSON.');
  }

  const validation = validateOrganization(parsed, tabs.length);
  if (!validation.valid) {
    return retryOrganize(endpoint, model, summaries, validation.error);
  }

  return parsed;
}

/**
 * Retry with stricter instructions after a failed first attempt.
 */
async function retryOrganize(endpoint, model, summaries, previousError) {
  console.warn(`TabMind: First AI attempt failed (${previousError}). Retrying...`);

  const { system, user } = buildRetryPrompt(summaries, previousError);

  const raw = await callOllama(endpoint, model, system, user);
  let parsed;

  try {
    parsed = normalizeResponse(parseResponse(raw));
  } catch {
    throw new Error('AI returned invalid JSON on both attempts.');
  }

  const validation = validateOrganization(parsed, summaries.length);
  if (!validation.valid) {
    throw new Error(`AI validation failed on retry: ${validation.error}`);
  }

  return parsed;
}
