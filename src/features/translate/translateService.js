const SttService = require('../listen/stt/sttService');
const { createStreamingLLM } = require('../common/ai/factory');
const modelStateService = require('../common/services/modelStateService');
const internalBridge = require('../../bridge/internalBridge');

function getPositiveEnvNumber(name, fallback, min = 0) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= min ? value : fallback;
}

const TRANSLATION_COMPLETION_DEBOUNCE_MS = getPositiveEnvNumber('PICKLE_TRANSLATE_DEBOUNCE_MS', 2000, 50);
const TRANSLATION_TEMPERATURE            = getPositiveEnvNumber('PICKLE_TRANSLATE_TEMPERATURE', 0.1, 0);
const TRANSLATION_MAX_TOKENS             = getPositiveEnvNumber('PICKLE_TRANSLATE_MAX_TOKENS', 1024, 64);
const SEGMENT_GAP_RESET_MS               = getPositiveEnvNumber('PICKLE_TRANSLATE_SEGMENT_GAP_MS', 4000, 500);
const PARTIAL_MIN_CHARS                  = getPositiveEnvNumber('PICKLE_TRANSLATE_MIN_PARTIAL_CHARS', 4, 1);
const CONTEXT_TURNS                      = getPositiveEnvNumber('PICKLE_TRANSLATE_CONTEXT_TURNS', 4, 0);
const MIN_PARTIAL_GROWTH_CHARS           = getPositiveEnvNumber('PICKLE_TRANSLATE_MIN_PARTIAL_GROWTH_CHARS', 30, 0);

// STT and translation are deliberately two different providers with two different
// keys: Deepgram streams interim results over a websocket (~1s to first card),
// OpenRouter has no streaming STT and is chunk-bound (~6s). The openrouter STT path
// stays available as a Translate Engine for A/B tests on live audio.
// Soniox can also translate in the same socket: its native engine skips the LLM
// stage entirely. Configurations are listed in CLAUDE.md.
const TRANSLATE_LLM_PROVIDER = 'openrouter';
const TRANSLATE_LLM_MODEL = process.env.PICKLE_TRANSLATE_LLM_MODEL || 'google/gemini-2.5-flash';
const TRANSLATE_STT_CHUNK_SECONDS = getPositiveEnvNumber('PICKLE_TRANSLATE_STT_CHUNK_SECONDS', 5, 1);
const NATIVE_TRANSLATION_TIMEOUT_MS = getPositiveEnvNumber('PICKLE_TRANSLATE_NATIVE_TIMEOUT_MS', 5000, 100);

// Picked in Settings → Translate Engine, stored as `translateEngine` in
// settingsService, read at every session start. The ids double as the engine
// field of the [TranslateAB] log lines.
const TRANSLATE_ENGINES = {
    'deepgram+llm':   { stt: 'deepgram',   native: false },
    'soniox+llm':     { stt: 'soniox',     native: false },
    'soniox-native':  { stt: 'soniox',     native: true },
    'openrouter+llm': { stt: 'openrouter', native: false },
};
const DEFAULT_TRANSLATE_ENGINE = 'deepgram+llm';
const STT_PROVIDER_LABELS = { deepgram: 'Deepgram', openrouter: 'OpenRouter', soniox: 'Soniox' };
const STT_MODELS = { deepgram: 'nova-3', openrouter: 'google/gemini-2.5-flash', soniox: 'stt-rt-v5' };

function describeEngine(id) {
    const { stt, native } = TRANSLATE_ENGINES[id];
    const sttLabel = STT_PROVIDER_LABELS[stt];
    return {
        id,
        stt,
        native,
        sttModel: STT_MODELS[stt],
        // What an A/B run is looking at: Settings list, header label.
        label: native ? `${sttLabel} native` : `${sttLabel} + ${TRANSLATE_LLM_MODEL.split('/').pop()}`,
        missingSttKeyStatus: `No ${sttLabel} key. Open Settings → API Keys → ${sttLabel}.`,
    };
}

