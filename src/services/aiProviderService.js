import { CONFIG } from '../config.js';
import { StorageService } from './storage-service.js';
import { createOllamaProvider } from './providers/ollamaProvider.js';
import { createGeminiProvider } from './providers/geminiProvider.js';
import { createOpenRouterProvider } from './providers/openRouterProvider.js';
import { createGroqProvider } from './providers/groqProvider.js';
import {
  buildPrompt,
  buildRetryPrompt,
  extractTabSummaries,
  validateOrganization,
  parseResponse,
  normalizeResponse,
  buildSummaryPrompt,
  parseSummaryResponse,
  cleanSummary,
} from './providers/prompts.js';

const PROVIDER_MAP = {
  ollama: createOllamaProvider,
  gemini: createGeminiProvider,
  openrouter: createOpenRouterProvider,
  groq: createGroqProvider,
};

function getProviderInstance(providerName) {
  const factory = PROVIDER_MAP[providerName];
  if (!factory) {
    throw new Error(`Unknown AI provider: "${providerName}".`);
  }
  return factory();
}

function extractProviderSettings(settings, providerName) {
  switch (providerName) {
    case 'ollama':
      return {
        ollamaEndpoint: settings.ollamaEndpoint || CONFIG.AI.DEFAULT_ENDPOINT,
        ollamaModel: settings.ollamaModel || CONFIG.AI.DEFAULT_MODEL,
      };
    case 'gemini':
      return {
        geminiApiKey: settings.geminiApiKey || '',
        geminiModel: settings.geminiModel || 'gemini-2.5-flash',
      };
    case 'openrouter':
      return {
        openRouterApiKey: settings.openRouterApiKey || '',
        openRouterModel: settings.openRouterModel || 'google/gemini-2.5-flash',
      };
    case 'groq':
      return {
        groqApiKey: settings.groqApiKey || '',
        groqModel: settings.groqModel || 'llama-3.3-70b-versatile',
      };
    default:
      throw new Error(`Unknown AI provider: "${providerName}".`);
  }
}

export const AIProviderService = {
  getProviderName() {
    return CONFIG.AI.DEFAULT_PROVIDER;
  },

  async testConnection(settings) {
    const providerName = settings.aiProvider || CONFIG.AI.DEFAULT_PROVIDER;
    const provider = getProviderInstance(providerName);
    const providerSettings = extractProviderSettings(settings, providerName);

    try {
      const result = await provider.testConnection(providerSettings);

      if (result.ok) {
        return { ok: true, provider: providerName };
      }

      return {
        ok: false,
        provider: providerName,
        error: result.error || `${provider.name} connection failed.`,
      };
    } catch (err) {
      return {
        ok: false,
        provider: providerName,
        error: err.message || `${provider.name} connection failed.`,
      };
    }
  },

  async organizeTabs(tabs, hints = '') {
    const settings = await StorageService.getAiSettings();
    const providerName = settings.aiProvider || CONFIG.AI.DEFAULT_PROVIDER;
    const provider = getProviderInstance(providerName);
    const providerSettings = extractProviderSettings(settings, providerName);

    const summaries = extractTabSummaries(tabs);
    const { system, user } = buildPrompt(summaries, hints);

    let raw;
    try {
      raw = await provider.chat(providerSettings, system, user, {
        temperature: 0.3,
        maxTokens: 4096,
      });
    } catch (err) {
      throw new Error(`${provider.name}: ${err.message}`);
    }

    let parsed;
    try {
      parsed = normalizeResponse(parseResponse(raw));
    } catch {
      return retryOrganize(provider, providerSettings, summaries, 'Response was not valid JSON.');
    }

    const validation = validateOrganization(parsed, tabs.length);
    if (!validation.valid) {
      return retryOrganize(provider, providerSettings, summaries, validation.error);
    }

    return parsed;
  },

  async generateSummary(workspace) {
    if (!workspace || (!workspace.name && (!workspace.tabs || workspace.tabs.length === 0))) {
      return { success: false, error: 'Workspace has no name or tabs to summarize.' };
    }

    const settings = await StorageService.getAiSettings();
    const providerName = settings.aiProvider || CONFIG.AI.DEFAULT_PROVIDER;
    const provider = getProviderInstance(providerName);
    const providerSettings = extractProviderSettings(settings, providerName);

    try {
      const { system, user } = buildSummaryPrompt(workspace);

      const raw = await provider.chat(providerSettings, system, user, {
        temperature: 0.3,
        maxTokens: 512,
      });

      const rawSummary = parseSummaryResponse(raw);
      const summary = cleanSummary(rawSummary);

      return { success: true, summary };
    } catch (err) {
      const msg = err.message || '';
      return { success: false, error: msg || 'Summary generation failed.' };
    }
  },
};

async function retryOrganize(provider, providerSettings, summaries, previousError) {
  console.warn(`TabMind: First AI attempt failed (${previousError}). Retrying...`);

  const { system, user } = buildRetryPrompt(summaries, previousError);

  const raw = await provider.chat(providerSettings, system, user, {
    temperature: 0.3,
    maxTokens: 4096,
  });

  let parsed;
  try {
    parsed = normalizeResponse(parseResponse(raw));
  } catch {
    throw new Error(`${provider.name}: AI returned invalid JSON on both attempts.`);
  }

  const validation = validateOrganization(parsed, summaries.length);
  if (!validation.valid) {
    throw new Error(`${provider.name}: AI validation failed on retry: ${validation.error}`);
  }

  return parsed;
}
