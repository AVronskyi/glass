const SttService = require('../listen/stt/sttService');
const { createStreamingLLM } = require('../common/ai/factory');
const modelStateService = require('../common/services/modelStateService');
const internalBridge = require('../../bridge/internalBridge');

function getPositiveEnvNumber(name, fallback, min = 0) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= min ? value : fallback;
}

const TRANSLATION_COMPLETION_DEBOUNCE_MS = getPositiveEnvNumber('PICKLE_TRANSLATE_DEBOUNCE_MS', 2000, 50);
const TRANSLATE_WHISPER_CHUNK_SECONDS    = getPositiveEnvNumber('PICKLE_TRANSLATE_WHISPER_CHUNK_SECONDS', 1.0, 0.4);
const TRANSLATE_WHISPER_INTERVAL_MS      = getPositiveEnvNumber('PICKLE_TRANSLATE_WHISPER_INTERVAL_MS', 250, 100);
const TRANSLATION_TEMPERATURE            = getPositiveEnvNumber('PICKLE_TRANSLATE_TEMPERATURE', 0.1, 0);
const TRANSLATION_MAX_TOKENS             = getPositiveEnvNumber('PICKLE_TRANSLATE_MAX_TOKENS', 1024, 64);
const SEGMENT_GAP_RESET_MS               = getPositiveEnvNumber('PICKLE_TRANSLATE_SEGMENT_GAP_MS', 4000, 500);
const PARTIAL_MIN_CHARS                  = getPositiveEnvNumber('PICKLE_TRANSLATE_MIN_PARTIAL_CHARS', 4, 1);
const CONTEXT_TURNS                      = getPositiveEnvNumber('PICKLE_TRANSLATE_CONTEXT_TURNS', 2, 0);
const MAX_BUFFER_CHARS                   = getPositiveEnvNumber('PICKLE_TRANSLATE_MAX_BUFFER_CHARS', 250, 80);

const TRANSLATE_LLM_PROVIDER = 'openrouter';
const TRANSLATE_LLM_MODEL    = 'google/gemini-2.5-flash-lite';
const TRANSLATE_STT_MODEL    = process.env.PICKLE_TRANSLATE_WHISPER_MODEL || 'whisper-base';
const MISSING_KEY_ERROR      = 'Live translate requires an OpenRouter API key. Add it in Settings.';
const MISSING_KEY_STATUS     = 'No OpenRouter key. Open Settings → API Keys → OpenRouter.';

const ABORT_REASON_NEWER_CHUNK = 'newer-chunk';
const ABORT_REASON_SESSION_CLOSED = 'session-closed';

class TranslateService {
    constructor() {
        this.sttService = new SttService({
            rendererWindowName: 'translate',
            updateChannel: 'translate:transcript-update',
            systemAudioChannel: 'translate:system-audio-data',
            enabledSpeakers: ['Them'],
            completionDebounceMs: TRANSLATION_COMPLETION_DEBOUNCE_MS,
            maxCompletionBufferChars: MAX_BUFFER_CHARS,
            readyStatusText: 'Listening for English...',
            respectLanguageEnv: false,
            modelInfoOverride: {
                provider: 'whisper',
                model: TRANSLATE_STT_MODEL,
                apiKey: 'local',
            },
            providerOptions: {
                whisperMode: 'server',
                whisperLanguage: 'en',
                chunkSeconds: TRANSLATE_WHISPER_CHUNK_SECONDS,
                processingIntervalMs: TRANSLATE_WHISPER_INTERVAL_MS,
            },
        });

        this.isInitializingSession = false;
        this.activeSegment = null;
        this.sessionAbortController = null;
        this.recentTurns = [];

        this.setupServiceCallbacks();
        console.log('[TranslateService] Service instance created.');
    }

    setupServiceCallbacks() {
        this.sttService.setCallbacks({
            onPartialTranscript: (speaker, text) => {
                if (speaker !== 'Them') return;
                this.handlePartial(text);
            },
            onTranscriptionComplete: (speaker, text) => {
                if (speaker !== 'Them') return;
                this.handleFinal(text);
            },
            onStatusUpdate: (status) => {
                this.sendToRenderer('translate:status-update', { status });
            },
        });
    }

    sendToRenderer(channel, data) {
        const { windowPool } = require('../../window/windowManager');
        const translateWindow = windowPool?.get('translate');

        if (translateWindow && !translateWindow.isDestroyed()) {
            translateWindow.webContents.send(channel, data);
        }
    }