const MISSING_KEY_ERROR   = 'Live translate requires an OpenRouter API key. Add it in Settings.';
const MISSING_KEY_STATUS  = 'No OpenRouter key. Open Settings → API Keys → OpenRouter.';

const ABORT_REASON_NEWER_CHUNK = 'newer-chunk';
const ABORT_REASON_SESSION_CLOSED = 'session-closed';

const TRANSLATION_SYSTEM_PROMPT = [
    'You are a professional simultaneous interpreter rendering live English speech into Ukrainian subtitles.',
    '',
    'Rules:',
    '- Output ONLY the Ukrainian translation. No prefaces, no notes, no explanations, no transliteration, no surrounding quotes.',
    '- Translate meaning, not words. Never copy English word order or English grammatical structure. The result must read as if a Ukrainian speaker said it.',
    '- Avoid calques and anglicisms where a normal Ukrainian word exists. Prefer active voice and drop redundant pronouns.',
    "- Preserve the speaker's register: casual speech stays casual, technical speech stays technical. Do not formalize filler-heavy speech into bureaucratic Ukrainian.",
    '- Keep verbatim: personal and product names, numbers, currencies, URLs, file paths, code identifiers, CLI commands, and English tech terms Ukrainian speakers normally leave untranslated (deploy, pull request, backend).',
    '- The input is a live caption and may start or end mid-sentence. Translate exactly what is given. Never invent, complete or summarize.',
    '- If the input is already Ukrainian or another non-English language, output it unchanged.',
].join('\n');

// Static few-shot pairs — the strongest lever on register for a mid-tier model, and
// constant so the whole prompt prefix stays cacheable. Each targets a specific trap:
// idiomatic filler, "does that make sense", hedging, and a mid-sentence fragment.
const TRANSLATION_FEW_SHOT = [
    { role: 'user',      content: "So we're gonna go ahead and ship this on Friday, does that make sense?" },
    { role: 'assistant', content: "Тож ми викотимо це в п'ятницю, зрозуміло?" },
    { role: 'user',      content: 'Let me just share my screen real quick.' },
    { role: 'assistant', content: 'Зараз швидко покажу екран.' },
    { role: 'user',      content: "I mean, it's not a big deal, but it would be nice to have." },
    { role: 'assistant', content: 'Ну, це не критично, але було б непогано мати.' },
    { role: 'user',      content: 'and then the backend just kind of' },
    { role: 'assistant', content: 'а потім бекенд просто якось' },
];

// Deepgram's smart_format rewrites an unformatted interim ("ship this on friday")
// into a punctuated final ("Ship this on Friday."), which a raw startsWith would
// read as a different string. Compare on letters/digits only so a genuine
// continuation still counts as one, while a real shrink (hard-cap flush handing
// back only the front portion) is still rejected.
const normalizeForPrefix = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function isSourceExtension(oldSrc, newSrc) {
    const previous = normalizeForPrefix(oldSrc);
    const next = normalizeForPrefix(newSrc);
    return previous.length > 0 && next.length >= previous.length && next.startsWith(previous);
}

