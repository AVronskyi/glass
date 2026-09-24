# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Node.js 20.x is required (native deps will fail otherwise). Windows builds also need Visual Studio Build Tools; macOS/Linux need Python.

- `npm run setup` — full first-time install: root deps + `pickleglass_web` deps + web build + electron start.
- `npm start` — rebuild renderer bundles via esbuild and launch electron.
- `npm run watch:renderer` — esbuild watch mode for the two renderer bundles (`public/build/header.js`, `public/build/content.js`).
- `npm run build:renderer` — one-shot renderer bundle; this is the primary quick validation after renderer/UI changes.
- `npm run build:web` — build the Next.js dashboard (`pickleglass_web`) into `pickleglass_web/out`. Must exist before `npm start` or the app aborts.
- `npm run build:all` — both of the above.
- `npm run build` / `npm run build:win` / `npm run publish` — package via electron-builder (uses `electron-builder.yml`).
- `npm run lint` — eslint over `.ts/.tsx/.js`; this script exists, but may fail in some local setups if the root `eslint` binary is not installed or not resolvable.
- `cd functions && npm run serve` — Firebase Functions local emulator. `npm run deploy` deploys to Firebase. Functions are Node 20 and only needed when working on Firebase mode.

There is no test runner configured in this repo.

Useful targeted checks:
- `node --check src/index.js` — syntax-check the main-process entrypoint.
- `node --check src/features/common/services/authService.js` — syntax-check auth mode changes.
- `node --check src/features/common/services/whisperService.js` — syntax-check local Whisper/STT changes.
- `node --check src/features/common/ai/providers/whisper.js` — syntax-check the Whisper provider/chunk runner.
- `node --check src/features/listen/stt/sttService.js` — syntax-check Listen STT session orchestration and Whisper debounce/filtering.
- `node --check src/preload.js` — syntax-check preload bridge changes.
- `node --check src/features/common/ai/providers/soniox.js` — syntax-check the Soniox websocket provider.
- `node src/features/translate/translateService.selfcheck.js` — Translate's Soniox paths, native fragment rules, back-to-back commits and per-session engine choice. Plain Node, fake LLM, no network.

Launch notes:
- Git Bash uses Bash env syntax: `PICKLE_AUTH_MODE=firebase npm start` or `export PICKLE_AUTH_MODE=firebase`.
- PowerShell uses `$env:PICKLE_AUTH_MODE='firebase'; npm start`.
- If Electron crashes with `app.getPath` undefined, `ELECTRON_RUN_AS_NODE=1` is leaking into the launch environment. Clear it first (`unset ELECTRON_RUN_AS_NODE` in Git Bash, `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue` in PowerShell).

## High-Level Architecture

Glass is an Electron desktop app with three coordinated runtimes:

1. **Electron main process** (`src/index.js`) — owns all data access, AI calls, system integrations, and window management.
2. **Electron renderer** (`src/ui/`) — LitElement-style web components bundled by esbuild into `public/build/{header,content}.js`. Two entry points: `HeaderController.js` (always-on header window) and `PickleGlassApp.js` (content windows like Listen/Ask/Settings).
3. **Local Next.js dashboard** (`pickleglass_web/`) — built statically into `out/`, served by an in-process Express server inside the Electron main process. A second Express server (`pickleglass_web/backend_node/`) exposes the REST API the dashboard calls. Both ports are allocated at runtime in `startWebStack()` and exposed to the frontend via `/runtime-config.json`.

Optional fourth runtime: **Firebase Cloud Functions** (`functions/index.js`) — used only when Firebase mode is explicitly enabled. It currently handles `pickleGlassAuthCallback` (ID-token -> custom-token exchange) referenced from `src/index.js`.

### Core architectural rules (see `docs/DESIGN_PATTERNS.md` for the full version)

These are load-bearing — code that violates them tends to break things subtly:

- **All data access lives in the main process.** Renderer and the Next.js dashboard never touch SQLite or Firestore directly. The dashboard's Node backend reaches the main process via the IPC bridge described below.
- **Service–Repository layering.** Services (`*Service.js`) hold business logic; repositories (`*.repository.js`) are the only modules that talk to `sqliteClient` / `firebaseClient`. Feature-local code lives under `src/features/<feature>/`; shared code under `src/features/common/`.
- **Dual-repository factory.** Every user-data repository has *two* implementations (`sqlite.repository.js` and `firebase.repository.js`) behind an adapter `index.js`. The adapter checks `authService.getCurrentUser()` and routes to Firebase only when Firebase mode is enabled and a user is logged in; local-only mode is the default and routes to SQLite with `default_user`. The adapter injects the `uid` so services never pass user IDs around. Pattern reference: `src/features/common/repositories/session/index.js`. Both implementations must expose identical interfaces.
- **AI provider factory.** All LLM/STT calls go through `src/features/common/ai/factory.js` (`createLLM`, `createStreamingLLM`, `createSTT`). To add a provider, drop a module in `providers/` exposing `createLLM` / `createSTT` / class export, then register it in the `PROVIDERS` map. Provider IDs ending in `-glass` (e.g. `openai-glass`) reuse the underlying provider but are billed/keyed via Glass; `sanitizeModelId` strips the suffix before the provider sees it. The Ask flow sends screenshot context, so OpenRouter LLMs exposed in the UI must support image input; text-only OpenRouter models such as the removed DeepSeek entries should not be listed.
- **Provider completeness.** Setup/startup requires a usable LLM provider and a usable STT provider (`modelStateService.areProvidersConfigured()`). The local STT default is Whisper Local with `whisper-base`. `providers/openrouter.js` **does** implement `createSTT` (chunked audio via `input_audio`, see **Translate feature**), but OpenRouter is deliberately **not** listed in `factory.js` `sttModels`, so it does not satisfy the setup gate and does not appear in the Settings STT picker. Only Translate uses it, via its own `modelInfoOverride`. Adding it to `sttModels` is a one-line change if Listen should get it too — but that also means an OpenRouter key alone would pass setup. `soniox` is registered the same way with **both** lists empty: Settings shows its key field, the first-run screen and the setup gate ignore it (side effect: `hasValidApiKey()`, dashboard status only, is true with a Soniox key alone).
- **Schema single source of truth:** `src/features/common/config/schema.js`. Any SQLite schema change updates this file; the table list is loaded by `databaseInitializer` at boot.
- **Encryption by default for cloud data.** Anything written to Firestore that contains user content (titles, transcripts, summaries, API keys, AI messages) must go through `createEncryptedConverter` (see `firestoreConverter.js` and `encryptionService.js`). The encryption key is bound to the user and initialized via `initialize-encryption-key` IPC.

### Auth modes

Local-only mode is the default. In this mode:
- Firebase is not initialized.
- SQLite repositories are used with `default_user`.
- Users configure personal API keys in Settings.
- Firebase deep links and custom tokens are ignored.
- Any stored `openai-glass` virtual key is cleared during auth initialization.

Firebase mode is opt-in. Enable it with `PICKLE_AUTH_MODE=firebase` (or `PICKLE_AUTH_MODE=cloud`) or `PICKLE_ENABLE_FIREBASE=true` before launching the app. In Firebase mode, `initializeFirebase()` runs, Firebase Auth can sign in users, Firestore-backed repositories are used after login, and `pickleGlassAuthCallback` is used for the web login deep-link flow. The legacy `/virtual_key` path belongs to Firebase mode only and should not be used or revived for local-only mode.

Setting up your own Firebase project (forks):

