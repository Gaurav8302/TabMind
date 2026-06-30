/**
 * TabMind Summary Service
 * Generates AI-powered workspace summaries.
 * Delegates to AIProviderService for the actual generation.
 * Exports domain classification utilities used by PreferenceService.
 *
 * Public API:
 *   generateWorkspaceSummary(workspace) → { success, summary } | { success, error }
 *   classifyDomain(domain) → string|null
 *   CATEGORY_SIGNALS - Category signal definitions
 *   detectCategories(domains, titles) → { categories, signals }
 */

import { AIProviderService } from './aiProviderService.js';

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

  for (const domain of domains) {
    const category = classifyDomain(domain);
    if (category) {
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      detectedSignals.push(domain);
    }
  }

  const allTitles = titles.join(' ').toLowerCase();
  for (const [category, signals] of Object.entries(CATEGORY_SIGNALS)) {
    for (const pattern of signals.titlePatterns) {
      if (allTitles.includes(pattern)) {
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      }
    }
  }

  const categories = Object.entries(categoryCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return { categories, signals: detectedSignals.slice(0, 10) };
}

export { classifyDomain, CATEGORY_SIGNALS, detectCategories };

// ── Main Public API ─────────────────────────────────────

/**
 * Generates a workspace summary using the configured AI provider.
 * Delegates to AIProviderService.
 *
 * @param {object} workspace - The workspace object (name, notes, tabs).
 * @param {string} [_endpoint] - Ignored (kept for backward compatibility).
 * @param {string} [_model] - Ignored (kept for backward compatibility).
 * @returns {Promise<{ success: boolean, summary?: string, error?: string }>}
 */
export async function generateWorkspaceSummary(workspace, _endpoint, _model) {
  return AIProviderService.generateSummary(workspace);
}