const newFragmentId = () => `translation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

class TranslateService {
    constructor() {
        this.engine = describeEngine(DEFAULT_TRANSLATE_ENGINE);
        this.sttService = new SttService({
            rendererWindowName: 'translate',
            updateChannel: 'translate:transcript-update',
            systemAudioChannel: 'translate:system-audio-data',
            enabledSpeakers: ['Them'],
            completionDebounceMs: TRANSLATION_COMPLETION_DEBOUNCE_MS,
            readyStatusText: 'Listening for English...',
            respectLanguageEnv: false,
            // Both resolved at session start, from the engine picked for that session,
            // so a key or an engine changed in Settings mid-run is picked up next time.
            modelInfoOverride: async () => {
                const { stt, sttModel, missingSttKeyStatus } = this.engine;
                const apiKey = (await modelStateService.getAllApiKeys())?.[stt];
                if (!apiKey) throw new Error(missingSttKeyStatus);
                return { provider: stt, model: sttModel, apiKey };
            },
            providerOptions: () => ({
                language: 'en',
                chunkSeconds: TRANSLATE_STT_CHUNK_SECONDS,
                // Without translation Soniox freezes text in ~2 s windows, ~4 s late and
                // cut mid-word; with it, final original tokens come as clause-sized units
                // ~0.7 s after the clause ends. Translation costs nothing extra, so both
                // Soniox engines turn it on; soniox+llm just ignores the translation tokens.
                ...(this.engine.stt === 'soniox'
                    ? { translation: { type: 'one_way', target_language: 'uk' } }
                    : {}),
            }),
        });

        this.isInitializingSession = false;
        this.activeSegment = null;
        // Every segment with a pass in flight, not just the active one: back-to-back
        // commits leave the earlier one still finalizing, and Stop must wait for it.
        this.streamingSegments = new Set();
        this.sessionAbortController = null;
        this.recentTurns = [];
        this.nativeFragment = null;
        this.resetAbLog();

        this.setupServiceCallbacks();
        console.log('[TranslateService] Service instance created.');
    }

    setupServiceCallbacks() {
        this.sttService.setCallbacks({
            onStreamSegment: (speaker, text, isCommitted) => {
                if (speaker !== 'Them' || this.engine.native) return;
                if (isCommitted) this.handleCommit(text);
                else this.handleDraft(text);
            },
            onStreamTranslation: (speaker, update) => {
                if (speaker === 'Them' && this.engine.native) this.handleNativeUpdate(update);
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
                        translateWindow.webContents.send('translate:session-state-changed', { isActive: true, engineLabel: this.engine.label });
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
        clearTimeout(this.nativeFragment?.timer);
        this.nativeFragment = null;
        this.resetAbLog();
        this.sessionAbortController = new AbortController();
        this.sendToRenderer('translate:status-update', { status: 'Initializing translation...' });

        let initialized = false;
        try {
            // Fixed for the whole session: a change in Settings applies from the next start.
            this.engine = describeEngine(await this.getSelectedEngineId());
            console.log(`[TranslateService] Engine: ${this.engine.id} (${this.engine.label})`);
            await this.sttService.initializeSttSessions(language);
            initialized = true;
            this.sendToRenderer('translate:status-update', { status: 'Listening for English...' });
            return true;
        } catch (error) {
            console.error('[TranslateService] Failed to initialize translate session:', error);
            const status = error?.message === this.engine.missingSttKeyStatus
                ? this.engine.missingSttKeyStatus
                : 'Translation initialization failed.';
            this.sendToRenderer('translate:status-update', { status });
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

    // ── Engine choice (Settings → Translate Engine) ─────────────────────────────
    // settingsService is required lazily: it pulls in windowManager at load time.
    async getSelectedEngineId() {
        const { translateEngine } = await require('../settings/settingsService').getSettings();
        if (Object.hasOwn(TRANSLATE_ENGINES, translateEngine)) return translateEngine;
        if (translateEngine) console.warn(`[TranslateService] Unknown stored translate engine "${translateEngine}", using ${DEFAULT_TRANSLATE_ENGINE}.`);
        return DEFAULT_TRANSLATE_ENGINE;
    }

    async getEngineOptions() {
        return {
            engines: Object.keys(TRANSLATE_ENGINES).map(id => ({ id, name: describeEngine(id).label })),
            selected: await this.getSelectedEngineId(),
        };
    }

    async setEngine(engineId) {
        if (!Object.hasOwn(TRANSLATE_ENGINES, engineId)) {
            return { success: false, error: `Unknown translate engine "${engineId}".` };
        }
        const result = await require('../settings/settingsService').saveSettings({ translateEngine: engineId });
        if (result?.success) console.log(`[TranslateService] Translate engine set to ${engineId}; applies from the next session.`);
        return result;
    }

    createSegment(initialSourceText) {
        const id = newFragmentId();
        const segment = {
            id,
            sourceText: initialSourceText || '',
            translation: '',
            lastSentText: '',
            lastUpdateTs: Date.now(),
            createdTs: Date.now(),
            firstUkTs: 0,
            isFinal: false,
            abortController: null,
            streamInFlight: false,
            isFinalizing: false,
            previousFullTranslation: '',
        };
        this.reserveSessionSlot(segment);
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

    // The draft tail is re-translated from scratch on every pass, so without a
    // growth gate Deepgram's ~150 ms interims would start a fresh pass as fast as
    // the LLM can finish one. The first pass of a segment is never gated, so
    // time-to-first-text is unaffected.
    shouldRetranslate(segment) {
        if (segment.streamInFlight) return false;
        if (segment.sourceText === segment.lastSentText) return false;
        if (!segment.lastSentText) return true;
        return segment.sourceText.length - segment.lastSentText.length >= MIN_PARTIAL_GROWTH_CHARS;
    }

    // Revisable text: the tail the provider has not frozen yet. Its translation is
    // allowed to churn — it is rendered as the dim tail and nothing downstream
    // treats it as settled.
    handleDraft(text) {
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

        if (this.shouldRetranslate(segment)) {
            this.kickoffTranslate(segment, false);
        }
    }

    // Frozen text: the provider will never revise this range. Whatever we render
    // for it now stays on screen for the rest of the session, so this is the only
    // place a translation becomes permanent.
    handleCommit(text) {
        if (!this.isSessionAlive()) return;
        const sourceText = String(text || '').trim();
        if (!sourceText) return;

        // A finalizing segment already belongs to the previous commit: reusing it
        // would replace that clause's text and abort its translation.
        let segment = this.activeSegment;
        if (!segment || segment.isFinal || segment.isFinalizing) {
            segment = this.createSegment(sourceText);
        }

        // The commit usually only re-punctuates the interim the draft already
        // translated. Freezing that translation as-is costs no request and, more
        // importantly, spares the reader a re-word at the moment of commit.
        if (!segment.streamInFlight
            && segment.translation
            && normalizeForPrefix(segment.lastSentText) === normalizeForPrefix(sourceText)) {
            segment.sourceText = sourceText;
            this.finalizeSegment(segment, segment.translation, true, sourceText);
            return;
        }

        segment.sourceText = sourceText;
        segment.lastUpdateTs = Date.now();
        segment.isFinalizing = true;
        // Force-aborts any in-flight draft and produces the permanent translation.
        this.kickoffTranslate(segment, true);
    }

    kickoffTranslate(segment, isFinalPass) {
        if (segment.abortController && !segment.abortController.signal.aborted) {
            segment.abortController.abort(ABORT_REASON_NEWER_CHUNK);
        }

        const segmentAbort = new AbortController();
        segment.abortController = segmentAbort;

        // Stabilization snapshot is only valid when we're re-translating an
        // EXTENSION of the previous text (text grew from new STT results).
        // If the source shrunk or changed — e.g. the commit corrected a word the
        // draft had mis-heard — the old translation no longer applies and would
        // cause a visible "shrink" when the new translation completes.
        const isExtension = isSourceExtension(segment.lastSentText, segment.sourceText);
        segment.previousFullTranslation = isExtension ? (segment.translation || '') : '';

        segment.lastSentText = segment.sourceText;
        segment.streamInFlight = true;
        this.streamingSegments.add(segment);

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
                this.streamingSegments.delete(segment);
                // If new STT text accumulated while we were streaming and the
                // segment is still active, run another pass with the updated buffer.
                if (!segmentAbort.signal.aborted
                    && !segment.isFinal
                    && this.activeSegment === segment
                    && this.shouldRetranslate(segment)) {
                    this.kickoffTranslate(segment, false);
                }
            });
    }

    buildTranslationMessages(sourceText) {
        const messages = [
            { role: 'system', content: TRANSLATION_SYSTEM_PROMPT },
            ...TRANSLATION_FEW_SHOT,
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
            if (display && !segment.firstUkTs) segment.firstUkTs = Date.now();
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
                        if (segmentAbort.signal.aborted) return;
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

            // reader.cancel() on abort resolves read() as done, so re-check here:
            // a stale pass must not clobber segment.translation or wipe the
            // stabilization snapshot the newer pass just installed.
            if (segmentAbort.signal.aborted) return;
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
                // Final passes can finish out of speech order (back-to-back commits,
                // the later one shorter), so insert by segment order, not append.
                const turn = { en: sourceTextForRequest, uk: trimmed, seq: segment.seq };
                const later = this.recentTurns.findIndex(t => t.seq > turn.seq);
                this.recentTurns.splice(later === -1 ? this.recentTurns.length : later, 0, turn);
                while (this.recentTurns.length > CONTEXT_TURNS) {
                    this.recentTurns.shift();
                }
            }
            if (trimmed && !segment.firstUkTs) segment.firstUkTs = Date.now();
            this.logCommittedFragment(sourceTextForRequest, trimmed, segment);
            this.sendToRenderer('translate:status-update', { status: 'Listening for English...' });
        }
    }

    // ── Native engine: Soniox translates in the same socket, no LLM ─────────────
    // A fragment is one Soniox unit: a run of final original tokens plus the run of
    // final translation tokens that follows it. Translation trails the original,
    // so a fragment stays open until every original run it holds has its
    // translation. Strict O→T alternation is what Soniox did in testing, not a
    // contract: a second original run arriving first joins the open fragment
    // (pendingUnits counts the translations still owed), and a timeout closes a
    // fragment whose translation never comes. Every deviation is counted and
    // logged on Stop.
    handleNativeUpdate({ finals, draftOriginal, draftTranslation }) {
        if (!this.isSessionAlive()) return;

        const runs = [];
        for (const { text, status } of finals) {
            if (status !== 'original' && status !== 'translation') continue;
            const last = runs[runs.length - 1];
            if (last && last.status === status) last.text += text;
            else runs.push({ status, text });
        }

        for (const run of runs) {
            const fragment = this.nativeFragment || this.createNativeFragment();
            if (run.status === 'original') {
                if (fragment.pendingUnits > 0) this.nativeViolations.clauseBeforeTranslation++;
                fragment.en += run.text;
                fragment.pendingUnits++;
                fragment.timer ||= setTimeout(() => this.handleNativeTimeout(fragment), NATIVE_TRANSLATION_TIMEOUT_MS);
            } else {
                // ponytail: a translation with nothing owed (split run, or late after a
                // timeout) becomes its own fragment with no source text. Fine as long as
                // the counter stays at 0; attribute it to the previous fragment if not.
                if (fragment.pendingUnits === 0) this.nativeViolations.orphanTranslation++;
                fragment.uk += run.text;
                fragment.pendingUnits = Math.max(0, fragment.pendingUnits - 1);
                if (fragment.pendingUnits === 0) this.closeNativeFragment();
            }
        }

        // Non-final tokens are the whole current tail, so they replace, never append.
        let fragment = this.nativeFragment;
        if (!fragment && (draftOriginal.trim() || draftTranslation.trim())) fragment = this.createNativeFragment();
        if (!fragment) return;
        fragment.draftEn = draftOriginal;
        fragment.draftUk = draftTranslation;
        this.emitNativeFragment(fragment, false);
    }

    createNativeFragment() {
        this.nativeFragment = {
            id: newFragmentId(),
            en: '',
            uk: '',
            draftEn: '',
            draftUk: '',
            pendingUnits: 0,
            timer: null,
            createdTs: Date.now(),
            firstUkTs: 0,
        };
        this.reserveSessionSlot(this.nativeFragment);
        return this.nativeFragment;
    }

    emitNativeFragment(fragment, isFinal) {
        const translation = (isFinal ? fragment.uk : fragment.uk + fragment.draftUk).trim();
        if (translation && !fragment.firstUkTs) fragment.firstUkTs = Date.now();
        this.sendToRenderer('translate:translation-update', {
            id: fragment.id,
            sourceText: (isFinal ? fragment.en : fragment.en + fragment.draftEn).trim(),
            translation,
            isStreaming: !isFinal,
            isFinal,
        });
    }

    closeNativeFragment() {
        const fragment = this.nativeFragment;
        if (!fragment) return;
        clearTimeout(fragment.timer);
        this.nativeFragment = null;
        this.emitNativeFragment(fragment, true);
        this.logCommittedFragment(fragment.en.trim(), fragment.uk.trim(), fragment);
    }

    handleNativeTimeout(fragment) {
        if (this.nativeFragment !== fragment) return;
        this.nativeViolations.timeout++;
        console.warn(`[TranslateService] No Soniox translation within ${NATIVE_TRANSLATION_TIMEOUT_MS} ms, closing the fragment as is.`);
        this.closeNativeFragment();
    }

    // ── A/B logging ─────────────────────────────────────────────────────────────
    resetAbLog() {
        this.sessionSlots = [];
        this.nativeViolations = { clauseBeforeTranslation: 0, orphanTranslation: 0, timeout: 0 };
    }

    // The session summary is in speech order: each fragment takes its place when
    // it is created and fills it when it freezes, which for LLM passes can happen
    // out of order. `seq` orders recentTurns the same way.
    reserveSessionSlot(fragment) {
        fragment.sessionSlot = { en: '', uk: '' };
        fragment.seq = this.sessionSlots.push(fragment.sessionSlot);
    }

    // One line per frozen fragment in every engine, so the same audio run through
    // each configuration can be compared side by side. firstUkMs = from the
    // fragment's first English text to its first Ukrainian text on screen.
    logCommittedFragment(sourceText, translation, fragment) {
        if (!sourceText && !translation) return;
        fragment.sessionSlot.en = sourceText;
        fragment.sessionSlot.uk = translation;
        const firstUk = fragment.firstUkTs ? ` firstUkMs=${fragment.firstUkTs - fragment.createdTs}` : '';
        console.log(`[TranslateAB] engine=${this.engine.id}${firstUk} EN=${JSON.stringify(sourceText)} UK=${JSON.stringify(translation)}`);
    }

    // Fragment boundaries differ between engines, so the comparison with
    // Deepgram is done on whole-session text.
    logSessionSummary() {
        const join = key => JSON.stringify(this.sessionSlots.map(slot => slot[key]).filter(Boolean).join(' '));
        console.log(`[TranslateAB-session] engine=${this.engine.id} EN=${join('en')} UK=${join('uk')}`);
        if (this.engine.native) {
            const v = this.nativeViolations;
            console.log(`[TranslateAB-native] alternation violations: clauseBeforeTranslation=${v.clauseBeforeTranslation} orphanTranslation=${v.orphanTranslation} timeout=${v.timeout}`);
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

            // Soniox freezes the trailing interim itself: its close() sends
            // `finalize`, and the last final tokens are handled while closeSessions()
            // is awaited. Deepgram's and OpenRouter's close() flush nothing, so for
            // them committing the leftover after closeSessions() is the same as
            // before it. What must not move is commit-before-abort below:
            // aborting first drops the last words spoken.
            await this.sttService.closeSessions();

            if (this.engine.native) {
                // Only left open if finalize timed out: keep the words, even untranslated.
                const open = this.nativeFragment;
                if (open) {
                    open.en += open.draftEn;
                    open.uk += open.draftUk;
                    this.closeNativeFragment();
                }
            } else {
                // Stopping mid-sentence means the provider never got to freeze the
                // last interim, so commit it ourselves. Everything before it is
                // already committed chunk by chunk.
                const pending = this.activeSegment;
                if (pending && !pending.isFinal && !pending.isFinalizing && pending.sourceText) {
                    console.log(`[TranslateService] Committing trailing draft on stop: ${JSON.stringify(pending.sourceText)}`);
                    this.handleCommit(pending.sourceText);
                }
            }

            const waitStart = Date.now();
            while (this.streamingSegments.size > 0 && Date.now() - waitStart < 5000) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            this.logSessionSummary();

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
