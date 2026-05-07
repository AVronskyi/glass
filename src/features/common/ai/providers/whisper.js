let spawn, path, fs, net, EventEmitter;

if (typeof window === 'undefined') {
    spawn = require('child_process').spawn;
    path = require('path');
    fs = require('fs');
    net = require('net');
    EventEmitter = require('events').EventEmitter;
} else {
    class DummyEventEmitter {
        on() {}
        emit() {}
        removeAllListeners() {}
    }
    EventEmitter = DummyEventEmitter;
}

function getEnvValue(name, fallback = null) {
    if (typeof process === 'undefined' || !process.env) return fallback;
    return process.env[name] || fallback;
}

function getPositiveNumberEnv(name, fallback, min = 0) {
    const value = Number(getEnvValue(name));
    return Number.isFinite(value) && value >= min ? value : fallback;
}

function getPositiveNumberOption(options, key, envName, fallback, min = 0) {
    const optionValue = options && options[key] !== undefined ? Number(options[key]) : NaN;
    if (Number.isFinite(optionValue) && optionValue >= min) return optionValue;
    return getPositiveNumberEnv(envName, fallback, min);
}

function getWhisperDebugEnabled() {
    const value = String(getEnvValue('PICKLE_WHISPER_DEBUG', '')).toLowerCase();
    return value === '1' || value === 'true' || value === 'yes';
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getFreeLocalPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();

        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(() => resolve(address.port));
        });
    });
}

function createAbortSignal(timeoutMs, externalSignal = null) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromExternal = () => controller.abort(externalSignal.reason);

    if (externalSignal?.aborted) {
        controller.abort(externalSignal.reason);
    } else if (externalSignal) {
        externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }

    return {
        signal: controller.signal,
        clear: () => {
            clearTimeout(timeout);
            externalSignal?.removeEventListener?.('abort', abortFromExternal);
        },
    };
}

class WhisperServerProcess {
    constructor({ serverPath, modelPath, language, threads }) {
        this.serverPath = serverPath;
        this.modelPath = modelPath;
        this.language = language || 'auto';
        this.threads = String(threads || 4);
        this.process = null;
        this.port = null;
        this.url = null;
        this.refCount = 0;
        this.readyPromise = null;
        this.closed = false;
        this.stderrTail = '';
        this.debugWhisper = getWhisperDebugEnabled();
    }

    async start() {
        if (this.readyPromise) return this.readyPromise;
        this.readyPromise = this._start();
        return this.readyPromise;
    }

    async _start() {
        this.port = await getFreeLocalPort();
        this.url = `http://127.0.0.1:${this.port}`;

        const args = [
            '-m', this.modelPath,
            '--host', '127.0.0.1',
            '--port', String(this.port),
            '--language', this.language,
            '--threads', this.threads,
            '--no-timestamps',
            '--suppress-nst',
            '--no-context',
        ];

        console.log(`[WhisperServer] Starting persistent server on ${this.url}`);
        this.process = spawn(this.serverPath, args, {
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
        });

        this.process.stderr.on('data', data => {
            const text = data.toString();
            this.stderrTail = (this.stderrTail + text).slice(-3000);
            if (this.debugWhisper) {
                console.log(`[WhisperServer:${this.port}] ${text.trim()}`);
            }
        });

        this.process.on('exit', (code, signal) => {
            if (!this.closed) {
                console.warn(`[WhisperServer] Server exited unexpectedly: code=${code}, signal=${signal}`);
            }
        });

        this.process.on('error', error => {
            if (!this.closed) {
                console.error('[WhisperServer] Failed to start server process:', error);
            }
        });

        await this.waitUntilReady();
        console.log(`[WhisperServer] Ready on ${this.url}`);
    }

