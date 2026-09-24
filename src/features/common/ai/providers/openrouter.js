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

// ── Speech-to-text ───────────────────────────────────────────────────────────
// OpenRouter has no streaming STT endpoint: audio goes through the ordinary
// /chat/completions call as an `input_audio` content part. So this is a chunked
// recogniser with the same shape as the Whisper provider — it buffers PCM, cuts
// it on a timer and emits one 'transcription' event per chunk, which sttService
// consumes through its chunked-STT path.
const { EventEmitter } = require('events');

const OR_STT_MODEL_DEFAULT = 'google/gemini-2.5-flash';
const PCM_SAMPLE_RATE      = 24000; // what src/ui/listen/audioCore/listenCapture.js emits
const PCM_BYTES_PER_SAMPLE = 2;
// sttService.isWhisperNoiseText() already filters this exact string, so a silent
// or music-only chunk costs nothing downstream.
const OR_STT_NO_SPEECH = '[no speech detected]';

function sttNumberOption(options, key, envName, fallback, min = 0) {
    for (const candidate of [options?.[key], process.env[envName]]) {
        const value = Number(candidate);
        if (Number.isFinite(value) && value >= min) return value;
    }
    return fallback;
}

// Minimal 44-byte RIFF header for mono PCM16. OpenRouter needs a real container —
// raw PCM base64 is rejected.
function pcm16ToWav(pcm, sampleRate = PCM_SAMPLE_RATE) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);                                 // fmt chunk size
    header.writeUInt16LE(1, 20);                                  // format = PCM
    header.writeUInt16LE(1, 22);                                  // channels
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * PCM_BYTES_PER_SAMPLE, 28);  // byte rate
    header.writeUInt16LE(PCM_BYTES_PER_SAMPLE, 32);               // block align
    header.writeUInt16LE(16, 34);                                 // bits per sample
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

const OR_STT_PROMPT = [
    'You are a speech-to-text engine. Transcribe the audio clip verbatim.',
    '',
    'Rules:',
    '- Output ONLY the transcript text. No prefaces, no speaker labels, no timestamps, no quotes, no markdown.',
    '- Transcribe what is actually said, including false starts and filler words. Do not paraphrase, summarize, translate or correct grammar.',
    '- Use normal sentence punctuation and capitalization.',
    '- The clip is a slice of a longer stream and may begin or end mid-word. Transcribe the partial word as best you can and stop. Never invent words to complete a sentence.',
    '- If the clip contains no intelligible speech (silence, music, typing, background noise), output exactly: ' + OR_STT_NO_SPEECH,
].join('\n');

