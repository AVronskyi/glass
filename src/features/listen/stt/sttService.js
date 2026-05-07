const { BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const { createSTT } = require('../../common/ai/factory');
const modelStateService = require('../../common/services/modelStateService');

const COMPLETION_DEBOUNCE_MS = 2000;
const WHISPER_DUPLICATE_WINDOW_MS = 10 * 1000;

// ── New heartbeat / renewal constants ────────────────────────────────────────────
// Interval to send low-cost keep-alive messages so the remote service does not
// treat the connection as idle. One minute is safely below the typical 2-5 min
// idle timeout window seen on provider websockets.
const KEEP_ALIVE_INTERVAL_MS = 60 * 1000;         // 1 minute

// Interval after which we pro-actively tear down and recreate the STT sessions
// to dodge the 30-minute hard timeout enforced by some providers. 20 minutes
// gives a 10-minute safety buffer.
const SESSION_RENEW_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes

// Duration to allow the old and new sockets to run in parallel so we don't
// miss any packets at the exact swap moment.
const SOCKET_OVERLAP_MS = 2 * 1000; // 2 seconds

class SttService {
    constructor(options = {}) {
        this.rendererWindowName = options.rendererWindowName || 'listen';
        this.updateChannel = options.updateChannel || 'stt-update';
        this.systemAudioChannel = options.systemAudioChannel || 'system-audio-data';
        this.completionDebounceMs = options.completionDebounceMs || COMPLETION_DEBOUNCE_MS;
        this.maxCompletionBufferChars = Math.max(0, options.maxCompletionBufferChars || 0);
        this.readyStatusText = options.readyStatusText || 'Listening...';
        this.respectLanguageEnv = options.respectLanguageEnv !== false;
        this.enabledSpeakers = new Set(options.enabledSpeakers || ['Me', 'Them']);
        this.providerOptions = options.providerOptions || {};
        this.modelInfoOverride = options.modelInfoOverride || null;

        this.mySttSession = null;
        this.theirSttSession = null;
        this.myCurrentUtterance = '';
        this.theirCurrentUtterance = '';
        
        // Turn-completion debouncing
        this.myCompletionBuffer = '';
        this.theirCompletionBuffer = '';
        this.myCompletionTimer = null;
        this.theirCompletionTimer = null;
        
        // System audio capture
        this.systemAudioProc = null;

        // Keep-alive / renewal timers
        this.keepAliveInterval = null;
        this.sessionRenewTimeout = null;

        // Callbacks
        this.onTranscriptionComplete = null;
        this.onStatusUpdate = null;
        this.onPartialTranscript = null;

        this.modelInfo = null; 
        this.lastWhisperTranscriptBySpeaker = new Map();
    }

    isSpeakerEnabled(speaker) {
        return this.enabledSpeakers.has(speaker);
    }

    setCallbacks({ onTranscriptionComplete, onStatusUpdate, onPartialTranscript }) {
        this.onTranscriptionComplete = onTranscriptionComplete;
        this.onStatusUpdate = onStatusUpdate;
        this.onPartialTranscript = onPartialTranscript;
    }

    async resolveModelInfoOverride() {
        if (!this.modelInfoOverride) return null;
        return typeof this.modelInfoOverride === 'function'
            ? await this.modelInfoOverride()
            : this.modelInfoOverride;
    }

    notifyTranscriptionComplete(speaker, text) {
        if (!this.onTranscriptionComplete) return Promise.resolve();

        try {
            return Promise.resolve(this.onTranscriptionComplete(speaker, text)).catch(error => {
                console.error(`[SttService] onTranscriptionComplete callback failed for ${speaker}:`, error);
            });
        } catch (error) {
            console.error(`[SttService] onTranscriptionComplete callback failed for ${speaker}:`, error);
            return Promise.resolve();
        }
    }

    emitPartialTranscript(speaker, text) {
        if (!this.onPartialTranscript) return;
        if (!this.isSpeakerEnabled(speaker)) return;
        const trimmed = String(text || '').trim();
        if (!trimmed) return;
        try {
            this.onPartialTranscript(speaker, trimmed);
        } catch (err) {
            console.error('[SttService] onPartialTranscript callback failed:', err);
        }
    }

    sendToRenderer(channel, data) {
        // Feature-specific events are sent only to the owning content window.
        const { windowPool } = require('../../../window/windowManager');
        const targetWindow = windowPool?.get(this.rendererWindowName);
        
        if (targetWindow && !targetWindow.isDestroyed()) {
            targetWindow.webContents.send(channel, data);
        }
    }

    sendTranscriptUpdate(payload) {
        if (!this.isSpeakerEnabled(payload.speaker)) return;
        this.sendToRenderer(this.updateChannel, payload);
    }

    async handleSendSystemAudioContent(data, mimeType) {
        try {
            await this.sendSystemAudioContent(data, mimeType);
            this.sendToRenderer(this.systemAudioChannel, { data });
            return { success: true };
        } catch (error) {
            console.error('Error sending system audio:', error);
            return { success: false, error: error.message };
        }
    }

    flushMyCompletion() {
        const finalText = (this.myCompletionBuffer + this.myCurrentUtterance).trim();
        if (!this.modelInfo || !finalText) return Promise.resolve();
        if (!this.isSpeakerEnabled('Me')) return Promise.resolve();

        if (this.myCompletionTimer) clearTimeout(this.myCompletionTimer);
        this.myCompletionBuffer = '';
        this.myCompletionTimer = null;
        this.myCurrentUtterance = '';

        // Send to renderer as final
        this.sendTranscriptUpdate({
            speaker: 'Me',
            text: finalText,
            isPartial: false,
            isFinal: true,
            timestamp: Date.now(),
        });
        
        if (this.onStatusUpdate) {
            this.onStatusUpdate(this.readyStatusText);
        }

        return this.notifyTranscriptionComplete('Me', finalText);
    }

    flushTheirCompletion() {
        const finalText = (this.theirCompletionBuffer + this.theirCurrentUtterance).trim();
        if (!this.modelInfo || !finalText) return Promise.resolve();
        if (!this.isSpeakerEnabled('Them')) return Promise.resolve();

        if (this.theirCompletionTimer) clearTimeout(this.theirCompletionTimer);
        this.theirCompletionBuffer = '';
        this.theirCompletionTimer = null;
        this.theirCurrentUtterance = '';

        // Send to renderer as final
        this.sendTranscriptUpdate({
            speaker: 'Them',
            text: finalText,
            isPartial: false,
            isFinal: true,
            timestamp: Date.now(),
        });
        
        if (this.onStatusUpdate) {
            this.onStatusUpdate(this.readyStatusText);
        }

        return this.notifyTranscriptionComplete('Them', finalText);
    }

    debounceMyCompletion(text) {
        if (this.modelInfo?.provider === 'gemini') {
            this.myCompletionBuffer += text;
        } else {
            this.myCompletionBuffer += (this.myCompletionBuffer ? ' ' : '') + text;
        }

        if (this.myCompletionTimer) clearTimeout(this.myCompletionTimer);
        this.myCompletionTimer = setTimeout(() => this.flushMyCompletion(), this.completionDebounceMs);
    }

    debounceTheirCompletion(text) {
        if (this.modelInfo?.provider === 'gemini') {
            this.theirCompletionBuffer += text;
        } else {
            this.theirCompletionBuffer += (this.theirCompletionBuffer ? ' ' : '') + text;
        }

        if (this.theirCompletionTimer) clearTimeout(this.theirCompletionTimer);
        this.theirCompletionTimer = null;

        // Hard cap: prevent unbounded growth during long monologues without pauses.
        // When the buffer exceeds maxCompletionBufferChars, flush at the last
        // sentence boundary if any (so we don't split mid-word) — otherwise flush all.
        if (this.maxCompletionBufferChars > 0
            && this.theirCompletionBuffer.length > this.maxCompletionBufferChars) {
            const buf = this.theirCompletionBuffer;
            const breakIdx = Math.max(
                buf.lastIndexOf('. '),
                buf.lastIndexOf('? '),
                buf.lastIndexOf('! ')
            );
            if (breakIdx > this.maxCompletionBufferChars / 2) {
                const front = buf.slice(0, breakIdx + 1);
                const back  = buf.slice(breakIdx + 2);
                this.theirCompletionBuffer = front;
                this.flushTheirCompletion();
                this.theirCompletionBuffer = back;
                if (back) {
                    this.theirCompletionTimer = setTimeout(
                        () => this.flushTheirCompletion(),
                        this.completionDebounceMs
                    );
                }
            } else {
                this.flushTheirCompletion();
            }
            return;
        }

        this.theirCompletionTimer = setTimeout(() => this.flushTheirCompletion(), this.completionDebounceMs);
    }

    normalizeWhisperText(text) {
        return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    isWhisperNoiseText(text) {
        const normalized = this.normalizeWhisperText(text);
        if (!normalized) return true;

        return /^(\[(blank_audio|no speech detected|inaudible|music( playing)?|sound|noise|silence)\]\s*)+$/.test(normalized)
            || /^(\((blank_audio|no speech detected|inaudible|music( playing)?|sound|noise|silence|keyboard clicking|keyboard clacking)\)\s*)+$/.test(normalized);
    }

    isRecentWhisperDuplicate(speaker, text) {
        const normalized = this.normalizeWhisperText(text);
        const previous = this.lastWhisperTranscriptBySpeaker.get(speaker);
        const now = Date.now();

        if (previous && previous.text === normalized && now - previous.timestamp < WHISPER_DUPLICATE_WINDOW_MS) {
            return true;
        }

        this.lastWhisperTranscriptBySpeaker.set(speaker, { text: normalized, timestamp: now });
        return false;
    }

    handleWhisperMessage(speaker, message) {
        if (!this.isSpeakerEnabled(speaker)) return;
        if (!message.text || !message.text.trim()) return;

        const finalText = message.text.trim();
        if (this.isWhisperNoiseText(finalText) || finalText.length <= 2) {
            console.log(`[Whisper-${speaker}] Filtered noise: "${finalText}"`);
            return;
        }

        if (this.isRecentWhisperDuplicate(speaker, finalText)) {
            console.log(`[Whisper-${speaker}] Filtered duplicate: "${finalText}"`);
            return;
        }

        if (speaker === 'Me') {
            this.debounceMyCompletion(finalText);
        } else {
            this.debounceTheirCompletion(finalText);
        }

        const previewText = speaker === 'Me' ? this.myCompletionBuffer : this.theirCompletionBuffer;
        this.sendTranscriptUpdate({
            speaker,
            text: previewText,
            isPartial: true,
            isFinal: false,
            timestamp: Date.now(),
        });
        this.emitPartialTranscript(speaker, previewText);
    }

    async initializeSttSessions(language = 'en') {
        const effectiveLanguage = this.respectLanguageEnv
            ? process.env.OPENAI_TRANSCRIBE_LANG || language || 'en'
            : language || 'en';

        const modelInfoOverride = await this.resolveModelInfoOverride();
        const modelInfo = modelInfoOverride || await modelStateService.getCurrentModelInfo('stt');
        if (!modelInfo || !modelInfo.apiKey) {
            throw new Error('AI model or API key is not configured.');
        }
        this.modelInfo = modelInfo;
        console.log(`[SttService] Initializing STT for ${modelInfo.provider} using model ${modelInfo.model}`);

        const handleMyMessage = message => {
            if (!this.modelInfo) {
                console.log('[SttService] Ignoring message - session already closed');
                return;
            }
            // console.log('[SttService] handleMyMessage', message);
            
            if (this.modelInfo.provider === 'whisper') {
                this.handleWhisperMessage('Me', message);
                return;
            } else if (this.modelInfo.provider === 'gemini') {
                if (!message.serverContent?.modelTurn) {
                    console.log('[Gemini STT - Me]', JSON.stringify(message, null, 2));
                }

                if (message.serverContent?.turnComplete) {
                    if (this.myCompletionTimer) {
                        clearTimeout(this.myCompletionTimer);
                        this.flushMyCompletion();
                    }
                    return;
                }
            
                const transcription = message.serverContent?.inputTranscription;
                if (!transcription || !transcription.text) return;
                
                const textChunk = transcription.text;
                if (!textChunk.trim() || textChunk.trim() === '<noise>') {
                    return; // 1. Ignore whitespace-only chunks or noise
                }
            
                this.debounceMyCompletion(textChunk);
                
                this.sendTranscriptUpdate({
                    speaker: 'Me',
                    text: this.myCompletionBuffer,
                    isPartial: true,
                    isFinal: false,
                    timestamp: Date.now(),
                });
                
            // Deepgram 
            } else if (this.modelInfo.provider === 'deepgram') {
                const text = message.channel?.alternatives?.[0]?.transcript;
                if (!text || text.trim().length === 0) return;

                const isFinal = message.is_final;
                console.log(`[SttService-Me-Deepgram] Received: isFinal=${isFinal}, text="${text}"`);

                if (isFinal) {
                    // 최종 결과가 도착하면, 현재 진행중인 부분 발화는 비우고
                    // 최종 텍스트로 debounce를 실행합니다.
                    this.myCurrentUtterance = ''; 
                    this.debounceMyCompletion(text); 
                } else {
                    // 부분 결과(interim)인 경우, 화면에 실시간으로 업데이트합니다.
                    if (this.myCompletionTimer) clearTimeout(this.myCompletionTimer);
                    this.myCompletionTimer = null;

                    this.myCurrentUtterance = text;
                    
                    const continuousText = (this.myCompletionBuffer + ' ' + this.myCurrentUtterance).trim();

                    this.sendTranscriptUpdate({
                        speaker: 'Me',
                        text: continuousText,
                        isPartial: true,
                        isFinal: false,
                        timestamp: Date.now(),
                    });
                }
                
            } else {
                const type = message.type;
                const text = message.transcript || message.delta || (message.alternatives && message.alternatives[0]?.transcript) || '';

                if (type === 'conversation.item.input_audio_transcription.delta') {
                    if (this.myCompletionTimer) clearTimeout(this.myCompletionTimer);
                    this.myCompletionTimer = null;
                    this.myCurrentUtterance += text;
                    const continuousText = this.myCompletionBuffer + (this.myCompletionBuffer ? ' ' : '') + this.myCurrentUtterance;
                    if (text && !text.includes('vq_lbr_audio_')) {
                        this.sendTranscriptUpdate({
                            speaker: 'Me',
                            text: continuousText,
                            isPartial: true,
                            isFinal: false,
                            timestamp: Date.now(),
                        });
                    }
                } else if (type === 'conversation.item.input_audio_transcription.completed') {
                    if (text && text.trim()) {
                        const finalUtteranceText = text.trim();
                        this.myCurrentUtterance = '';
                        this.debounceMyCompletion(finalUtteranceText);
                    }
                }
            }

            if (message.error) {
                console.error('[Me] STT Session Error:', message.error);
            }
        };

        const handleTheirMessage = message => {
            if (!message || typeof message !== 'object') return;

            if (!this.modelInfo) {
                console.log('[SttService] Ignoring message - session already closed');
                return;
            }
            
            if (this.modelInfo.provider === 'whisper') {
                this.handleWhisperMessage('Them', message);
                return;
            } else if (this.modelInfo.provider === 'gemini') {
                if (!message.serverContent?.modelTurn) {
                    console.log('[Gemini STT - Them]', JSON.stringify(message, null, 2));
                }

                if (message.serverContent?.turnComplete) {
                    if (this.theirCompletionTimer) {
                        clearTimeout(this.theirCompletionTimer);
                        this.flushTheirCompletion();
                    }
                    return;
                }
            
                const transcription = message.serverContent?.inputTranscription;
                if (!transcription || !transcription.text) return;

                const textChunk = transcription.text;
                if (!textChunk.trim() || textChunk.trim() === '<noise>') {
                    return; // 1. Ignore whitespace-only chunks or noise
                }

                this.debounceTheirCompletion(textChunk);

                this.sendTranscriptUpdate({
                    speaker: 'Them',
                    text: this.theirCompletionBuffer,
                    isPartial: true,
                    isFinal: false,
                    timestamp: Date.now(),
                });
                this.emitPartialTranscript('Them', this.theirCompletionBuffer);

            // Deepgram
            } else if (this.modelInfo.provider === 'deepgram') {
                const text = message.channel?.alternatives?.[0]?.transcript;
                if (!text || text.trim().length === 0) return;

                const isFinal = message.is_final;

                if (isFinal) {
                    this.theirCurrentUtterance = ''; 
                    this.debounceTheirCompletion(text); 
                } else {
                    if (this.theirCompletionTimer) clearTimeout(this.theirCompletionTimer);
                    this.theirCompletionTimer = null;

                    this.theirCurrentUtterance = text;

                    const continuousText = (this.theirCompletionBuffer + ' ' + this.theirCurrentUtterance).trim();

                    this.sendTranscriptUpdate({
                        speaker: 'Them',
                        text: continuousText,
                        isPartial: true,
                        isFinal: false,
                        timestamp: Date.now(),
                    });
                    this.emitPartialTranscript('Them', continuousText);
                }

            } else {
                const type = message.type;
                const text = message.transcript || message.delta || (message.alternatives && message.alternatives[0]?.transcript) || '';
                if (type === 'conversation.item.input_audio_transcription.delta') {
                    if (this.theirCompletionTimer) clearTimeout(this.theirCompletionTimer);
                    this.theirCompletionTimer = null;
                    this.theirCurrentUtterance += text;
                    const continuousText = this.theirCompletionBuffer + (this.theirCompletionBuffer ? ' ' : '') + this.theirCurrentUtterance;
                    if (text && !text.includes('vq_lbr_audio_')) {
                        this.sendTranscriptUpdate({
                            speaker: 'Them',
                            text: continuousText,
                            isPartial: true,
                            isFinal: false,
                            timestamp: Date.now(),
                        });
                        this.emitPartialTranscript('Them', continuousText);
                    }
                } else if (type === 'conversation.item.input_audio_transcription.completed') {
                    if (text && text.trim()) {
                        const finalUtteranceText = text.trim();
                        this.theirCurrentUtterance = '';
                        this.debounceTheirCompletion(finalUtteranceText);
                    }
                }
            }
            
            if (message.error) {
                console.error('[Them] STT Session Error:', message.error);
            }
        };

        const mySttConfig = {
            language: effectiveLanguage,
            callbacks: {
                onmessage: handleMyMessage,
                onerror: error => console.error('My STT session error:', error.message),
                onclose: event => console.log('My STT session closed:', event.reason),
            },
        };
        
        const theirSttConfig = {
            language: effectiveLanguage,
            callbacks: {
                onmessage: handleTheirMessage,
                onerror: error => console.error('Their STT session error:', error.message),
                onclose: event => console.log('Their STT session closed:', event.reason),
            },
        };
        
        const sttOptions = {
            ...this.providerOptions,
            apiKey: this.modelInfo.apiKey,
            model: this.modelInfo.model,
            language: effectiveLanguage,
            usePortkey: this.modelInfo.provider === 'openai-glass',
            portkeyVirtualKey: this.modelInfo.provider === 'openai-glass' ? this.modelInfo.apiKey : undefined,
        };

        // Add sessionType for Whisper to distinguish between My and Their sessions
        const myOptions = { ...sttOptions, callbacks: mySttConfig.callbacks, sessionType: 'my' };
        const theirOptions = { ...sttOptions, callbacks: theirSttConfig.callbacks, sessionType: 'their' };

        const sessionInitializers = [];
        this.mySttSession = null;
        this.theirSttSession = null;

        if (this.isSpeakerEnabled('Me')) {
            sessionInitializers.push(
                createSTT(this.modelInfo.provider, myOptions).then(session => {
                    this.mySttSession = session;
                })
            );
        }

        if (this.isSpeakerEnabled('Them')) {
            sessionInitializers.push(
                createSTT(this.modelInfo.provider, theirOptions).then(session => {
                    this.theirSttSession = session;
                })
            );
        }

        if (sessionInitializers.length === 0) {
            throw new Error('At least one STT speaker must be enabled.');
        }

        await Promise.all(sessionInitializers);

        console.log(`✅ STT sessions initialized successfully for: ${Array.from(this.enabledSpeakers).join(', ')}.`);

        // ── Setup keep-alive heart-beats ────────────────────────────────────────
        if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
        this.keepAliveInterval = setInterval(() => {
            this._sendKeepAlive();
        }, KEEP_ALIVE_INTERVAL_MS);

        // ── Schedule session auto-renewal ───────────────────────────────────────
        if (this.sessionRenewTimeout) clearTimeout(this.sessionRenewTimeout);
        this.sessionRenewTimeout = setTimeout(async () => {
            try {
                console.log('[SttService] Auto-renewing STT sessions…');
                await this.renewSessions(language);
            } catch (err) {
                console.error('[SttService] Failed to renew STT sessions:', err);
            }
        }, SESSION_RENEW_INTERVAL_MS);

        return true;
    }

    /**
     * Send a lightweight keep-alive to prevent idle disconnects.
     * Currently only implemented for OpenAI provider because Gemini's SDK
     * already performs its own heart-beats.
     */
    _sendKeepAlive() {
        if (!this.isSessionActive()) return;

        if (this.modelInfo?.provider === 'openai') {
            try {
                this.mySttSession?.keepAlive?.();
                this.theirSttSession?.keepAlive?.();
            } catch (err) {
                console.error('[SttService] keepAlive error:', err.message);
            }
        }
    }

    /**
     * Gracefully tears down then recreates the STT sessions. Should be invoked
     * on a timer to avoid provider-side hard timeouts.
     */
    async renewSessions(language = 'en') {
        if (!this.isSessionActive()) {
            console.warn('[SttService] renewSessions called but no active session.');
            return;
        }

        const oldMySession = this.mySttSession;
        const oldTheirSession = this.theirSttSession;

        console.log('[SttService] Spawning fresh STT sessions in the background…');

        // We reuse initializeSttSessions to create fresh sessions with the same
        // language and handlers. The method will update the session pointers
        // and timers, but crucially it does NOT touch the system audio capture
        // pipeline, so audio continues flowing uninterrupted.
        await this.initializeSttSessions(language);

        // Close the old sessions after a short overlap window.
        setTimeout(() => {
            try {
                oldMySession?.close?.();
                oldTheirSession?.close?.();
                console.log('[SttService] Old STT sessions closed after hand-off.');
            } catch (err) {
                console.error('[SttService] Error closing old STT sessions:', err.message);
            }
        }, SOCKET_OVERLAP_MS);
    }

    async sendMicAudioContent(data, mimeType) {
        // const provider = await this.getAiProvider();
        // const isGemini = provider === 'gemini';
        
        if (!this.isSpeakerEnabled('Me')) {
            throw new Error('User STT session is disabled');
        }
        if (!this.mySttSession) {
            throw new Error('User STT session not active');
        }

        let modelInfo = this.modelInfo;
        if (!modelInfo) {
            console.warn('[SttService] modelInfo not found, fetching on-the-fly as a fallback...');
            modelInfo = await modelStateService.getCurrentModelInfo('stt');
        }
        if (!modelInfo) {
            throw new Error('STT model info could not be retrieved.');
        }

        let payload;
        if (modelInfo.provider === 'gemini') {
            payload = { audio: { data, mimeType: mimeType || 'audio/pcm;rate=24000' } };
        } else if (modelInfo.provider === 'deepgram') {
            payload = Buffer.from(data, 'base64'); 
        } else {
            payload = data;
        }
        await this.mySttSession.sendRealtimeInput(payload);
    }

    async sendSystemAudioContent(data, mimeType) {
        if (!this.theirSttSession) {
            throw new Error('Their STT session not active');
        }

        let modelInfo = this.modelInfo;
        if (!modelInfo) {
            console.warn('[SttService] modelInfo not found, fetching on-the-fly as a fallback...');
            modelInfo = await modelStateService.getCurrentModelInfo('stt');
        }
        if (!modelInfo) {
            throw new Error('STT model info could not be retrieved.');
        }

        let payload;
        if (modelInfo.provider === 'gemini') {
            payload = { audio: { data, mimeType: mimeType || 'audio/pcm;rate=24000' } };
        } else if (modelInfo.provider === 'deepgram') {
            payload = Buffer.from(data, 'base64');
        } else {
            payload = data;
        }

        await this.theirSttSession.sendRealtimeInput(payload);
    }

    killExistingSystemAudioDump() {
        return new Promise(resolve => {
            console.log('Checking for existing SystemAudioDump processes...');

            const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
                stdio: 'ignore',
            });

            killProc.on('close', code => {
                if (code === 0) {
                    console.log('Killed existing SystemAudioDump processes');
                } else {
                    console.log('No existing SystemAudioDump processes found');
                }
                resolve();
            });

            killProc.on('error', err => {
                console.log('Error checking for existing processes (this is normal):', err.message);
                resolve();
            });

            setTimeout(() => {
                killProc.kill();
                resolve();
            }, 2000);
        });
    }

    async startMacOSAudioCapture() {
        if (process.platform !== 'darwin' || !this.theirSttSession) return false;

        await this.killExistingSystemAudioDump();
        console.log('Starting macOS audio capture for "Them"...');

        const { app } = require('electron');
        const path = require('path');
        const systemAudioPath = app.isPackaged
            ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'ui', 'assets', 'SystemAudioDump')
            : path.join(app.getAppPath(), 'src', 'ui', 'assets', 'SystemAudioDump');

        console.log('SystemAudioDump path:', systemAudioPath);

        this.systemAudioProc = spawn(systemAudioPath, [], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        if (!this.systemAudioProc.pid) {
            console.error('Failed to start SystemAudioDump');
            return false;
        }

        console.log('SystemAudioDump started with PID:', this.systemAudioProc.pid);

        const CHUNK_DURATION = 0.1;
        const SAMPLE_RATE = 24000;
        const BYTES_PER_SAMPLE = 2;
        const CHANNELS = 2;
        const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

        let audioBuffer = Buffer.alloc(0);

        // const provider = await this.getAiProvider();
        // const isGemini = provider === 'gemini';

        let modelInfo = this.modelInfo;
        if (!modelInfo) {
            console.warn('[SttService] modelInfo not found, fetching on-the-fly as a fallback...');
            modelInfo = await modelStateService.getCurrentModelInfo('stt');
        }
        if (!modelInfo) {
            throw new Error('STT model info could not be retrieved.');
        }

        this.systemAudioProc.stdout.on('data', async data => {
            audioBuffer = Buffer.concat([audioBuffer, data]);

            while (audioBuffer.length >= CHUNK_SIZE) {
                const chunk = audioBuffer.slice(0, CHUNK_SIZE);
                audioBuffer = audioBuffer.slice(CHUNK_SIZE);

                const monoChunk = CHANNELS === 2 ? this.convertStereoToMono(chunk) : chunk;
                const base64Data = monoChunk.toString('base64');

                this.sendToRenderer(this.systemAudioChannel, { data: base64Data });

                if (this.theirSttSession) {
                    try {
                        let payload;
                        if (modelInfo.provider === 'gemini') {
                            payload = { audio: { data: base64Data, mimeType: 'audio/pcm;rate=24000' } };
                        } else if (modelInfo.provider === 'deepgram') {
                            payload = Buffer.from(base64Data, 'base64');
                        } else {
                            payload = base64Data;
                        }

                        await this.theirSttSession.sendRealtimeInput(payload);
                    } catch (err) {
                        console.error('Error sending system audio:', err.message);
                    }
                }
            }
        });

        this.systemAudioProc.stderr.on('data', data => {
            console.error('SystemAudioDump stderr:', data.toString());
        });

        this.systemAudioProc.on('close', code => {
            console.log('SystemAudioDump process closed with code:', code);
            this.systemAudioProc = null;
        });

        this.systemAudioProc.on('error', err => {
            console.error('SystemAudioDump process error:', err);
            this.systemAudioProc = null;
        });

        return true;
    }

    convertStereoToMono(stereoBuffer) {
        const samples = stereoBuffer.length / 4;
        const monoBuffer = Buffer.alloc(samples * 2);

        for (let i = 0; i < samples; i++) {
            const leftSample = stereoBuffer.readInt16LE(i * 4);
            monoBuffer.writeInt16LE(leftSample, i * 2);
        }

        return monoBuffer;
    }

    stopMacOSAudioCapture() {
        if (this.systemAudioProc) {
            console.log('Stopping SystemAudioDump...');
            this.systemAudioProc.kill('SIGTERM');
            this.systemAudioProc = null;
        }
    }

    isMacOSAudioRunning() {
        return !!this.systemAudioProc;
    }

    isSessionActive() {
        const needsMySession = this.isSpeakerEnabled('Me');
        const needsTheirSession = this.isSpeakerEnabled('Them');
        return (!needsMySession || !!this.mySttSession) && (!needsTheirSession || !!this.theirSttSession);
    }

    async closeSessions() {
        this.stopMacOSAudioCapture();

        // Clear heartbeat / renewal timers
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
        if (this.sessionRenewTimeout) {
            clearTimeout(this.sessionRenewTimeout);
            this.sessionRenewTimeout = null;
        }

        // Clear timers
        if (this.myCompletionTimer) {
            clearTimeout(this.myCompletionTimer);
            this.myCompletionTimer = null;
        }
        if (this.theirCompletionTimer) {
            clearTimeout(this.theirCompletionTimer);
            this.theirCompletionTimer = null;
        }

        // Flush any pending buffers so the last spoken words still get a final
        // transcription event (otherwise pressing Stop right after speaking
        // would drop ~1-2 sentences that were waiting for the debounce timer).
        const flushPromises = [];
        if (this.myCompletionBuffer || this.myCurrentUtterance) {
            flushPromises.push(this.flushMyCompletion());
        }
        if (this.theirCompletionBuffer || this.theirCurrentUtterance) {
            flushPromises.push(this.flushTheirCompletion());
        }
        await Promise.all(flushPromises);

        const closePromises = [];
        if (this.mySttSession) {
            closePromises.push(this.mySttSession.close());
            this.mySttSession = null;
        }
        if (this.theirSttSession) {
            closePromises.push(this.theirSttSession.close());
            this.theirSttSession = null;
        }

        await Promise.all(closePromises);
        console.log('All STT sessions closed.');

        // Reset state
        this.myCurrentUtterance = '';
        this.theirCurrentUtterance = '';
        this.myCompletionBuffer = '';
        this.theirCompletionBuffer = '';
        this.lastWhisperTranscriptBySpeaker.clear();
        this.modelInfo = null; 
    }
}

module.exports = SttService;