    async waitUntilReady() {
        if (typeof fetch !== 'function') {
            throw new Error('Persistent Whisper mode requires a runtime with fetch support.');
        }

        for (let attempt = 0; attempt < 80; attempt++) {
            if (!this.process || this.process.exitCode !== null) {
                throw new Error(`Whisper server exited before becoming ready. ${this.stderrTail.trim()}`);
            }

            const request = createAbortSignal(500);
            try {
                await fetch(this.url, { signal: request.signal });
                request.clear();
                return;
            } catch (error) {
                request.clear();
                await delay(100);
            }
        }

        throw new Error(`Whisper server did not become ready on ${this.url}. ${this.stderrTail.trim()}`);
    }

    async transcribeFile(filePath, signal = null) {
        if (!this.url) {
            throw new Error('Whisper server is not ready.');
        }
        if (typeof fetch !== 'function' || typeof FormData !== 'function') {
            throw new Error('Persistent Whisper mode requires fetch and FormData support.');
        }

        const BlobCtor = globalThis.Blob || require('buffer').Blob;
        const wavBuffer = await fs.promises.readFile(filePath);
        const formData = new FormData();
        formData.append('file', new BlobCtor([wavBuffer], { type: 'audio/wav' }), path.basename(filePath));
        formData.append('response_format', 'json');

        const request = createAbortSignal(30000, signal);
        let response;
        try {
            response = await fetch(`${this.url}/inference`, {
                method: 'POST',
                body: formData,
                signal: request.signal,
            });
        } finally {
            request.clear();
        }

        const bodyText = await response.text();
        if (!response.ok) {
            throw new Error(`Whisper server inference failed (${response.status}): ${bodyText.slice(0, 500)}`);
        }

        try {
            const json = JSON.parse(bodyText);
            return String(json.text || json.transcription || '').trim();
        } catch {
            return bodyText.trim();
        }
    }

    async stop() {
        this.closed = true;
        if (!this.process) return;

        const proc = this.process;
        this.process = null;

        await new Promise(resolve => {
            let settled = false;
            const settle = () => {
                if (settled) return;
                settled = true;
                resolve();
            };

            proc.once('close', settle);
            try {
                proc.kill('SIGTERM');
            } catch {
                settle();
            }

            const timeout = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                } catch {}
                settle();
            }, 2000);
            timeout.unref?.();
        });

        console.log(`[WhisperServer] Stopped server on ${this.url}`);
    }
}

const whisperServerRegistry = new Map();

function getWhisperServerKey({ serverPath, modelPath, language, threads }) {
    return [serverPath, modelPath, language || 'auto', String(threads || 4)].join('|');
}

async function acquireWhisperServer(config) {
    const key = getWhisperServerKey(config);
    let server = whisperServerRegistry.get(key);

    if (!server || server.closed || !server.process) {
        server = new WhisperServerProcess(config);
        whisperServerRegistry.set(key, server);
    }

    server.refCount += 1;
    try {
        await server.start();
        return server;
    } catch (error) {
        server.refCount -= 1;
        if (server.refCount <= 0) {
            whisperServerRegistry.delete(key);
            await server.stop().catch(() => {});
        }
        throw error;
    }
}

async function releaseWhisperServer(server) {
    if (!server) return;

    server.refCount -= 1;
    if (server.refCount > 0) return;

    const key = getWhisperServerKey(server);
    whisperServerRegistry.delete(key);
    await server.stop();
}

