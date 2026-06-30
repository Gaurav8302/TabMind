export function createOllamaProvider() {
  return {
    name: 'Ollama',
    costInfo: 'Runs locally',

    async testConnection(providerSettings) {
      const endpoint = providerSettings.ollamaEndpoint;
      const model = providerSettings.ollamaModel;

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
    },

    async chat(providerSettings, systemPrompt, userPrompt, options = {}) {
      const endpoint = providerSettings.ollamaEndpoint;
      const model = providerSettings.ollamaModel;

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
            temperature: options.temperature ?? 0.3,
            num_predict: options.maxTokens ?? 4096,
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

      const content = data.message?.content || '';

      if (!content.trim()) {
        throw new Error('Empty response from Ollama. The model may need more tokens or a simpler prompt.');
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
