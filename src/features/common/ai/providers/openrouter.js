// Use Node 20+ global fetch (undici) — returns WHATWG Response with response.body.getReader().
// node-fetch v2 returns Node streams without getReader(), which breaks askService stream consumer.

class OpenRouterProvider {
    static async validateApiKey(key) {
        if (!key || typeof key !== 'string' || !key.startsWith('sk-or-')) {
            return { success: false, error: 'Invalid OpenRouter API key format. Expected sk-or-...' };
        }
        try {
            const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
                headers: { 'Authorization': `Bearer ${key}` }
            });
            if (response.ok) return { success: true };
            const errorData = await response.json().catch(() => ({}));
            const message = errorData.error?.message || `Validation failed with status: ${response.status}`;
            return { success: false, error: message };
        } catch (error) {
            console.error('[OpenRouterProvider] Network error during key validation:', error);
            return { success: false, error: 'A network error occurred during validation.' };
        }
    }
}

const OR_BASE = 'https://openrouter.ai/api/v1';
const OR_HEADERS = (apiKey) => ({
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://pickle.com/glass',
    'X-Title': 'Pickle Glass',
});

function createLLM({ apiKey, model = 'openai/gpt-4o-mini', temperature = 0.7, maxTokens = 2048, ...config }) {
    const callApi = async (messages) => {
        const response = await fetch(`${OR_BASE}/chat/completions`, {
            method: 'POST',
            headers: OR_HEADERS(apiKey),
            body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`OpenRouter API error ${response.status}: ${text}`);
        }
        const result = await response.json();
        return { content: result.choices[0].message.content.trim(), raw: result };
    };

    return {
        generateContent: async (parts) => {
            const messages = [];
            let systemPrompt = '';
            const userContent = [];

            for (const part of parts) {
                if (typeof part === 'string') {
                    if (systemPrompt === '' && part.includes('You are')) {
                        systemPrompt = part;
                    } else {
                        userContent.push({ type: 'text', text: part });
                    }
                } else if (part.inlineData) {
                    userContent.push({
                        type: 'image_url',
                        image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` },
                    });
                }
            }

            if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
            if (userContent.length > 0) messages.push({ role: 'user', content: userContent });

            const result = await callApi(messages);
            return {
                response: { text: () => result.content },
                raw: result.raw,
            };
        },

        chat: async (messages) => await callApi(messages),
    };
}

function createStreamingLLM({ apiKey, model = 'openai/gpt-4o-mini', temperature = 0.7, maxTokens = 2048, ...config }) {
    return {
        streamChat: async (messages) => {
            const response = await fetch(`${OR_BASE}/chat/completions`, {
                method: 'POST',
                headers: OR_HEADERS(apiKey),
                body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true }),
            });
            if (!response.ok) {
                throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
            }
            return response;
        },
    };
}

function createSTT() {
    throw new Error('OpenRouter does not support speech-to-text. Use Deepgram or Whisper for STT.');
}

module.exports = {
    OpenRouterProvider,
    createLLM,
    createStreamingLLM,
    createSTT,
};
