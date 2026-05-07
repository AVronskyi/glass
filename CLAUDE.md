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
- **Provider completeness.** Setup/startup requires a usable LLM provider and a usable STT provider (`modelStateService.areProvidersConfigured()`). OpenRouter is LLM-only; a saved OpenRouter key is not enough for Listen/STT. The local STT default is Whisper Local with `whisper-base`.
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

`features/translate/translateService.js` is a singleton that owns its own `SttService` instance (separate from Listen's) configured for English-only system-audio capture. It wires Whisper Local (persistent server mode) → per-chunk LLM stream → `translate` content window.

Key invariants:

- **Hardcoded LLM provider/model.** Translate **does not** read `modelStateService.getCurrentModelInfo('llm')`. It is fixed to `provider='openrouter'`, `model='google/gemini-2.5-flash-lite'` (constants `TRANSLATE_LLM_PROVIDER` / `TRANSLATE_LLM_MODEL` in `translateService.js`). Settings-side LLM choice affects Listen/Ask but not Translate. Translate fetches just the API key via `modelStateService.getAllApiKeys().openrouter`. If absent, the renderer status bar shows `No OpenRouter key. Open Settings → API Keys → OpenRouter.` instead of a generic failure.
- **Hardcoded STT provider/model.** Translate **does not** read `modelStateService.getCurrentModelInfo('stt')`. Its `SttService` is constructed with `modelInfoOverride: { provider: 'whisper', model: process.env.PICKLE_TRANSLATE_WHISPER_MODEL || 'whisper-base', apiKey: 'local' }`, so changing the Settings-side STT picker affects Listen but not Translate.
- **Whisper server-mode is required.** TranslateService initializes its `SttService` with `providerOptions: { whisperMode: 'server', whisperLanguage: 'en' }`. The persistent `whisper-server.exe` binary must be present; `whisper-cli.exe` alone is not enough. `whisperService.getWhisperServerPath()` checks `PICKLE_WHISPER_SERVER_BIN`, local managed dirs, PATH, then provisions via Homebrew/autoInstall and checks local/PATH again before failing.
- **Mutual exclusivity with Listen.** Both feature names appear in `SIDE_FEATURE_WINDOW_NAMES = ['listen', 'translate']` in `windowManager.js`. Showing one auto-hides the other. `translateService.stopListenForModeSwitch()` and `listenService.handleListenRequest('Listen')` (which calls `translateService.stopForModeSwitch()`) keep the underlying STT sessions in sync.
- **Active-segment streaming model.** TranslateService keeps a single `activeSegment` per utterance (one card on screen). Each Whisper chunk fires `onPartialTranscript` (added to sttService for this feature, fires alongside the existing `Them` partial-update path) → `handlePartial(text)` updates `segment.sourceText`. A new LLM stream is kicked off **only if no stream is in flight** (`streamInFlight` flag). Only the current `segment.abortController` owner may clear `streamInFlight` or re-kick after `finally`; stale aborted streams must return without touching the active pass.
- **Stabilization, prefix-gated.** While a stream is producing tokens, `processTranslationStream.emit()` holds the previous translation on screen until the new stream's text catches up in length — prevents the card from "shrinking" mid-render. The snapshot is **only** valid if the new source extends the previous one (`newSrc.startsWith(oldSrc)`); when the source shrinks (e.g. a hard-cap flush hands `handleFinal(front)` to translate just the front portion), the snapshot is reset to `''`. Don't drop this prefix check or the card will visibly cut off whenever a hard-cap split happens.
- **Hard-cap on buffer length.** sttService accepts `maxCompletionBufferChars` (TranslateService passes 250). When `theirCompletionBuffer` exceeds this, sttService flushes early at the last sentence-boundary (`.`/`?`/`!` followed by a space) past the halfway point so a long monologue (no natural pauses) gets split into 2-3 cards instead of one giant card that exceeds `maxTokens`. The flushed "front" segment is marked `isFinalizing`; while that final LLM pass is running, the remaining "back" partial must create a fresh segment/card instead of overwriting the old one.
- **Close flushes pending buffer.** `sttService.closeSessions()` now calls and awaits `flushMyCompletion()` / `flushTheirCompletion()` before clearing buffers. The flush methods clear their buffers synchronously, send the final UI update, then return a caught Promise for `onTranscriptionComplete`, so Listen does not end the DB session before the trailing transcript save resolves. `translateService.closeSession()` runs `sttService.closeSessions()` first, waits up to 5 s for any final LLM stream to complete, then aborts `sessionAbortController`.
- **Rolling LLM context.** `translateService.recentTurns` keeps the last `CONTEXT_TURNS` (default 2) finalized {EN, UK} pairs and prepends them as a separate system message labeled "Recent conversation context (already translated, do NOT re-translate, only use to disambiguate the new input)". Helps with short orphan fragments like "Yes, exactly".
- **Translate audio routing.** `src/ui/listen/audioCore/listenCapture.js` reads the `?view=translate` URL param and routes system audio through `window.api.translateCapture` (preload.js exposes both `listenCapture` and `translateCapture`). Mic capture is skipped (`shouldCaptureMic = false`) — Translate listens to "Them" only.

Tunable env vars (all optional, defaults are sensible):

- `PICKLE_TRANSLATE_DEBOUNCE_MS` — debounce before final flush (default `2000`).
- `PICKLE_TRANSLATE_WHISPER_CHUNK_SECONDS` — minimum audio per Whisper chunk (default `1.0`).
- `PICKLE_TRANSLATE_WHISPER_INTERVAL_MS` — Whisper processing-loop poll interval (default `250`).
- `PICKLE_TRANSLATE_TEMPERATURE` — LLM temperature (default `0.1`).
- `PICKLE_TRANSLATE_MAX_TOKENS` — LLM max output (default `1024`).
- `PICKLE_TRANSLATE_SEGMENT_GAP_MS` — gap that triggers new segment (default `4000`).
- `PICKLE_TRANSLATE_MIN_PARTIAL_CHARS` — min chars to consider a partial (default `4`).
- `PICKLE_TRANSLATE_CONTEXT_TURNS` — recent-turns context size (default `2`, set `0` to disable).
- `PICKLE_TRANSLATE_MAX_BUFFER_CHARS` — hard-cap before forced sentence-boundary flush (default `250`).

### Local Whisper STT

Whisper Local is the preferred no-cloud STT path for Windows development. `whisperService` resolves storage as follows:
- `PICKLE_WHISPER_DIR` overrides the base directory.
- `PICKLE_WHISPER_BIN` overrides the executable path.
- On Windows, if `F:\programs\Whisper` exists, it is used as the base directory.
- Otherwise it falls back to `%USERPROFILE%\.glass\whisper`.

Models live under `<base>\models`, temp audio under `<base>\temp`, and executables are searched in both `<base>` and `<base>\bin` before auto-installing. The setup UI defaults Whisper STT to `whisper-base` for the best initial quality/speed balance.

Executable discovery is deliberately stricter than a file-exists check. Newer `whisper.cpp` releases can leave deprecated shim binaries such as `whisper-whisper.exe`; those print a deprecation warning and exit instead of transcribing. `whisperService` probes candidates with `--help`, rejects deprecated shims, and should settle on `whisper-cli.exe`. If only a stale shim exists in `F:\programs\Whisper\bin`, initialization should auto-install the Windows release archive and copy the full bin folder so `whisper-cli.exe` and its DLLs are present.

Persistent server discovery uses the same strict probe. `getWhisperServerPath()` checks `PICKLE_WHISPER_SERVER_BIN`, local managed paths, and PATH (`whisper-server` / `whisper-server.exe`), then provisions the local whisper.cpp bundle and repeats discovery before throwing. This matters for Translate because a usable `whisper-cli` from PATH is not enough.

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
