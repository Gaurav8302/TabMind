/**
 * TabMind Summary Service
 * Generates AI-powered workspace summaries via Ollama.
 * Responsible for: prompt construction, domain extraction, response parsing,
 * summary cleanup, and length enforcement.
 *
 * Public API:
 *   generateWorkspaceSummary(workspace, endpoint, model) → { success, summary } | { success, error }
 *
 * All fetch() calls are proxied through the service worker to bypass CORS.
 * No UI logic belongs here — this is a pure data service.
 */

// ── Proxy Fetch ─────────────────────────────────────────
// Mirrors the pattern from ollama-service.js.
// Popup pages don't get CORS bypass — only the service worker does.

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

// ── Domain Extraction ───────────────────────────────────

/**
 * Extracts a clean domain from a URL.
 * Strips 'www.' prefix and returns the hostname.
 * @param {string} url - Full URL string.
 * @returns {string} Clean domain or empty string if invalid.
 */
function extractDomain(url) {
  if (!url) return '';
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Checks whether a URL is a tracking/internal URL that should be excluded.
 * @param {string} url
 * @returns {boolean}
 */
function isTrackingOrInternalUrl(url) {
  if (!url) return true;
  const lower = url.toLowerCase();

  // Internal browser pages
  if (
    lower.startsWith('chrome://') ||
    lower.startsWith('chrome-extension://') ||
    lower.startsWith('brave://') ||
    lower.startsWith('edge://') ||
    lower.startsWith('about:') ||
    lower.startsWith('devtools://')
  ) {
    return true;
  }

  // Common tracking/redirect domains
  const trackingDomains = [
    'google.com/url',
    'google.com/search',
    't.co/',
    'bit.ly/',
    'goo.gl/',
    'utm_',
  ];

  return trackingDomains.some((d) => lower.includes(d));
}

// ── Category Detection Heuristics ───────────────────────
// Lightweight domain/title pattern matching to provide context hints
// to the LLM. These are signals, not definitive classifications.

const CATEGORY_SIGNALS = {
  communication: {
    domains: [
      'mail.google.com', 'gmail.com', 'outlook.live.com', 'outlook.office.com',
      'web.whatsapp.com', 'web.telegram.org', 'discord.com', 'slack.com',
      'teams.microsoft.com', 'meet.google.com', 'zoom.us',
      'messenger.com', 'signal.org',
    ],
    titlePatterns: ['inbox', 'mail', 'chat', 'message', 'conversation'],
  },
  development: {
    domains: [
      'github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com',
      'developer.mozilla.org', 'npmjs.com', 'pypi.org', 'crates.io',
      'vercel.com', 'netlify.com', 'heroku.com', 'railway.app',
      'render.com', 'fly.io', 'supabase.com', 'firebase.google.com',
      'console.firebase.google.com', 'console.cloud.google.com',
      'aws.amazon.com', 'portal.azure.com', 'codepen.io',
      'codesandbox.io', 'replit.com', 'jsfiddle.net',
      'docs.docker.com', 'kubernetes.io',
    ],
    titlePatterns: [
      'api', 'documentation', 'docs', 'sdk', 'deploy', 'build',
      'error', 'debug', 'pull request', 'merge', 'commit', 'issue',
      'repository', 'console', 'dashboard',
    ],
  },
  learning: {
    domains: [
      'udemy.com', 'coursera.org', 'edx.org', 'khanacademy.org',
      'freecodecamp.org', 'codecademy.com', 'pluralsight.com',
      'skillshare.com', 'linkedin.com/learning', 'w3schools.com',
      'medium.com', 'dev.to', 'towardsdatascience.com',
      'youtube.com', 'youtu.be',
    ],
    titlePatterns: [
      'tutorial', 'course', 'learn', 'guide', 'beginner', 'introduction',
      'how to', 'getting started', 'walkthrough', 'lesson', 'lecture',
    ],
  },
  research: {
    domains: [
      'scholar.google.com', 'arxiv.org', 'researchgate.net',
      'semanticscholar.org', 'sciencedirect.com', 'ieee.org',
      'nature.com', 'wikipedia.org', 'en.wikipedia.org',
    ],
    titlePatterns: [
      'paper', 'research', 'study', 'comparison', 'benchmark', 'vs',
      'versus', 'review', 'survey', 'analysis',
    ],
  },
  ai_tools: {
    domains: [
      'chat.openai.com', 'chatgpt.com', 'gemini.google.com',
      'claude.ai', 'huggingface.co', 'platform.openai.com',
      'colab.research.google.com', 'kaggle.com', 'perplexity.ai',
      'poe.com', 'bard.google.com', 'copilot.microsoft.com',
    ],
    titlePatterns: [
      'chatgpt', 'gemini', 'claude', 'copilot', 'ai chat',
    ],
  },
  productivity: {
    domains: [
      'notion.so', 'trello.com', 'asana.com', 'jira.atlassian.com',
      'linear.app', 'monday.com', 'clickup.com', 'todoist.com',
      'docs.google.com', 'sheets.google.com', 'slides.google.com',
      'drive.google.com', 'airtable.com', 'miro.com', 'figma.com',
      'canva.com',
    ],
    titlePatterns: [
      'project', 'task', 'board', 'sprint', 'roadmap', 'plan',
      'design', 'wireframe', 'document',
    ],
  },
  entertainment: {
    domains: [
      'netflix.com', 'youtube.com', 'twitch.tv', 'spotify.com',
      'reddit.com', 'twitter.com', 'x.com', 'instagram.com',
      'tiktok.com', 'facebook.com', 'pinterest.com', 'tumblr.com',
    ],
    titlePatterns: [
      'watch', 'stream', 'play', 'listen', 'episode', 'movie',
      'music', 'game', 'meme',
    ],
  },
  shopping: {
    domains: [
      'amazon.com', 'amazon.in', 'flipkart.com', 'ebay.com',
      'walmart.com', 'aliexpress.com', 'myntra.com', 'etsy.com',
      'bestbuy.com',
    ],
    titlePatterns: [
      'buy', 'cart', 'order', 'price', 'deal', 'product', 'shop',
      'store', 'review',
    ],
  },
  administration: {
    domains: [
      'namecheap.com', 'godaddy.com', 'cloudflare.com', 'domains.google.com',
      'account.google.com', 'myaccount.google.com', 'billing',
      'dashboard.stripe.com', 'paypal.com',
    ],
    titlePatterns: [
      'settings', 'account', 'billing', 'domain', 'dns', 'ssl',
      'config', 'admin', 'password', 'profile',
    ],
  },
};

/**
 * Classifies a domain into a category.
 * @param {string} domain
 * @returns {string|null} Category name or null.
 */
function classifyDomain(domain) {
  if (!domain) return null;
  const lower = domain.toLowerCase();
  for (const [category, signals] of Object.entries(CATEGORY_SIGNALS)) {
    if (signals.domains.some((d) => lower === d || lower.endsWith('.' + d))) {
      return category;
    }
  }
  return null;
}

/**
 * Detects workspace categories based on domain and title pattern matching.
 * Returns categories sorted by signal strength (most matches first).
 * @param {string[]} domains
 * @param {string[]} titles
 * @returns {{ categories: Array<{ name: string, count: number }>, signals: string[] }}
 */
function detectCategories(domains, titles) {
  const categoryCounts = {};
  const detectedSignals = [];

  // Match domains
  for (const domain of domains) {
    const category = classifyDomain(domain);
    if (category) {
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      detectedSignals.push(domain);
    }
  }

  // Match title patterns
  const allTitles = titles.join(' ').toLowerCase();
  for (const [category, signals] of Object.entries(CATEGORY_SIGNALS)) {
    for (const pattern of signals.titlePatterns) {
      if (allTitles.includes(pattern)) {
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
        // Don't add to detectedSignals — these are implicit
      }
    }
  }

  // Sort by count descending
  const categories = Object.entries(categoryCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return { categories, signals: detectedSignals.slice(0, 10) };
}

/**
 * Formats a category name for display in the prompt.
 * @param {string} name
 * @returns {string}
 */
function formatCategoryName(name) {
  return name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// ── Prompt Building ─────────────────────────────────────

/**
 * Prepares deduplicated tab titles and domains from a workspace.
 * Caps output to prevent token bloat for large workspaces.
 * @param {object} workspace - Workspace object with tabs array.
 * @returns {{ titles: string[], domains: string[] }}
 */
function preparePromptData(workspace) {
  const tabs = workspace.tabs || [];

  const titleSet = new Set();
  const domainSet = new Set();

  for (const tab of tabs) {
    // Collect titles (skip empty/untitled)
    const title = (tab.title || '').trim();
    if (title && title.toLowerCase() !== 'untitled') {
      titleSet.add(title);
    }

    // Collect domains (skip tracking/internal)
    if (!isTrackingOrInternalUrl(tab.url)) {
      const domain = extractDomain(tab.url);
      if (domain) {
        domainSet.add(domain);
      }
    }
  }

  // Cap to prevent token bloat
  const MAX_TITLES = 100;
  const MAX_DOMAINS = 50;

  const titles = Array.from(titleSet).slice(0, MAX_TITLES);
  const domains = Array.from(domainSet).slice(0, MAX_DOMAINS);

  return { titles, domains };
}

/**
 * Builds the system and user prompts for summary generation.
 * Uses detected categories as context hints for the LLM.
 * @param {object} workspace - Workspace with name, notes, and tabs.
 * @returns {{ system: string, user: string }}
 */
function buildSummaryPrompt(workspace) {
  const { titles, domains } = preparePromptData(workspace);
  const { categories, signals } = detectCategories(domains, titles);

  const system = `/no_think
You are a workspace activity analyst. Determine the user's actual activity or project — do NOT list websites or tools.

Rules:
- Identify the ACTIVITY: researching, building, learning, deploying, communicating, managing, troubleshooting, comparing, shopping, planning.
- Identify the PROJECT or GOAL from the workspace name and tabs.
- Mention tools only when they clarify the project (e.g. "deploying with Firebase").
- NEVER just list tools. "Workspace containing GitHub, ChatGPT, and Firebase" is WRONG.
- AI tools (ChatGPT, Gemini, Claude) are usually assistants, not the topic. Communication tools (Gmail, WhatsApp, Slack) are for coordination, not the topic.
- NEVER start with "This workspace focuses on..." or "This workspace contains..." or "This workspace is about...".
- Write 1-2 sentences, 20-50 words max. Return ONLY valid JSON. No markdown.`;

  const notesLine = workspace.notes
    ? `
Notes: ${workspace.notes}`
    : '';

  const titlesBlock = titles.length > 0
    ? `

Tab Titles:
${titles.map((t) => `- ${t}`).join('\n')}`
    : '';

  const domainsBlock = domains.length > 0
    ? `

Domains:
${domains.map((d) => `- ${d}`).join('\n')}`
    : '';

  // Build category hint block — keep it short for small models
  let hintBlock = '';
  if (categories.length > 0) {
    const topCategories = categories.slice(0, 3).map((c) => formatCategoryName(c.name));
    const signalList = signals.length > 0
      ? `
Signals: ${signals.join(', ')}`
      : '';
    hintBlock = `

Detected activity type: ${topCategories.join(', ')}${signalList}
Use these to infer the activity, not as the summary itself.`;
  }

  const user = `Determine what the user is doing in this workspace.

Workspace Name: ${workspace.name || 'Untitled'}${notesLine}${titlesBlock}${domainsBlock}${hintBlock}

Describe the user's activity, project, or objective — not the tools.

Return JSON: {"summary": "Your summary here."}`;

  return { system, user };
}

// ── Response Parsing ────────────────────────────────────

/**
 * Parses the raw LLM response into a summary string.
 * Aggressively handles common small-model artifacts:
 * thinking tags, code fences, extra prose, XML tags.
 * @param {string} raw - Raw model output text.
 * @returns {string} The extracted summary string.
 * @throws {Error} If parsing fails completely.
 */
function parseSummaryResponse(raw) {
  let cleaned = raw.trim();

  // Strip <think>...</think> blocks
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // Strip markdown code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/m, '');

  // Strip any remaining XML/HTML-like tags
  cleaned = cleaned.replace(/<[^>]+>/g, '');

  cleaned = cleaned.trim();

  // Try direct JSON parse
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract JSON from surrounding prose
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const extracted = cleaned.slice(firstBrace, lastBrace + 1);
      try {
        parsed = JSON.parse(extracted);
      } catch {
        throw new Error('Could not extract valid JSON from model response.');
      }
    } else {
      throw new Error('No JSON object found in model response.');
    }
  }

  // Validate the summary field
  if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    throw new Error('Response JSON missing or empty "summary" field.');
  }

  return parsed.summary.trim();
}