class WhisperSTTSession extends EventEmitter {
    constructor(model, whisperService, sessionId, options = {}) {
        super();
        this.model = model;
        this.whisperService = whisperService;
        this.sessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.process = null;
        this.isRunning = false;
        this.audioBuffer = Buffer.alloc(0);
        this.processingInterval = null;
        this.isProcessingChunk = false;
        this.lastTranscription = '';
        this.logPrefix = 'WhisperSTT';
        this.sampleRate = 24000;
        this.bytesPerSample = 2;
        this.chunkSeconds = getPositiveNumberOption(options, 'chunkSeconds', 'PICKLE_WHISPER_CHUNK_SECONDS', 4, 0.5);
        this.processingIntervalMs = getPositiveNumberOption(options, 'processingIntervalMs', 'PICKLE_WHISPER_INTERVAL_MS', 1000, 250);
        this.silenceRmsThreshold = getPositiveNumberOption(options, 'silenceRmsThreshold', 'PICKLE_WHISPER_SILENCE_RMS', 80, 0);
        this.threads = String(Math.round(getPositiveNumberOption(options, 'threads', 'PICKLE_WHISPER_THREADS', 4, 1)));
        this.language = options.whisperLanguage || getEnvValue('PICKLE_WHISPER_LANGUAGE', 'auto') || 'auto';
        this.debugWhisper = getWhisperDebugEnabled();
    }

    async initialize() {
        try {
            await this.whisperService.ensureModelAvailable(this.model);
            this.isRunning = true;
            this.startProcessingLoop();
            return true;
        } catch (error) {
            console.error('[WhisperSTT] Initialization error:', error);
            this.emit('error', error);
            return false;
        }
    }

    startProcessingLoop() {
        this.processingInterval = setInterval(async () => {
            const minBufferSize = Math.round(this.sampleRate * this.bytesPerSample * this.chunkSeconds);
            if (this.audioBuffer.length >= minBufferSize && !this.process && !this.isProcessingChunk) {
                console.log(`[${this.logPrefix}-${this.sessionId}] Processing audio chunk, buffer size: ${this.audioBuffer.length}`);
                await this.processAudioChunk();
            }
        }, this.processingIntervalMs);
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

    async processAudioChunk() {
        if (!this.isRunning || this.audioBuffer.length === 0 || this.isProcessingChunk) return;

        const audioData = this.audioBuffer;
        this.audioBuffer = Buffer.alloc(0);
        this.isProcessingChunk = true;

        try {
            const rms = this.calculatePcmRms(audioData);
            if (this.silenceRmsThreshold > 0 && rms < this.silenceRmsThreshold) {
                if (this.debugWhisper) {
                    console.log(`[WhisperSTT-${this.sessionId}] Skipping silent chunk, rms=${rms.toFixed(1)}`);
                }
                this.isProcessingChunk = false;
                return;
            }

            const tempFile = await this.whisperService.saveAudioToTemp(audioData, this.sessionId);
            
            if (!tempFile || typeof tempFile !== 'string') {
                console.error('[WhisperSTT] Invalid temp file path:', tempFile);
                this.isProcessingChunk = false;
                return;
            }
            
            const whisperPath = await this.whisperService.getWhisperPath();
            const modelPath = await this.whisperService.getModelPath(this.model);

            if (!whisperPath || !modelPath) {
                console.error('[WhisperSTT] Invalid whisper or model path:', { whisperPath, modelPath });
                this.isProcessingChunk = false;
                return;
            }

            this.process = spawn(whisperPath, [
                '-m', modelPath,
                '-f', tempFile,
                '--no-timestamps',
                '--no-prints',
                '--suppress-nst',
                '--language', this.language,
                '--threads', this.threads,
            ]);

            let output = '';
            let errorOutput = '';

            this.process.stdout.on('data', (data) => {
                output += data.toString();
            });

            this.process.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            this.process.on('close', async (code) => {
                this.process = null;

                if (code !== 0 || this.debugWhisper) {
                    console.log(`[WhisperSTT-${this.sessionId}] Whisper exit code=${code}, stdout=${output.length}b, stderr=${errorOutput.length}b`);
                }
                if ((code !== 0 || this.debugWhisper) && errorOutput.trim()) {
                    console.log(`[WhisperSTT-${this.sessionId}] stderr: ${errorOutput.slice(0, 500).replace(/\s+/g, ' ').trim()}`);
                }
                if (code !== 0 && output.trim()) {
                    console.log(`[WhisperSTT-${this.sessionId}] stdout (on error): ${output.slice(0, 500).replace(/\s+/g, ' ').trim()}`);
                }

                if (code === 0 && output.trim()) {
                    const transcription = output.trim();
                    if (transcription && transcription !== this.lastTranscription) {
                        this.lastTranscription = transcription;
                        console.log(`[WhisperSTT-${this.sessionId}] Transcription: "${transcription}"`);
                        this.emit('transcription', {
                            text: transcription,
                            timestamp: Date.now(),
                            confidence: 1.0,
                            sessionId: this.sessionId
                        });
                    }
                }

                await this.whisperService.cleanupTempFile(tempFile);
                this.isProcessingChunk = false;
            });

            this.process.on('error', async error => {
                console.error('[WhisperSTT] Whisper process error:', error);
                this.process = null;
                await this.whisperService.cleanupTempFile(tempFile);
                this.isProcessingChunk = false;
                this.emit('error', error);
            });

        } catch (error) {
            console.error('[WhisperSTT] Processing error:', error);
            this.isProcessingChunk = false;
            this.emit('error', error);
        }
    }

    sendRealtimeInput(audioData) {
        if (!this.isRunning) {
            console.warn(`[WhisperSTT-${this.sessionId}] Session not running, cannot accept audio`);
            return;
        }

        if (typeof audioData === 'string') {
            try {
                audioData = Buffer.from(audioData, 'base64');
            } catch (error) {
                console.error('[WhisperSTT] Failed to decode base64 audio data:', error);
                return;
            }
        } else if (audioData instanceof ArrayBuffer) {
            audioData = Buffer.from(audioData);
        } else if (!Buffer.isBuffer(audioData) && !(audioData instanceof Uint8Array)) {
            console.error('[WhisperSTT] Invalid audio data type:', typeof audioData);
            return;
        }

        if (!Buffer.isBuffer(audioData)) {
            audioData = Buffer.from(audioData);
        }

        if (audioData.length > 0) {
            this.audioBuffer = Buffer.concat([this.audioBuffer, audioData]);
            // Log every 10th audio chunk to avoid spam
            if (this.debugWhisper && Math.random() < 0.1) {
                console.log(`[${this.logPrefix}-${this.sessionId}] Received audio chunk: ${audioData.length} bytes, total buffer: ${this.audioBuffer.length} bytes`);
            }
        }
    }

    async close() {
        console.log(`[WhisperSTT-${this.sessionId}] Closing session`);
        this.isRunning = false;

        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }

        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
        }
        this.isProcessingChunk = false;