- The Firebase web config is hardcoded in two places that must stay in sync: `src/features/common/services/firebaseClient.js` and `pickleglass_web/utils/firebase.ts`. Replace both when pointing at a new project.
- The web login page is a static Next.js bundle at `pickleglass_web/out/`. After changing `pickleglass_web/utils/firebase.ts` you **must** run `npm run build:web` — otherwise the browser sign-in flow will mint an ID token from the old project and the Cloud Function will reject it with `aud claim` mismatch.
- The Cloud Function URL is hardcoded in `src/index.js` (in `handleFirebaseAuthCallback`). The function's region is set in `functions/index.js` (`onRequest({region: ...})`). Both must match the URL you put in `src/index.js`.
- `.firebaserc` controls which project `firebase deploy` targets.
- The Firestore database ID is `pickle-glass` (not `(default)`) — when creating a Firestore database in your new project, give it that ID, otherwise change the literal in `firebaseClient.js` `getFirestore(firebaseApp, 'pickle-glass')`.
- **`firebase.json` MUST include `"database": "pickle-glass"` under the `firestore` key.** Without it, `firebase deploy --only firestore:rules` silently deploys rules to the auto-created `(default)` Firestore, and the actual `pickle-glass` database keeps the production-mode default-deny rules — every Firestore call from the app then fails with `Missing or insufficient permissions`.
- `firestore.rules` is required for `firebase deploy --only firestore:rules`. The committed rules restrict each user to their own `users/{uid}` doc, their own `prompt_presets` and `sessions` (filtered by the `uid` field for presets, and `uid` field + `members` array for sessions), and read-only access to seeded `defaults/v1/prompt_presets` templates.
- **Cloud Functions need IAM role `Service Account Token Creator` on the default compute service account** (`<project-number>-compute@developer.gserviceaccount.com`). Without it, `admin.auth().createCustomToken()` inside `pickleGlassAuthCallback` fails with `iam.serviceAccounts.signBlob denied`. Grant it once in GCP Console → IAM, or via `gcloud projects add-iam-policy-binding <project-id> --member="serviceAccount:<project-number>-compute@developer.gserviceaccount.com" --role="roles/iam.serviceAccountTokenCreator"`.
- Cloud Functions v2 (the `firebase-functions/v2/https` import in `functions/index.js`) requires the Firebase project to be on the **Blaze** (pay-as-you-go) plan. Spark won't deploy v2 functions.
- `PICKLE_AUTH_MODE=firebase` should be in a local `.env` file (gitignored) so VSCode tasks and `npm start` pick it up automatically without per-shell exports.
- The virtual-key flow that calls an external `/virtual_key` endpoint is **disabled by default** in this fork. To re-enable (e.g., if you run your own billing backend), set `PICKLE_VIRTUAL_KEY_ENDPOINT=https://your-backend/api/virtual_key` before launch. Without it, Firebase users sign in with their own personal API keys, just like local-only mode.
- **Firebase login does not bypass API-key setup.** `modelStateService.hasValidApiKey()` and `areProvidersConfigured()` check the actual stored keys regardless of login state — there is no `isLoggedInWithFirebase ? true` shortcut. A freshly signed-in Firebase user with no personal LLM/STT keys (and no virtual-key endpoint) lands on the API-key entry screen, not the main UI. `HeaderController.handleStateUpdate` skips the welcome screen for already-logged-in users and goes straight to ApiKeyHeader so the Login-vs-ApiKey choice doesn't loop.
- Firestore rules treat `uid` as immutable on `update` for `prompt_presets` and `sessions` (`request.resource.data.uid == resource.data.uid`). A signed-in user cannot reassign their own preset/session to another user's UID. Don't relax this on `update` without re-checking — `delete` still requires the requester be the current owner.

If user presets appear to be missing, first confirm the auth mode and current user. Local-only mode reads SQLite as `default_user`; Firebase presets are only read when Firebase mode is enabled **and** Firebase Auth restores/logs in a user. A persisted `firebase-auth-session.json` alone is not enough if the app was launched without Firebase mode enabled.

### Web dashboard ↔ main process IPC bridge

The dashboard's Node backend (`pickleglass_web/backend_node/`) cannot read SQLite. When a route needs local data, it calls `ipcRequest(channel, payload)` from `backend_node/ipcBridge.js`. This emits a `web-data-request` event on the shared `EventEmitter` (`eventBridge`) created in `src/index.js`. The handler in `setupWebDataHandlers()` dispatches by channel name (`get-sessions`, `create-preset`, `save-api-key`, etc.) and emits the response on a unique reply channel. Adding a new dashboard endpoint that needs local data means adding a `case` in `setupWebDataHandlers` *and* a route in `backend_node/routes/`.

### Renderer bridges (main ↔ renderer)

`src/bridge/` holds three thin IPC layers:
- `featureBridge.js` — registers `ipcMain.handle(...)` for feature/service calls invoked from the renderer (settings, shortcuts, permissions, auth, whisper, ollama, ask, listen). Initialized once at startup.
- `windowBridge.js` — window lifecycle and layout calls.
- `internalBridge.js` — main-process-only event bus used between services that shouldn't directly require each other (e.g., shortcuts → window manager).

When wiring a new renderer→main capability, add the handler in `featureBridge.initialize()` and expose it through `src/preload.js`.

### Feature surface

