export function createGeminiProvider() {
  return {
    name: 'Gemini',
    costInfo: 'Free tier available',

    async testConnection(providerSettings) {
      const apiKey = providerSettings.geminiApiKey;
      const model = providerSettings.geminiModel || 'gemini-2.5-flash';

      if (!apiKey) {
        return { ok: false, error: 'Gemini: API key is required.' };
      }

      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const res = await proxyFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Respond with: {"ok":true}' }] }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 50,
            },
          }),
        });

        if (!res.ok) {
          let msg = `Gemini responded with status ${res.status}.`;
          try {
            const errData = JSON.parse(res.text);
            if (errData.error?.message) {
              msg = `Gemini: ${errData.error.message}`;
            }
          } catch {}
          return { ok: false, error: msg };
        }

        return { ok: true };
      } catch (err) {
        const msg = normalizeFetchError(err, 'Gemini');
        return { ok: false, error: msg };
      }
    },

    async chat(providerSettings, systemPrompt, userPrompt, options = {}) {
      const apiKey = providerSettings.geminiApiKey;
      const model = providerSettings.geminiModel || 'gemini-2.5-flash';

      if (!apiKey) {
        throw new Error('Gemini: API key is not configured.');
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const body = {
        contents: [
          {
            role: 'user',
            parts: [{ text: systemPrompt + '\n\n' + userPrompt }],
          },
        ],
        generationConfig: {
          temperature: options.temperature ?? 0.3,
          maxOutputTokens: options.maxTokens ?? 4096,
        },
      };

      const res = await proxyFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        let msg = `Gemini error ${res.status}.`;
        try {
          const errData = JSON.parse(res.text);
          if (errData.error?.message) {
            msg = `Gemini: ${errData.error.message}`;
          }
        } catch {}
        throw new Error(msg);
      }

      let data;
      try {
        data = JSON.parse(res.text);
      } catch {
        throw new Error('Invalid JSON response from Gemini.');
      }

      const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

      if (!content.trim()) {
        throw new Error('Empty response from Gemini.');
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