    sendToHeader(channel, data) {
        const { windowPool } = require('../../window/windowManager');
        const header = windowPool?.get('header');

        if (header && !header.isDestroyed()) {
            header.webContents.send(channel, data);
        }
    }

    async stopListenForModeSwitch() {
        const { windowPool } = require('../../window/windowManager');
        const listenService = require('../listen/listenService');
        const listenWindow = windowPool?.get('listen');

        if (listenService.isSessionActive()) {
            await listenService.closeSession();
        }

        if (listenWindow && !listenWindow.isDestroyed()) {
            listenWindow.webContents.send('session-state-changed', { isActive: false });
        }

        internalBridge.emit('window:requestVisibility', { name: 'listen', visible: false });
        this.sendToHeader('listen:changeSessionResult', { success: true, status: 'beforeSession' });
    }

    async handleTranslateRequest(translateButtonText) {
        const { windowPool } = require('../../window/windowManager');
        const translateWindow = windowPool.get('translate');

        try {
            switch (translateButtonText) {
                case 'Translate':
                    console.log('[TranslateService] changeSession to "Translate"');
                    await this.stopListenForModeSwitch();
                    internalBridge.emit('window:requestVisibility', { name: 'translate', visible: true });
                    if (!await this.initializeSession()) {
                        throw new Error('Failed to initialize translate session.');
                    }
                    if (translateWindow && !translateWindow.isDestroyed()) {
                        translateWindow.webContents.send('translate:session-state-changed', { isActive: true });
                    }
                    this.sendToHeader('translate:changeSessionResult', { success: true, status: 'inSession' });
                    break;

                case 'Stop':
                    console.log('[TranslateService] changeSession to "Stop"');
                    await this.closeSession();
                    if (translateWindow && !translateWindow.isDestroyed()) {
                        translateWindow.webContents.send('translate:session-state-changed', { isActive: false });
                    }
                    this.sendToHeader('translate:changeSessionResult', { success: true, status: 'afterSession' });
                    break;

                case 'Done':
                    console.log('[TranslateService] changeSession to "Done"');
                    internalBridge.emit('window:requestVisibility', { name: 'translate', visible: false });
                    if (translateWindow && !translateWindow.isDestroyed()) {
                        translateWindow.webContents.send('translate:session-state-changed', { isActive: false });
                    }
                    this.sendToHeader('translate:changeSessionResult', { success: true, status: 'beforeSession' });
                    break;

                default:
                    throw new Error(`[TranslateService] unknown translateButtonText: ${translateButtonText}`);
            }
        } catch (error) {
            console.error('[TranslateService] error in handleTranslateRequest:', error);
            this.sendToHeader('translate:changeSessionResult', { success: false, status: 'beforeSession' });
            throw error;
        }
    }

    async initializeSession(language = 'en') {
        if (this.isInitializingSession) {
            console.log('[TranslateService] Session initialization already in progress.');
            return false;
        }

        this.isInitializingSession = true;
        this.activeSegment = null;
        this.recentTurns = [];
        this.sessionAbortController = new AbortController();
        this.sendToRenderer('translate:status-update', { status: 'Initializing translation...' });

        let initialized = false;
        try {
            await this.sttService.initializeSttSessions(language);
            initialized = true;
            this.sendToRenderer('translate:status-update', { status: 'Listening for English...' });
            return true;
        } catch (error) {
            console.error('[TranslateService] Failed to initialize translate session:', error);
            this.sendToRenderer('translate:status-update', { status: 'Translation initialization failed.' });
            return false;
        } finally {
            this.isInitializingSession = false;
            if (initialized) {
                this.sendToRenderer('change-translate-capture-state', { status: 'start' });
            }
        }
    }

    isSessionAlive() {
        return !!this.sessionAbortController && !this.sessionAbortController.signal.aborted;
    }