- `features/listen/` — real-time STT pipeline. `sttService` streams audio, `summaryService` periodically generates structured summaries from transcripts. Native AEC (echo cancellation) lives in `aec/` (Rust, separates mic vs. system loopback on Windows).
- `features/ask/` — one-shot Q&A with screen-capture context. `askService` orchestrates screenshot + transcript + LLM call. Because screenshots are sent as `image_url` content, selected provider models must support image input or provide a deliberate text-only fallback.
- `features/translate/` — live English→Ukrainian translation of system audio. See **Translate feature** below for details.
- `features/settings/` — model/provider settings, presets. The active preset id is persisted on `users.selected_preset_id`; `settingsService.getSelectedPresetPrompt()` is the consumer-facing accessor that `askService` and `summaryService` call before each LLM request. In `promptBuilder.getSystemPrompt`, a non-empty `userPresetText` **replaces** the profile entirely — it is not layered on top. Default presets (school/sales/meetings/...) are seeded as full role descriptions ("You are a school assistant…") and rely on this replace behaviour, so don't downgrade preset injection back to a sub-section without rewriting the seed data.
- `features/shortcuts/` — global keybinds; coordinates with windowManager via `internalBridge`.
- `features/common/services/` — cross-cutting: `authService`, `modelStateService` (single source of truth for API keys + selected models, exposed as `global.modelStateService`), `ollamaService`, `whisperService`, `localAIManager`, `permissionService`, `encryptionService`, `migrationService`.

### Translate feature

