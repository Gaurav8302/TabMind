export function buildPrompt(tabSummaries, hints = '') {
  const count = tabSummaries.length;
  const minGroups = Math.max(2, Math.ceil(count / 10));
  const maxGroups = Math.min(8, Math.max(3, Math.ceil(count / 3)));

  const hintsBlock = hints
    ? `\n\nUser Preference Hints:\n${hints}\n\nUse these preferences as guidance. The user may have renamed workspaces — prefer the user's preferred names when they match.`
    : '';

  const system = `/no_think
You are a browser tab organizer. Group tabs into distinct workspaces by topic.

Rules:
- Create ${minGroups} to ${maxGroups} groups. NEVER put all tabs in one group.
- Tabs about DIFFERENT topics MUST go in DIFFERENT groups.
- Every tab must belong to exactly one group. No duplicates.
- Give each group a short, descriptive name based on its tabs (e.g. "Web Development", "Job Applications", "Cloud Infrastructure").
- Do NOT use vague names like "General", "Miscellaneous", or "Other".
- Tab indices must be integers (0, 1, 2...), not strings.
- Return ONLY valid JSON. No markdown, no explanation.${hintsBlock}`;

  const tabList = tabSummaries
    .map((t, i) => `[${i}] ${t.title} (${t.domain})`)
    .join('\n');

  const user = `Organize these ${count} browser tabs into ${minGroups}-${maxGroups} workspaces by topic.

Tabs:
${tabList}

Return JSON: {"groups":[{"name":"Topic Name","tabs":[0,1,2]}]}

IMPORTANT: You MUST create at least ${minGroups} groups. Every index from 0 to ${count - 1} must appear exactly once. Return ONLY the JSON.`;

  return { system, user };
}

export function buildRetryPrompt(tabSummaries, previousError) {
  const count = tabSummaries.length;
  const minGroups = Math.max(2, Math.ceil(count / 10));
  const maxGroups = Math.min(8, Math.max(3, Math.ceil(count / 3)));
  const { system } = buildPrompt(tabSummaries);

  const tabList = tabSummaries
    .map((t, i) => `[${i}] ${t.title} (${t.domain})`)
    .join('\n');

  const user = `Your previous response was invalid: ${previousError}

Try again. Organize these ${count} tabs into ${minGroups}-${maxGroups} groups.

Tabs:
${tabList}

CRITICAL: You MUST create at least ${minGroups} groups. NEVER put all tabs in one group.
Return ONLY a raw JSON object. No markdown. No code fences.
Format: {"groups":[{"name":"Name","tabs":[0,1,2]}]}
Every index from 0 to ${count - 1} must appear exactly once.`;

  return { system, user };
}

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

export function validateOrganization(data, totalTabs) {
  if (!data || !Array.isArray(data.groups)) {
    return { valid: false, error: 'Response missing "groups" array.' };
  }

  const minGroups = Math.max(2, Math.ceil(totalTabs / 10));
  if (data.groups.length < minGroups || data.groups.length > 8) {
    return {
      valid: false,
      error: `Expected ${minGroups}-8 groups for ${totalTabs} tabs, got ${data.groups.length}. You MUST create at least ${minGroups} distinct groups.`,
    };
  }

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

    group.tabs = group.tabs.filter((idx) => {
      if (typeof idx !== 'number' || idx < 0 || idx >= totalTabs) return false;
      if (seen.has(idx)) return false;
      seen.add(idx);
      return true;
    });
  }

  data.groups = data.groups.filter((g) => g.tabs.length > 0);

  if (data.groups.length === 0) {
    return { valid: false, error: 'All groups were empty after cleanup.' };
  }

  const missing = [];
  for (let i = 0; i < totalTabs; i++) {
    if (!seen.has(i)) missing.push(i);
  }

  if (missing.length > 0) {
    const threshold = Math.max(3, Math.ceil(totalTabs * 0.2));
    if (missing.length > threshold) {
      return {
        valid: false,
        error: `${missing.length} tab(s) unassigned — too many to auto-fix.`,
      };
    }

    const lastGroup = data.groups[data.groups.length - 1];
    lastGroup.tabs.push(...missing);
  }

  return { valid: true };
}