// ── Summary Cleanup ─────────────────────────────────────

/**
 * Cleans and enforces length limits on a summary.
 * - Trims whitespace
 * - Removes duplicate sentences
 * - Enforces 80-word maximum
 * @param {string} text - Raw summary text.
 * @returns {string} Cleaned summary.
 */
function cleanSummary(text) {
  let summary = text.trim();

  // Strip lazy/repetitive openings
  const lazyPrefixes = [
    /^this workspace (focuses on|contains|is about|is for|is used for|covers|involves|deals with|relates to|centers on|revolves around)\s*/i,
    /^the workspace (focuses on|contains|is about|is for|is used for|covers|involves)\s*/i,
    /^a workspace (for|about|containing|focused on|dedicated to)\s*/i,
    /^workspace (for|about|containing)\s*/i,
  ];

  for (const pattern of lazyPrefixes) {
    if (pattern.test(summary)) {
      summary = summary.replace(pattern, '');
      // Capitalize first letter after stripping
      summary = summary.charAt(0).toUpperCase() + summary.slice(1);
      break;
    }
  }

  // Remove duplicate sentences
  const sentences = summary
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const seen = new Set();
  const unique = [];
  for (const sentence of sentences) {
    const normalized = sentence.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(sentence);
    }
  }

  summary = unique.join(' ');

  // Enforce 80-word maximum
  const words = summary.split(/\s+/);
  if (words.length > 80) {
    summary = words.slice(0, 80).join(' ');
    // Try to end at a sentence boundary
    const lastPeriod = summary.lastIndexOf('.');
    if (lastPeriod > summary.length * 0.5) {
      summary = summary.slice(0, lastPeriod + 1);
    } else {
      summary += '…';
    }
  }

  return summary;
}