`features/translate/translateService.js` is a singleton that owns its own `SttService` instance (separate from Listen's) configured for English-only system-audio capture: Deepgram streaming STT → per-fragment LLM stream → `translate` content window. **The two stages run on two different providers and need two different keys: Deepgram for STT, OpenRouter for translation.** The split is deliberate — OpenRouter has no streaming STT, and keeping transcription there cost ~6 s before any Ukrainian appeared.

The engine is picked in **Settings → Translate Engine** (Translate's own list; the STT Model list drives Listen only). It is stored as `translateEngine` in `settingsService` (electron-store) and read by `initializeSession()` at every session start, so a running session keeps its engine. Engines (`TRANSLATE_ENGINES` in `translateService.js`, ids double as log ids): `deepgram+llm` (default), `soniox+llm`, `soniox-native` (Soniox transcribes and translates, no LLM), `openrouter+llm` (baseline). There is no env switch. Soniox protocol findings, measurements, design rationale and how to run the A/B comparison: **`docs/TRANSLATE_SONIOX.md`**.

Key invariants:

- **Commit/draft model — the core of the feature.** Each piece of source the provider has *frozen* is translated exactly **once** and never re-translated. `sttService.emitStreamSegment(speaker, text, isCommitted)` carries that single distinction: `isCommitted` means Deepgram sent `is_final` for that time range (or a chunked recogniser finished a chunk) and will never revise it; anything else is a revisable interim. TranslateService splits them into `handleCommit()` and `handleDraft()`. What this buys is the whole point of the feature: settled Ukrainian never re-words itself, and only the dim tail moves. The previous design re-translated the entire growing utterance on every pass, so finished sentences kept being re-generated and visibly rephrased — correct every time, unreadable in motion. Don't go back to it.
- **One on-screen fragment per commit.** A fragment is created by the first draft of a Deepgram segment, updated while it is the tail, and frozen by `handleCommit`. The `segment.id` is the same throughout, so the renderer's upsert-by-id needs no notion of commits at all — an entry with `isFinal: true` is simply never updated again. The Soniox native engine lands on the same shape. **A commit never reuses an `isFinalizing` segment** — it opens a new one, like `handleDraft`; reusing it replaced the previous clause and aborted its translation (back-to-back commits: fast Deepgram finals, several Soniox units flushed on Stop). Several segments can finalize at once; `closeSession()` waits for all of them via `streamingSegments`.
- **A commit can be free.** If the committed text normalizes equal to what the draft already translated (`smart_format` only re-punctuated it) and no stream is in flight, `handleCommit` freezes the draft's translation instead of spending a request — and, more importantly, spares the reader a re-word at the moment of commit. Most commits still run a pass, because interims keep growing past the last gated draft.
- **STT provider comes from the Translate Engine, LLM provider is pinned.** Translate **does not** read `modelStateService.getCurrentModelInfo()` for either stage. The session's engine fixes the STT provider/model and whether the LLM runs; `modelInfoOverride` and `providerOptions` are functions resolved from `this.engine` at session start. `TRANSLATE_LLM_PROVIDER` stays pinned to `openrouter` with `PICKLE_TRANSLATE_LLM_MODEL || 'google/gemini-2.5-flash'`. Settings-side LLM/STT choice affects Listen/Ask but not Translate. Each stage looks up its own key in `modelStateService.getAllApiKeys()` and names the provider that is missing: `No Deepgram key. Open Settings → API Keys → Deepgram.` / `No Soniox key. Open Settings → API Keys → Soniox.` for STT (`engine.missingSttKeyStatus`, built from `STT_PROVIDER_LABELS`), `No OpenRouter key…` for translation (never asked for in the native engine). `initializeSession` matches the STT string by **exact equality** to decide what to show — change the constant and the comparison together, or the status degrades to a generic failure. The `flash-lite` tier was tried first for translation and produced noticeably weaker Ukrainian — don't downgrade the default without re-testing on live audio.
- **Deepgram path (default).** `providers/deepgram.js` opens a websocket to `nova-3` with `interim_results` and `smart_format`, at `linear16` / 24 kHz mono — exactly what `listenCapture.js` sends, so no resampling is involved. In sttService's `deepgram` branch an interim emits `emitStreamSegment('Them', text, false)` carrying **only the interim itself** (everything before it is already committed), while `is_final` emits `emitStreamSegment('Them', text, true)`. `is_final` arrives mid-sentence roughly every 2-4 s, not only at pauses — that is what makes commits frequent enough to read. `speech_final` (silence-triggered, tuned by the `endpointing` query param, default 10 ms) is a separate flag we currently ignore. The `debounceTheirCompletion` call on the same branch only feeds the plain EN caption buffer; Translate does not consume it.
- **OpenRouter path (alternative, engine `openrouter+llm`).** Kept as the A/B baseline — do not delete it, and do not add `openrouter` to `sttModels` in `factory.js` either (see **Provider completeness**). Audio goes through the ordinary `/chat/completions` call as an `input_audio` content part (base64 **wav** — raw PCM is rejected), so `providers/openrouter.js` implements a *chunked* recogniser: `OpenRouterSTTSession` buffers PCM from `sendRealtimeInput`, cuts it every `chunkSeconds` (default 5), gates near-silent chunks on RMS, wraps the PCM in a 44-byte RIFF header via `pcm16ToWav`, and emits one `transcription` event per chunk. `sttService` routes it through `handleWhisperMessage` via `CHUNKED_STT_PROVIDERS`, which emits **every chunk as a commit** — a chunked recogniser has no interim stage, so this path has no draft tail at all. Latency is chunk-bound (~chunk length + one round trip). Each request carries the last 160 chars of the previous transcript as `previousTail` so a word cut by a chunk boundary can be resolved, and its prompt forces `[no speech detected]` for silence/music/typing, which `sttService.isWhisperNoiseText()` filters — keep those two strings in sync.
- **Soniox path (`soniox+llm`, `soniox-native`).** `providers/soniox.js`: the API key travels **only** in the first frame (the JSON config); `stt-rt-v5`, `pcm_s16le` at the captured 24 kHz. Final tokens append, non-final tokens replace. `sttService.handleSonioxMessage()` is the one parse point for both engines: it drops `<end>`/`<fin>` **by text** (`<fin>` is marked `original`, so a status filter lets it through), commits `translation_status === 'original'` finals as one unit, drafts the non-final originals, and feeds `onStreamTranslation`. **The socket always opens with `translation: one_way uk`, in `soniox+llm` too** — only then do finals come as clause units instead of ~4 s-late windows cut mid-word. Keepalive lives in the provider (Soniox's 408 after ~20 s idle closes with code 1000); `close()` = `finalize` → `<fin>` → empty frame → `finished`; no 20-minute auto-renewal for Soniox.
- **Native engine (`soniox-native`)** lives in `translateService` (`handleNativeUpdate`), not in sttService or the provider. Both sttService callbacks stay registered and check `this.engine.native` per call. A fragment = one run of final original tokens + the translation run that follows it. **Alternation is not assumed:** an extra original run joins the open fragment (`pendingUnits`), a translation owed to nobody becomes its own fragment, `PICKLE_TRANSLATE_NATIVE_TIMEOUT_MS` closes one whose translation never comes; the counters are logged on Stop as `[TranslateAB-native]`.
- **`onTranscriptionComplete` is deliberately not registered by Translate.** The debounce flush would hand back text that was already committed chunk by chunk, i.e. duplicates. The trailing interim the provider never froze (Stop mid-sentence) is committed by `closeSession()` itself **after** `await sttService.closeSessions()` (Soniox flushes its tail there via `finalize`; committing earlier would translate it twice — for Deepgram/OpenRouter the position is equivalent, logged as `Committing trailing draft on stop`) and **before** aborting `sessionAbortController`; it then waits up to 5 s for every stream in `streamingSegments`. In native the same spot closes the open fragment. **Never move the commit after the abort** — that drops the last words spoken.
- **Draft re-translation is growth-gated.** `shouldRetranslate(segment)` allows a new pass only when nothing is in flight (`streamInFlight`), the text actually changed, and — for anything after the first pass of a segment — it grew by at least `PICKLE_TRANSLATE_MIN_PARTIAL_GROWTH_CHARS` (default 30). Without the gate, Deepgram's ~150 ms interims start a fresh pass as fast as the LLM can finish one (~1/s). The first pass of a segment is never gated, so time-to-first-text stays ~1-1.5 s, and anything the gate holds back is covered by the commit pass. Only the current `segment.abortController` owner may clear `streamInFlight` or re-kick after `finally`; stale aborted streams must return without touching the active pass. Don't reintroduce an "abort on every chunk" pattern — that was the disappearing-card bug.
- **An aborted pass must never write back.** `reader.cancel()` makes the pending `reader.read()` resolve `{done: true}`, so `processTranslationStream` re-checks `segmentAbort.signal.aborted` before **both** `finalizeSegment` calls. Without those two guards a draft pass that `handleCommit` just aborted overwrites `segment.translation` with truncated text and wipes `previousFullTranslation` — the stabilization snapshot the commit pass installed one line earlier — so the fragment blanks and refills. A stream is in flight almost continuously under Deepgram, so this fires on nearly every fragment when the guards are missing.
- **Stabilization, prefix-gated.** While a stream is producing tokens, `processTranslationStream.emit()` holds the previous translation on screen until the new stream's text catches up in length — prevents the text from "shrinking" mid-render. The snapshot is **only** valid if the new source extends the previous one; when the source shrinks or diverges (a commit corrected a word the draft mis-heard), it resets to `''`. The comparison runs through `isSourceExtension()`, which lowercases and strips everything that isn't a letter or digit first: `smart_format` rewrites an unformatted interim (`ship this on friday`) into a punctuated final (`Ship this on Friday.`), and a raw `startsWith` would read that as an unrelated string and throw the snapshot away at every commit. Normalization does not cover rewrites like `twenty five percent` → `25%`; those still reset the snapshot, which is the pre-existing behaviour.
- **A dead STT socket surfaces in the UI.** A provider websocket can die mid-session (network blip, sleep, provider-side close). `sttService.handleSessionClosed(speaker, generation)` nulls the session pointer and pushes `Transcription disconnected. Press Stop, then start again.` through `onStatusUpdate`. The `generation` counter (bumped in `initializeSttSessions`) stops the 2 s overlap socket of an auto-renewal being mistaken for the live one; the `!this[key]` check keeps a deliberate `closeSessions()` quiet. There is no auto-reconnect — the user restarts the session. `handleSessionClosed` ignores the close code, which matters for Soniox: its 408 idle timeout closes with code 1000 and still shows the disconnect status (verified live). Known gap: if the 20-minute auto-renewal's handshake fails, `initializeSttSessions` has already nulled the pointer and the old socket is never closed, so the session stays dead and leaks a socket.
- **Prompt is few-shot.** `buildTranslationMessages` sends `TRANSLATION_SYSTEM_PROMPT` (anti-calque / register rules) followed by four static `user`/`assistant` pairs in `TRANSLATION_FEW_SHOT`, then the rolling context message, then the live text. The few-shot block is constant so the prompt prefix stays cacheable; it is the main lever holding the register natural, and one of its four pairs is deliberately a mid-sentence fragment, which is what most commits are. Don't collapse it back into a single prose system message.
- **Rolling LLM context.** `translateService.recentTurns` keeps the last `CONTEXT_TURNS` (default 4) finalized {EN, UK} pairs, inserted by segment `seq` (speech order) rather than appended, because overlapping final passes can finish out of order, and prepends them as a separate system message labeled "Recent conversation context (already translated, do NOT re-translate, only use to disambiguate the new input)". This is what keeps consecutive fragments reading as continuous speech; the default is 4 rather than 2 because a turn is now one commit of a few seconds, not a whole utterance.
- **Rendering is a subtitle flow, not cards.** Fragments are a few seconds of speech each, so `TranslateView.getParagraphs()` joins them into running paragraphs — a pure function of `translations`, closing a paragraph once it passes `PARAGRAPH_MIN_CHARS` (180) **and** the last committed fragment ends on sentence punctuation. Committed fragments render at full opacity (`.chunk-final`), the draft tail dimmed (`.chunk-draft`) with the streaming cursor. The list is capped at `MAX_TRANSLATION_CARDS` (100), dropping the oldest when a **new** id is appended; an upsert of an existing id never trims. Translate writes nothing to the DB, so Copy is the only transcript there is — after a long session it returns the last 100 fragments, by design.
- **The `translate:translation-update` contract is a provider-agnostic seam.** `{ id, sourceText, translation, isStreaming, isFinal }`, upserted by `id` in the renderer. Keep the shape and the upsert logic as they are: the Soniox native engine lands on this same contract without touching the renderer. The only renderer change for A/B is the header: `translate:session-state-changed` carries `engineLabel` on start and `TranslateView` shows `EN → UK · <engineLabel>` (plain `English -> Ukrainian` before the first session).
- **A/B logging.** `[TranslateAB] engine=<id> firstUkMs=<n> EN="…" UK="…"` per frozen fragment (printed at freeze time), and one `[TranslateAB-session] engine=<id> EN="…" UK="…"` per Stop in **speech order** — each fragment reserves its slot and `seq` (`reserveSessionSlot`) when created. Compare engines on the session line; fragment boundaries differ.
- **The buffer hard-cap no longer applies to Translate.** `maxCompletionBufferChars` still exists in sttService for other consumers, but Translate passes nothing: a segment is one commit of a few seconds, so there is no growing buffer to cap. `PICKLE_TRANSLATE_MAX_BUFFER_CHARS` is gone.
- **Mutual exclusivity with Listen.** Both feature names appear in `SIDE_FEATURE_WINDOW_NAMES = ['listen', 'translate']` in `windowManager.js`. Showing one auto-hides the other. `translateService.stopListenForModeSwitch()` and `listenService.handleListenRequest('Listen')` (which calls `translateService.stopForModeSwitch()`) keep the underlying STT sessions in sync.
- **Translate audio routing.** `src/ui/listen/audioCore/listenCapture.js` reads the `?view=translate` URL param and routes system audio through `window.api.translateCapture` (preload.js exposes both `listenCapture` and `translateCapture`). Mic capture is skipped (`shouldCaptureMic = false`) — Translate listens to "Them" only.

Tunable env vars (all optional, defaults are sensible):

- The engine itself is **not** an env var — pick it in Settings → Translate Engine (see above). These are read once at module load; `dotenv.config()` runs before `translateService` is required, so `.env` works.
- `PICKLE_TRANSLATE_LLM_MODEL` — OpenRouter model id for translation (default `google/gemini-2.5-flash`). Use it to A/B models on live audio without a code change. Unused by the native engine; it also names the `+ <model>` part of the engine labels.
- `PICKLE_TRANSLATE_NATIVE_TIMEOUT_MS` — native engine only: how long a fragment waits for its Soniox translation before closing with what it has (default `5000`, min `100`).
- `PICKLE_TRANSLATE_STT_CHUNK_SECONDS` — audio per STT request, **OpenRouter path only** (default `5`). Lower = snappier, more requests, more boundary cuts. Deepgram ignores it.
- `PICKLE_TRANSLATE_MIN_PARTIAL_GROWTH_CHARS` — chars the source must grow before the draft tail is re-translated (default `30`, `0` disables). Never gates the first pass of a segment, so lowering it makes the tail livelier without affecting time-to-first-text.
- `PICKLE_TRANSLATE_DEBOUNCE_MS` — debounce before sttService's caption flush (default `2000`).
- `PICKLE_TRANSLATE_TEMPERATURE` — LLM temperature (default `0.1`).
- `PICKLE_TRANSLATE_MAX_TOKENS` — LLM max output (default `1024`).
- `PICKLE_TRANSLATE_SEGMENT_GAP_MS` — gap after which a draft starts a new fragment instead of extending the current one (default `4000`). A fallback: commits normally end fragments long before this fires.
- `PICKLE_TRANSLATE_MIN_PARTIAL_CHARS` — min chars before a draft is considered at all (default `4`).
- `PICKLE_TRANSLATE_CONTEXT_TURNS` — recent-turns context size (default `4`, set `0` to disable).

### Local Whisper STT

Whisper Local is the preferred no-cloud STT path for Windows development. `whisperService` resolves storage as follows:
- `PICKLE_WHISPER_DIR` overrides the base directory.
- `PICKLE_WHISPER_BIN` overrides the executable path.
- On Windows, if `F:\programs\Whisper` exists, it is used as the base directory.
- Otherwise it falls back to `%USERPROFILE%\.glass\whisper`.

Models live under `<base>\models`, temp audio under `<base>\temp`, and executables are searched in both `<base>` and `<base>\bin` before auto-installing. The setup UI defaults Whisper STT to `whisper-base` for the best initial quality/speed balance.

Executable discovery is deliberately stricter than a file-exists check. Newer `whisper.cpp` releases can leave deprecated shim binaries such as `whisper-whisper.exe`; those print a deprecation warning and exit instead of transcribing. `whisperService` probes candidates with `--help`, rejects deprecated shims, and should settle on `whisper-cli.exe`. If only a stale shim exists in `F:\programs\Whisper\bin`, initialization should auto-install the Windows release archive and copy the full bin folder so `whisper-cli.exe` and its DLLs are present.

Persistent server discovery uses the same strict probe. `getWhisperServerPath()` checks `PICKLE_WHISPER_SERVER_BIN`, local managed paths, and PATH (`whisper-server` / `whisper-server.exe`), then provisions the local whisper.cpp bundle and repeats discovery before throwing.

Runtime tuning is env-driven:
- `PICKLE_WHISPER_LANGUAGE` — passed to `--language`; default `auto`. Use `en`, `uk`, `ru`, etc. when the expected language is known.
- `PICKLE_WHISPER_THREADS` — passed to `--threads`; default `4`.
- `PICKLE_WHISPER_CHUNK_SECONDS` — minimum PCM buffer duration before spawning `whisper-cli`; default `4`.
- `PICKLE_WHISPER_INTERVAL_MS` — polling interval for chunk processing; default `1000`.
- `PICKLE_WHISPER_SILENCE_RMS` — skip near-silent PCM chunks below this RMS; default `80`, set `0` to disable.
- `PICKLE_WHISPER_DEBUG` — set `1`/`true` to log successful Whisper stderr/stdout details; otherwise only non-zero exits are noisy.

The current provider launches `whisper-cli` once per chunk, so model load time is the main latency cost. It uses `--no-timestamps`, `--no-prints`, and `--suppress-nst` to keep output focused on transcript text and reduce non-speech tokens. A future low-latency rewrite should use a persistent/streaming Whisper process instead of repeatedly launching the CLI.

For Listen UI, Whisper chunks are handled differently from streaming cloud STT: `sttService.handleWhisperMessage()` sends partial previews and lets the existing debounce flush produce the final message and DB transcript. Do not send a Whisper chunk as `isFinal: true` immediately and then let debounce flush it again, or the transcript panel will show duplicate bubbles. Noise strings such as `[no speech detected]`, `[MUSIC PLAYING]`, and keyboard-clicking captions are filtered before they reach the UI/history.

### Startup sequence (`src/index.js`)

Order matters — services have implicit init dependencies:
1. `authService.isFirebaseEnabled()` decides the auth mode from env. Firebase is disabled by default.
2. `initializeFirebase()` runs only when Firebase mode is enabled; otherwise startup logs local-only mode and skips Firebase.
3. `databaseInitializer.initialize()` opens SQLite and runs schema sync.
4. `authService.initialize()` ends zombie sessions. In local-only mode it resets to `default_user`, clears Firebase virtual keys, and broadcasts local user state. In Firebase mode it subscribes to Firebase Auth.
5. `modelStateService.initialize()`.
6. `featureBridge.initialize()` + `windowBridge.initialize()` + `setupWebDataHandlers()`.
7. `ollamaModelRepository.initializeDefaultModels()` then background warm-up.
8. `startWebStack()` allocates two ports, writes `runtime-config.json` to temp, starts frontend + API Express servers.
9. `createWindows()`.
10. `initAutoUpdater()` (skipped in dev).

Shutdown (`before-quit`) is gated by `isShuttingDown` to prevent loops; it stops listen capture, ends active sessions, gracefully shuts Ollama (8s timeout, then forced), and closes the DB.

### Custom URL scheme

`pickleglass://` is registered as the default protocol client. Deep links route through `handleCustomUrl()`. In local-only mode, Firebase auth callbacks are ignored. In Firebase mode, `login` / `auth-success` exchange a Firebase ID token for a custom token via the cloud function. `personalize` opens settings; everything else is treated as a path on the local frontend server.