export function parseResponse(raw) {
  let cleaned = raw.trim();

  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
  cleaned = cleaned.replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/m, '');
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  cleaned = cleaned.trim();

  try {
    return JSON.parse(cleaned);
  } catch {
  }

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const extracted = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(extracted);
    } catch {
    }
  }

  throw new Error('Could not extract valid JSON from model response.');
}

export function normalizeResponse(data) {
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

export function buildSummaryPrompt(workspace) {
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
    ? `\nNotes: ${workspace.notes}`
    : '';

  const titlesBlock = titles.length > 0
    ? `\n\nTab Titles:\n${titles.map((t) => `- ${t}`).join('\n')}`
    : '';

  const domainsBlock = domains.length > 0
    ? `\n\nDomains:\n${domains.map((d) => `- ${d}`).join('\n')}`
    : '';

  let hintBlock = '';
  if (categories.length > 0) {
    const topCategories = categories.slice(0, 3).map((c) => formatCategoryName(c.name));
    const signalList = signals.length > 0
      ? `\nSignals: ${signals.join(', ')}`
      : '';
    hintBlock = `\n\nDetected activity type: ${topCategories.join(', ')}${signalList}\nUse these to infer the activity, not as the summary itself.`;
  }

  const user = `Determine what the user is doing in this workspace.

Workspace Name: ${workspace.name || 'Untitled'}${notesLine}${titlesBlock}${domainsBlock}${hintBlock}

Describe the user's activity, project, or objective — not the tools.

Return JSON: {"summary": "Your summary here."}`;

  return { system, user };
}

function preparePromptData(workspace) {
  const tabs = workspace.tabs || [];

  const titleSet = new Set();
  const domainSet = new Set();

  for (const tab of tabs) {
    const title = (tab.title || '').trim();
    if (title && title.toLowerCase() !== 'untitled') {
      titleSet.add(title);
    }

    if (!isTrackingOrInternalUrl(tab.url)) {
      const domain = extractDomain(tab.url);
      if (domain) {
        domainSet.add(domain);
      }
    }
  }

  const MAX_TITLES = 100;
  const MAX_DOMAINS = 50;

  const titles = Array.from(titleSet).slice(0, MAX_TITLES);
  const domains = Array.from(domainSet).slice(0, MAX_DOMAINS);

  return { titles, domains };
}

function extractDomain(url) {
  if (!url) return '';
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

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

function formatCategoryName(name) {
  return name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function parseSummaryResponse(raw) {
  let cleaned = raw.trim();

  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
  cleaned = cleaned.replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/m, '');
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  cleaned = cleaned.trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
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

  if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    throw new Error('Response JSON missing or empty "summary" field.');
  }

  return parsed.summary.trim();
}

export function cleanSummary(text) {
  let summary = text.trim();

  const lazyPrefixes = [
    /^this workspace (focuses on|contains|is about|is for|is used for|covers|involves|deals with|relates to|centers on|revolves around)\s*/i,
    /^the workspace (focuses on|contains|is about|is for|is used for|covers|involves)\s*/i,
    /^a workspace (for|about|containing|focused on|dedicated to)\s*/i,
    /^workspace (for|about|containing)\s*/i,
  ];

  for (const pattern of lazyPrefixes) {
    if (pattern.test(summary)) {
      summary = summary.replace(pattern, '');
      summary = summary.charAt(0).toUpperCase() + summary.slice(1);
      break;
    }
  }

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

  const words = summary.split(/\s+/);
  if (words.length > 80) {
    summary = words.slice(0, 80).join(' ');
    const lastPeriod = summary.lastIndexOf('.');
    if (lastPeriod > summary.length * 0.5) {
      summary = summary.slice(0, lastPeriod + 1);
    } else {
      summary += '\u2026';
    }
  }

  return summary;
}

export { classifyDomain, CATEGORY_SIGNALS, detectCategories };