class OpenRouterSTTSession extends EventEmitter {
    constructor(config = {}) {
        super();
        this.apiKey = config.apiKey;
        this.model = config.model || OR_STT_MODEL_DEFAULT;
        this.language = config.language || 'en';
        this.sessionId = `${config.sessionType || 'stt'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        this.chunkSeconds         = sttNumberOption(config, 'chunkSeconds', 'PICKLE_OPENROUTER_STT_CHUNK_SECONDS', 5, 1);
        this.processingIntervalMs = sttNumberOption(config, 'processingIntervalMs', 'PICKLE_OPENROUTER_STT_INTERVAL_MS', 500, 100);
        this.silenceRmsThreshold  = sttNumberOption(config, 'silenceRmsThreshold', 'PICKLE_OPENROUTER_STT_SILENCE_RMS', 80, 0);
        this.requestTimeoutMs     = sttNumberOption(config, 'requestTimeoutMs', 'PICKLE_OPENROUTER_STT_TIMEOUT_MS', 20000, 1000);

        this.audioBuffer = Buffer.alloc(0);
        this.isRunning = false;
        this.isClosing = false;
        this.isProcessingChunk = false;
        this.processingInterval = null;
        this.currentAbortController = null;
        this.previousTail = '';
    }

    initialize() {
        if (!this.apiKey) throw new Error('OpenRouter STT requires an API key.');
        this.isRunning = true;
        this.processingInterval = setInterval(() => {
            const minBytes = Math.round(PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * this.chunkSeconds);
            if (this.audioBuffer.length >= minBytes && !this.isProcessingChunk) {
                this.processAudioChunk().catch(() => {});
            }
        }, this.processingIntervalMs);
        console.log(`[OpenRouterSTT-${this.sessionId}] Session started (model=${this.model}, chunk=${this.chunkSeconds}s)`);
        return true;
    }

    calculatePcmRms(audioData) {
        if (!audioData || audioData.length < 2) return 0;
        let sumSquares = 0;
        let samples = 0;
        for (let offset = 0; offset + 1 < audioData.length; offset += 2) {
            const sample = audioData.readInt16LE(offset);
            sumSquares += sample * sample;
            samples++;
        }
        return samples > 0 ? Math.sqrt(sumSquares / samples) : 0;
    }

    async transcribeChunk(audioData) {
        const wavBase64 = pcm16ToWav(audioData).toString('base64');
        const userContent = [];
        // A chat model — unlike whisper-cli — can be told what came just before, so
        // a word cut in half by the previous chunk boundary can be resolved.
        if (this.previousTail) {
            userContent.push({
                type: 'text',
                text: `The previous part of this stream ended with: "...${this.previousTail}". Continue from there; do not repeat it in your output.`,
            });
        }
        userContent.push({ type: 'input_audio', input_audio: { data: wavBase64, format: 'wav' } });

        this.currentAbortController = new AbortController();
        const timeout = setTimeout(() => this.currentAbortController?.abort('timeout'), this.requestTimeoutMs);
        try {
            const response = await fetch(`${OR_BASE}/chat/completions`, {
                method: 'POST',
                headers: OR_HEADERS(this.apiKey),
                signal: this.currentAbortController.signal,
                body: JSON.stringify({
                    model: this.model,
                    messages: [
                        { role: 'system', content: OR_STT_PROMPT },
                        { role: 'user', content: userContent },
                    ],
                    temperature: 0,
                    max_tokens: 512,
                }),
            });
            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(`OpenRouter STT error ${response.status}: ${body.slice(0, 300)}`);
            }
            const result = await response.json();
            return String(result.choices?.[0]?.message?.content || '').trim();
        } finally {
            clearTimeout(timeout);
            this.currentAbortController = null;
        }
    }

    async processAudioChunk() {
        if (!this.isRunning || this.isProcessingChunk || this.audioBuffer.length === 0) return;

        const audioData = this.audioBuffer;
        this.audioBuffer = Buffer.alloc(0);
        this.isProcessingChunk = true;

        try {
            const rms = this.calculatePcmRms(audioData);
            if (this.silenceRmsThreshold > 0 && rms < this.silenceRmsThreshold) return;

            const text = await this.transcribeChunk(audioData);
            if (this.isClosing || !text || text === OR_STT_NO_SPEECH) return;

            this.previousTail = text.slice(-160);
            console.log(`[OpenRouterSTT-${this.sessionId}] Transcription: "${text}"`);
            this.emit('transcription', { text, timestamp: Date.now(), confidence: 1.0, sessionId: this.sessionId });
        } catch (error) {
            if (this.isClosing || error?.name === 'AbortError') return;
            console.error(`[OpenRouterSTT-${this.sessionId}] Processing error:`, error.message);
            this.emit('error', error);
        } finally {
            this.isProcessingChunk = false;
        }
    }

    sendRealtimeInput(audioData) {
        if (!this.isRunning) return;
        const buf = typeof audioData === 'string' ? Buffer.from(audioData, 'base64') : audioData;
        if (!Buffer.isBuffer(buf) || buf.length === 0) return;
        this.audioBuffer = Buffer.concat([this.audioBuffer, buf]);
    }

    async close() {
        this.isClosing = true;
        this.isRunning = false;
        this.audioBuffer = Buffer.alloc(0);
        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }
        this.currentAbortController?.abort('session closed');
        const startedAt = Date.now();
        while (this.isProcessingChunk && Date.now() - startedAt < 3000) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        this.removeAllListeners();
    }
}

async function createSTT(config = {}) {
    const session = new OpenRouterSTTSession(config);
    session.initialize();

    if (config.callbacks) {
        if (config.callbacks.onmessage) session.on('transcription', config.callbacks.onmessage);
        if (config.callbacks.onerror) session.on('error', config.callbacks.onerror);
        if (config.callbacks.onclose) session.on('close', config.callbacks.onclose);
    }
    return session;
}

module.exports = {
    OpenRouterProvider,
    OpenRouterSTTSession,
    pcm16ToWav,
    createLLM,
    createStreamingLLM,
    createSTT,
};
