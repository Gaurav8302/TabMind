/**
 * TabMind Background Service Worker
 * Coordinates lifecycle events, system notifications,
 * and proxies fetch requests for the popup (CORS bypass).
 */

// ── Origin Header Bypass ────────────────────────────────
// Ollama checks the Origin header server-side and returns 403
// for unknown origins like chrome-extension://. We use
// declarativeNetRequest to strip Origin from all localhost
// requests so Ollama accepts them.

async function setupOriginBypass() {
  try {
    // Clear any existing session rules first
    const existingRules = await chrome.declarativeNetRequest.getSessionRules();
    const removeRuleIds = existingRules.map((r) => r.id);

    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds,
      addRules: [
        {
          id: 1,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Origin', operation: 'remove' },
              { header: 'Referer', operation: 'remove' },
            ],
          },
          condition: {
            regexFilter: '^http://(localhost|127\\.0\\.0\\.1)(:\\d+)?/',
            resourceTypes: ['xmlhttprequest', 'other'],
          },
        },
      ],
    });
    console.log('TabMind: Origin bypass rules registered.');
  } catch (err) {
    console.error('TabMind: Failed to register origin bypass rules:', err);
  }
}

// ── Lifecycle Events ────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  console.log('TabMind extension installed. Reason:', details.reason);
  setupOriginBypass();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('TabMind service worker activated on browser startup.');
  setupOriginBypass();
});

// Also run on service worker activation (covers wake-ups)
setupOriginBypass();

// ── Fetch Proxy ─────────────────────────────────────────
// The popup page cannot bypass CORS even with host_permissions.
// Only the service worker gets CORS bypass in Manifest V3.
// This listener proxies fetch requests from the popup through
// the service worker so Ollama API calls succeed.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'PROXY_FETCH') return false;

  const { url, options } = message;

  fetch(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body || null,
  })
    .then(async (res) => {
      const text = await res.text();
      sendResponse({
        ok: res.ok,
        status: res.status,
        text,
      });
    })
    .catch((err) => {
      sendResponse({
        ok: false,
        status: 0,
        error: err.message || 'Fetch failed',
      });
    });

  // Return true to indicate we will call sendResponse asynchronously
  return true;
});