// ── Main Public API ─────────────────────────────────────

/**
 * Generates a workspace summary using Ollama.
 *
 * @param {object} workspace - The workspace object (name, notes, tabs).
 * @param {string} endpoint - Ollama API base URL.
 * @param {string} model - Model name.
 * @returns {Promise<{ success: boolean, summary?: string, error?: string }>}
 */
export async function generateWorkspaceSummary(workspace, endpoint, model) {
  // Guard: need at least a name or some tabs
  if (!workspace || (!workspace.name && (!workspace.tabs || workspace.tabs.length === 0))) {
    return { success: false, error: 'Workspace has no name or tabs to summarize.' };
  }

  try {
    const { system, user } = buildSummaryPrompt(workspace);

    // Call Ollama via proxy
    const res = await proxyFetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        think: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        options: {
          temperature: 0.3,
          num_predict: 512,
        },
      }),
    });

    if (!res.ok) {
      return {
        success: false,
        error: `Ollama responded with status ${res.status}.`,
      };
    }

    let data;
    try {
      data = JSON.parse(res.text);
    } catch {
      return { success: false, error: 'Invalid JSON response from Ollama.' };
    }

    const content = data.message?.content || '';
    if (!content.trim()) {
      return { success: false, error: 'Empty response from Ollama.' };
    }

    // Parse and clean the summary
    const rawSummary = parseSummaryResponse(content);
    const summary = cleanSummary(rawSummary);

    return { success: true, summary };
  } catch (err) {
    // Map common network errors to user-friendly messages
    const msg = err.message || '';

    if (
      msg.includes('Failed to fetch') ||
      msg.includes('NetworkError') ||
      msg.includes('Fetch failed')
    ) {
      return { success: false, error: 'Could not connect to Ollama. Is it running?' };
    }

    return { success: false, error: msg || 'Summary generation failed.' };
  }
}
