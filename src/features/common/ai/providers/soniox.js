// providers/soniox.js

const WebSocket = require('ws');

const SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
// Soniox answers ~20 s without audio or keepalive with error 408 and closes the
// socket (with code 1000). Any audio frame — silence included — counts, so this
// only fires when capture stalls.
const KEEPALIVE_IDLE_MS = 5_000;
const FINALIZE_TIMEOUT_MS = 2_000;
const FINISHED_TIMEOUT_MS = 3_000;

class SonioxProvider {
    static async validateApiKey(key) {
        if (!key || typeof key !== 'string') {
            return { success: false, error: 'Invalid Soniox API key format.' };
        }
        try {
            const response = await fetch('https://api.soniox.com/v1/models', {
                headers: { Authorization: `Bearer ${key}` },
            });
            if (response.ok) return { success: true };
            const errorData = await response.json().catch(() => ({}));
            return { success: false, error: errorData.error_message || `Validation failed with status: ${response.status}` };
        } catch (error) {
            console.error('[SonioxProvider] Network error during key validation:', error);
            return { success: false, error: error.message || 'A network error occurred during validation.' };
        }
    }
}

function createSTT({
    apiKey,
    model = 'stt-rt-v5',
    language = 'en',
    sampleRate = 24000,
    translation,
    callbacks = {},
}) {
    const ws = new WebSocket(SONIOX_WS_URL);
    let lastSendTs = Date.now();
    let keepAliveTimer = null;
    let onFin = null;
    let onFinished = null;

    const send = (data) => {
        ws.send(data);
        lastSendTs = Date.now();
    };

    // Stop can land mid-word: `finalize` freezes everything sent so far (answered
    // by a <fin> token), the empty frame ends the stream (answered by
    // `finished: true`). Both answers still go through onmessage, so the last
    // words reach the consumer before close() resolves.
    const close = async () => {
        clearInterval(keepAliveTimer);
        if (ws.readyState !== WebSocket.OPEN) return;
        const closed = new Promise(resolve => ws.once('close', resolve));
        const waitFor = (register, ms) => Promise.race([
            new Promise(resolve => register(resolve)),
            closed,
            new Promise(resolve => setTimeout(resolve, ms)),
        ]);

        send(JSON.stringify({ type: 'finalize' }));
        await waitFor(resolve => { onFin = resolve; }, FINALIZE_TIMEOUT_MS);
        if (ws.readyState === WebSocket.OPEN) send('');
        await waitFor(resolve => { onFinished = resolve; }, FINISHED_TIMEOUT_MS);
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'client');
    };

    return new Promise((resolve, reject) => {
        const to = setTimeout(() => {
            ws.terminate();
            reject(new Error('Soniox open timeout (10 s)'));
        }, 10_000);

        ws.on('open', () => {
            clearTimeout(to);
            // The key travels only in this first frame. Never log this object.
            send(JSON.stringify({
                api_key: apiKey,
                model: model || 'stt-rt-v5',
                audio_format: 'pcm_s16le',
                sample_rate: sampleRate,
                num_channels: 1,
                language_hints: [language],
                enable_endpoint_detection: true,
                ...(translation ? { translation } : {}),
            }));
            keepAliveTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN && Date.now() - lastSendTs >= KEEPALIVE_IDLE_MS) {
                    send(JSON.stringify({ type: 'keepalive' }));
                }
            }, KEEPALIVE_IDLE_MS);
            resolve({
                // sttService hands over base64 strings for every provider but Deepgram.
                sendRealtimeInput: (data) => send(typeof data === 'string' ? Buffer.from(data, 'base64') : data),
                close,
            });
        });

        ws.on('message', raw => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            // Errors carry `tokens: []` too, and the close that follows uses code
            // 1000 — the error fields are the only signal something went wrong.
            if (msg.error_code) {
                callbacks.onerror?.(new Error(`Soniox ${msg.error_type || msg.error_code}: ${msg.error_message} (request_id ${msg.request_id})`));
                return;
            }
            callbacks.onmessage?.({ provider: 'soniox', ...msg });
            if (msg.tokens?.some(t => t.text === '<fin>')) onFin?.();
            if (msg.finished) onFinished?.();
        });

        ws.on('close', (code, reason) => {
            clearInterval(keepAliveTimer);
            callbacks.onclose?.({ code, reason: reason.toString() });
        });

        ws.on('error', err => {
            clearTimeout(to);
            callbacks.onerror?.(err);
            reject(err);
        });
    });
}

module.exports = {
    SonioxProvider,
    createSTT,
};