    createSegment(initialSourceText) {
        const id = `translation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const segment = {
            id,
            sourceText: initialSourceText || '',
            translation: '',
            lastSentText: '',
            lastUpdateTs: Date.now(),
            isFinal: false,
            abortController: null,
            streamInFlight: false,
            isFinalizing: false,
            previousFullTranslation: '',
        };
        this.activeSegment = segment;

        this.sendToRenderer('translate:translation-update', {
            id: segment.id,
            sourceText: segment.sourceText,
            translation: '',
            isStreaming: true,
            isFinal: false,
        });

        return segment;
    }

    handlePartial(text) {
        if (!this.isSessionAlive()) return;
        const sourceText = String(text || '').trim();
        if (sourceText.length < PARTIAL_MIN_CHARS) return;

        const now = Date.now();
        let segment = this.activeSegment;

        if (!segment || segment.isFinal || segment.isFinalizing || (now - segment.lastUpdateTs) > SEGMENT_GAP_RESET_MS) {
            segment = this.createSegment(sourceText);
        }

        if (sourceText === segment.sourceText) return;

        segment.sourceText = sourceText;
        segment.lastUpdateTs = now;

        // Wait for the current stream to finish before starting a new one — the
        // finally hook in kickoffTranslate will re-run with the updated buffer.
        if (!segment.streamInFlight) {
            this.kickoffTranslate(segment, false);
        }
    }

    handleFinal(text) {
        if (!this.isSessionAlive()) return;
        const sourceText = String(text || '').trim();
        if (!sourceText) return;

        let segment = this.activeSegment;
        if (!segment || segment.isFinal) {
            segment = this.createSegment(sourceText);
        }

        segment.sourceText = sourceText;
        segment.lastUpdateTs = Date.now();
        segment.isFinalizing = true;
        // Final pass force-aborts any in-flight partial and produces the canonical translation.
        this.kickoffTranslate(segment, true);
    }

    kickoffTranslate(segment, isFinalPass) {
        if (segment.abortController && !segment.abortController.signal.aborted) {
            segment.abortController.abort(ABORT_REASON_NEWER_CHUNK);
        }

        const segmentAbort = new AbortController();
        segment.abortController = segmentAbort;

        // Stabilization snapshot is only valid when we're re-translating an
        // EXTENSION of the previous text (text grew from new whisper chunks).
        // If the source shrunk or changed — e.g. handleFinal switched from the
        // full buffer to a smaller front-portion after a hard-cap flush — the
        // old translation no longer applies and would cause a visible "shrink"
        // when the new (correct, shorter) translation completes.
        const oldSrc = segment.lastSentText || '';
        const newSrc = segment.sourceText || '';
        const isExtension = oldSrc.length > 0
            && newSrc.length >= oldSrc.length
            && newSrc.startsWith(oldSrc);
        segment.previousFullTranslation = isExtension ? (segment.translation || '') : '';

        segment.lastSentText = segment.sourceText;
        segment.streamInFlight = true;

        const sessionSignal = this.sessionAbortController?.signal;
        const onSessionAbort = () => segmentAbort.abort(ABORT_REASON_SESSION_CLOSED);
        if (sessionSignal) {
            if (sessionSignal.aborted) {
                segmentAbort.abort(ABORT_REASON_SESSION_CLOSED);
            } else {
                sessionSignal.addEventListener('abort', onSessionAbort, { once: true });
            }
        }

        this.translateActiveSegment(segment, segmentAbort, isFinalPass)
            .catch(error => {
                if (segmentAbort.signal.aborted || segment.abortController !== segmentAbort) return;
                console.error('[TranslateService] Translation pass failed:', error);
                const isMissingKey = error?.message === MISSING_KEY_ERROR;
                const cardFallback = isMissingKey
                    ? 'Додайте OpenRouter ключ у Settings.'
                    : 'Не вдалося перекласти цей фрагмент.';
                this.sendToRenderer('translate:translation-update', {
                    id: segment.id,
                    sourceText: segment.sourceText,
                    translation: segment.translation || cardFallback,
                    isStreaming: false,
                    isFinal: true,
                    error: error.message,
                });
                this.sendToRenderer('translate:status-update', {
                    status: isMissingKey ? MISSING_KEY_STATUS : 'Translation failed.',
                });
                if (this.activeSegment === segment && segment.abortController === segmentAbort) this.activeSegment = null;
            })
            .finally(() => {
                if (sessionSignal) sessionSignal.removeEventListener('abort', onSessionAbort);
                if (segment.abortController !== segmentAbort) return;
                segment.streamInFlight = false;
                // If new whisper text accumulated while we were streaming and the
                // segment is still active, run another pass with the updated buffer.
                if (!segmentAbort.signal.aborted
                    && !segment.isFinal
                    && this.activeSegment === segment
                    && segment.sourceText !== segment.lastSentText) {
                    this.kickoffTranslate(segment, false);
                }
            });
    }

    buildTranslationMessages(sourceText) {
        const messages = [
            {
                role: 'system',
                content: [
                    'You are a fast, precise English-to-Ukrainian interpreter for live captions.',
                    'Translate the user text into natural Ukrainian.',
                    'Output only the Ukrainian translation. No prefaces, no notes, no transliteration.',
                    'Preserve names, numbers, code identifiers, commands, currencies, URLs and product names verbatim.',
                    'If the text is incomplete or cuts off mid-sentence, translate exactly what is given without inventing missing words.',
                    'If the input is already Ukrainian or another non-English language, output it unchanged.',
                ].join(' '),
            },
        ];

        if (CONTEXT_TURNS > 0 && this.recentTurns.length > 0) {
            const contextLines = this.recentTurns
                .map((turn, idx) => `[${idx + 1}] EN: ${turn.en}\n    UK: ${turn.uk}`)
                .join('\n');
            messages.push({
                role: 'system',
                content:
                    'Recent conversation context (already translated, do NOT re-translate, only use to disambiguate the new input):\n' +
                    contextLines,
            });
        }

        messages.push({ role: 'user', content: sourceText });
        return messages;
    }

    async translateActiveSegment(segment, segmentAbort, isFinalPass) {
        const apiKeys = await modelStateService.getAllApiKeys();
        const apiKey = apiKeys?.[TRANSLATE_LLM_PROVIDER];
        if (!apiKey) {
            throw new Error(MISSING_KEY_ERROR);
        }

        if (segmentAbort.signal.aborted) return;
        this.sendToRenderer('translate:status-update', { status: isFinalPass ? 'Finalizing translation...' : 'Translating...' });

        const streamingLLM = createStreamingLLM(TRANSLATE_LLM_PROVIDER, {
            apiKey,
            model: TRANSLATE_LLM_MODEL,
            temperature: TRANSLATION_TEMPERATURE,
            maxTokens: TRANSLATION_MAX_TOKENS,
        });

        const sourceTextForRequest = segment.sourceText;
        const response = await streamingLLM.streamChat(this.buildTranslationMessages(sourceTextForRequest));
        if (segmentAbort.signal.aborted) {
            try { await response.body?.cancel?.(segmentAbort.signal.reason); } catch {}
            return;
        }

        const reader = response.body.getReader();
        segmentAbort.signal.addEventListener('abort', () => {
            reader.cancel(segmentAbort.signal.reason).catch(() => {});
        }, { once: true });

        await this.processTranslationStream(reader, segment, segmentAbort, isFinalPass, sourceTextForRequest);
    }

    async processTranslationStream(reader, segment, segmentAbort, isFinalPass, sourceTextForRequest) {
        const decoder = new TextDecoder();
        let pending = '';
        let fullTranslation = '';

        const emit = (translation, isFinal) => {
            const trimmed = translation.trimStart();
            const previous = segment.previousFullTranslation || '';
            // While a fresh stream is shorter than the last fully-rendered text,
            // hold the previous text on-screen — avoids a flash of "almost empty"
            // card when chunks arrive faster than the LLM finishes a generation.
            const display = (!isFinal && trimmed.length < previous.length) ? previous : trimmed;
            this.sendToRenderer('translate:translation-update', {
                id: segment.id,
                sourceText: sourceTextForRequest,
                translation: display,
                isStreaming: !isFinal,
                isFinal,
            });
        };

        try {
            while (true) {
                if (segmentAbort.signal.aborted) return;

                const { done, value } = await reader.read();
                if (done) break;

                pending += decoder.decode(value, { stream: true });
                const lines = pending.split('\n');
                pending = lines.pop() || '';

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (!trimmedLine.startsWith('data: ')) continue;

                    const data = trimmedLine.substring(6);
                    if (data === '[DONE]') {
                        this.finalizeSegment(segment, fullTranslation, isFinalPass, sourceTextForRequest);
                        return;
                    }

                    try {
                        const json = JSON.parse(data);
                        const token = json.choices?.[0]?.delta?.content || '';
                        if (!token) continue;

                        fullTranslation += token;
                        if (this.activeSegment === segment && !segmentAbort.signal.aborted) {
                            segment.translation = fullTranslation;
                            emit(fullTranslation, false);
                        }
                    } catch {
                        // Ignore malformed provider keep-alive lines.
                    }
                }
            }

            this.finalizeSegment(segment, fullTranslation, isFinalPass, sourceTextForRequest);
        } catch (error) {
            if (segmentAbort.signal.aborted) return;
            throw error;
        }
    }

    finalizeSegment(segment, translation, isFinalPass, sourceTextForRequest) {
        const trimmed = String(translation || '').trim();
        const wasActive = this.activeSegment === segment;
        if (wasActive) {
            segment.translation = trimmed;
            segment.previousFullTranslation = '';
            if (isFinalPass) {
                segment.isFinal = true;
                segment.isFinalizing = false;
                this.activeSegment = null;
            }
        }

        this.sendToRenderer('translate:translation-update', {
            id: segment.id,
            sourceText: sourceTextForRequest,
            translation: trimmed,
            isStreaming: !isFinalPass,
            isFinal: isFinalPass,
        });

        if (isFinalPass) {
            segment.isFinal = true;
            segment.isFinalizing = false;
            if (trimmed && sourceTextForRequest) {
                this.recentTurns.push({ en: sourceTextForRequest, uk: trimmed });
                while (this.recentTurns.length > CONTEXT_TURNS) {
                    this.recentTurns.shift();
                }
            }
            this.sendToRenderer('translate:status-update', { status: 'Listening for English...' });
        }
    }

    async sendSystemAudioContent(data, mimeType) {
        return await this.sttService.sendSystemAudioContent(data, mimeType);
    }

    async startMacOSAudioCapture() {
        if (process.platform !== 'darwin') {
            throw new Error('macOS audio capture only available on macOS');
        }
        return await this.sttService.startMacOSAudioCapture();
    }

    stopMacOSAudioCapture() {
        this.sttService.stopMacOSAudioCapture();
    }

    isSessionActive() {
        return this.sttService.isSessionActive();
    }

    async closeSession() {
        try {
            this.sendToRenderer('change-translate-capture-state', { status: 'stop' });

            // sttService.closeSessions flushes pending whisper buffer first,
            // which fires onTranscriptionComplete → handleFinal → kicks off a
            // final LLM pass for the last ~1-2 unfinished sentences. We then
            // give that stream a brief window to complete before tearing down.
            await this.sttService.closeSessions();

            const waitStart = Date.now();
            while (this.activeSegment?.streamInFlight && Date.now() - waitStart < 5000) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // Hard-abort whatever didn't finish in time.
            if (this.sessionAbortController) {
                this.sessionAbortController.abort(ABORT_REASON_SESSION_CLOSED);
                this.sessionAbortController = null;
            }
            if (this.activeSegment?.abortController && !this.activeSegment.abortController.signal.aborted) {
                this.activeSegment.abortController.abort(ABORT_REASON_SESSION_CLOSED);
            }
            this.activeSegment = null;
            this.recentTurns = [];
            this.sendToRenderer('translate:status-update', { status: 'Stopped.' });
            console.log('[TranslateService] Translate service session closed.');
            return { success: true };
        } catch (error) {
            console.error('[TranslateService] Error closing translate session:', error);
            return { success: false, error: error.message };
        }
    }

    async stopForModeSwitch() {
        const { windowPool } = require('../../window/windowManager');
        const translateWindow = windowPool?.get('translate');

        if (this.isSessionActive()) {
            await this.closeSession();
        }

        if (translateWindow && !translateWindow.isDestroyed()) {
            translateWindow.webContents.send('translate:session-state-changed', { isActive: false });
        }

        internalBridge.emit('window:requestVisibility', { name: 'translate', visible: false });
        this.sendToHeader('translate:changeSessionResult', { success: true, status: 'beforeSession' });
    }

    _createHandler(asyncFn, successMessage, errorMessage) {
        return async (...args) => {
            try {
                const result = await asyncFn.apply(this, args);
                if (successMessage) console.log(successMessage);
                return result && typeof result.success !== 'undefined' ? result : { success: true };
            } catch (error) {
                console.error(errorMessage, error);
                return { success: false, error: error.message };
            }
        };
    }

    handleSendSystemAudioContent = this._createHandler(
        this.sendSystemAudioContent,
        null,
        '[TranslateService] Error sending system audio:'
    );

    handleStartMacosAudio = this._createHandler(
        async () => {
            if (process.platform !== 'darwin') {
                return { success: false, error: 'macOS audio capture only available on macOS' };
            }
            if (this.sttService.isMacOSAudioRunning?.()) {
                return { success: false, error: 'already_running' };
            }
            await this.startMacOSAudioCapture();
            return { success: true, error: null };
        },
        'Translate macOS audio capture started.',
        '[TranslateService] Error starting macOS audio capture:'
    );

    handleStopMacosAudio = this._createHandler(
        this.stopMacOSAudioCapture,
        'Translate macOS audio capture stopped.',
        '[TranslateService] Error stopping macOS audio capture:'
    );
}

const translateService = new TranslateService();
module.exports = translateService;