        this.removeAllListeners();
    }
}

class WhisperServerSTTSession extends WhisperSTTSession {
    constructor(model, whisperService, sessionId, options = {}) {
        super(model, whisperService, sessionId, options);
        this.server = null;
        this.logPrefix = 'WhisperServerSTT';
        this.isClosing = false;
        this.currentAbortController = null;
    }

    async initialize() {
        try {
            await this.whisperService.ensureModelAvailable(this.model);
            const serverPath = await this.whisperService.getWhisperServerPath();
            const modelPath = await this.whisperService.getModelPath(this.model);

            this.server = await acquireWhisperServer({
                serverPath,
                modelPath,
                language: this.language,
                threads: this.threads,
            });

            this.isRunning = true;
            this.startProcessingLoop();
            return true;
        } catch (error) {
            console.error('[WhisperServerSTT] Initialization error:', error);
            this.emit('error', error);
            return false;
        }
    }

    async processAudioChunk() {
        if (!this.isRunning || this.audioBuffer.length === 0 || this.isProcessingChunk) return;

        const audioData = this.audioBuffer;
        this.audioBuffer = Buffer.alloc(0);
        this.isProcessingChunk = true;
        let tempFile = null;

        try {
            const rms = this.calculatePcmRms(audioData);
            if (this.silenceRmsThreshold > 0 && rms < this.silenceRmsThreshold) {
                if (this.debugWhisper) {
                    console.log(`[WhisperServerSTT-${this.sessionId}] Skipping silent chunk, rms=${rms.toFixed(1)}`);
                }
                return;
            }

            tempFile = await this.whisperService.saveAudioToTemp(audioData, this.sessionId);
            this.currentAbortController = new AbortController();
            const transcription = await this.server.transcribeFile(tempFile, this.currentAbortController.signal);

            if (!this.isClosing && transcription && transcription !== this.lastTranscription) {
                this.lastTranscription = transcription;
                console.log(`[WhisperServerSTT-${this.sessionId}] Transcription: "${transcription}"`);
                this.emit('transcription', {
                    text: transcription,
                    timestamp: Date.now(),
                    confidence: 1.0,
                    sessionId: this.sessionId
                });
            }
        } catch (error) {
            if (this.isClosing) {
                if (this.debugWhisper) {
                    console.log(`[WhisperServerSTT-${this.sessionId}] Ignored in-flight inference error during close: ${error.message}`);
                }
                return;
            }
            console.error('[WhisperServerSTT] Processing error:', error);
            this.emit('error', error);
        } finally {
            if (tempFile) {
                await this.whisperService.cleanupTempFile(tempFile);
            }
            this.currentAbortController = null;
            this.isProcessingChunk = false;
        }
    }

