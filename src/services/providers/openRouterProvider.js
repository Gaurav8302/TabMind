export function createOpenRouterProvider() {
  return {
    name: 'OpenRouter',
    costInfo: 'May incur usage costs',

    async testConnection(providerSettings) {
      const apiKey = providerSettings.openRouterApiKey;
      const model = providerSettings.openRouterModel || 'google/gemini-2.5-flash';

      if (!apiKey) {
        return { ok: false, error: 'OpenRouter: API key is required.' };
      }

      try {
        const url = 'https://openrouter.ai/api/v1/chat/completions';
        const res = await proxyFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'Respond with: {"ok":true}' }],
            temperature: 0.1,
            max_tokens: 50,
          }),
        });

        if (!res.ok) {
          let msg = `OpenRouter responded with status ${res.status}.`;
          try {
            const errData = JSON.parse(res.text);
            if (errData.error?.message) {
              msg = `OpenRouter: ${errData.error.message}`;
            }
          } catch {}
          return { ok: false, error: msg };
        }

        return { ok: true };
      } catch (err) {
        const msg = normalizeFetchError(err, 'OpenRouter');
        return { ok: false, error: msg };
      }
    },

    async chat(providerSettings, systemPrompt, userPrompt, options = {}) {
      const apiKey = providerSettings.openRouterApiKey;
      const model = providerSettings.openRouterModel || 'google/gemini-2.5-flash';

      if (!apiKey) {
        throw new Error('OpenRouter: API key is not configured.');
      }

      const url = 'https://openrouter.ai/api/v1/chat/completions';

      const body = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens ?? 4096,
      };

      const res = await proxyFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        let msg = `OpenRouter error ${res.status}.`;
        try {
          const errData = JSON.parse(res.text);
          if (errData.error?.message) {
            msg = `OpenRouter: ${errData.error.message}`;
          }
        } catch {}
        throw new Error(msg);
      }

      let data;
      try {
        data = JSON.parse(res.text);
      } catch {
        throw new Error('Invalid JSON response from OpenRouter.');
      }

      const content = data.choices?.[0]?.message?.content || '';

      if (!content.trim()) {
        throw new Error('Empty response from OpenRouter.');
      }

      return content;
    },
  };
}

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

function normalizeFetchError(err, providerName) {
  const msg = err.message || '';
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Fetch failed')) {
    return `${providerName}: Network error. Check your internet connection.`;
  }
  return `${providerName}: ${msg}`;
}