    async close() {
        console.log(`[WhisperServerSTT-${this.sessionId}] Closing session`);
        this.isClosing = true;
        this.isRunning = false;
        this.audioBuffer = Buffer.alloc(0);

        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }

        this.currentAbortController?.abort('Whisper server STT session closed');
        const closeWaitStartedAt = Date.now();
        while (this.isProcessingChunk && Date.now() - closeWaitStartedAt < 3000) {
            await delay(50);
        }

        await releaseWhisperServer(this.server);
        this.server = null;
        this.isProcessingChunk = false;
        this.removeAllListeners();
    }
}

class WhisperProvider {
    static async validateApiKey() {
        // Whisper is a local service, no API key validation needed.
        return { success: true };
    }

    constructor() {
        this.whisperService = null;
    }

    async initialize() {
        if (!this.whisperService) {
            this.whisperService = require('../../services/whisperService');
            if (!this.whisperService.isInitialized) {
                await this.whisperService.initialize();
            }
        }
    }

    async createSTT(config) {
        await this.initialize();
        
        const model = config.model || 'whisper-tiny';
        const sessionType = config.sessionType || 'unknown';
        console.log(`[WhisperProvider] Creating ${sessionType} STT session with model: ${model}`);
        
        // Create unique session ID based on type
        const sessionId = `${sessionType}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const session = config.whisperMode === 'server'
            ? new WhisperServerSTTSession(model, this.whisperService, sessionId, config)
            : new WhisperSTTSession(model, this.whisperService, sessionId, config);
        
        // Log session creation
        console.log(`[WhisperProvider] Created session: ${sessionId}`);
        
        const initialized = await session.initialize();
        if (!initialized) {
            throw new Error('Failed to initialize Whisper STT session');
        }

        if (config.callbacks) {
            if (config.callbacks.onmessage) {
                session.on('transcription', config.callbacks.onmessage);
            }
            if (config.callbacks.onerror) {
                session.on('error', config.callbacks.onerror);
            }
            if (config.callbacks.onclose) {
                session.on('close', config.callbacks.onclose);
            }
        }

        return session;
    }

    async createLLM() {
        throw new Error('Whisper provider does not support LLM functionality');
    }

    async createStreamingLLM() {
        console.warn('[WhisperProvider] Streaming LLM is not supported by Whisper.');
        throw new Error('Whisper does not support LLM.');
    }
}

module.exports = {
    WhisperProvider,
    WhisperSTTSession,
    WhisperServerSTTSession
};
