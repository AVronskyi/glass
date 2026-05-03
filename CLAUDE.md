# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Node.js 20.x is required (native deps will fail otherwise). Windows builds also need Visual Studio Build Tools; macOS/Linux need Python.

- `npm run setup` — full first-time install: root deps + `pickleglass_web` deps + web build + electron start.
- `npm start` — rebuild renderer bundles via esbuild and launch electron.
- `npm run watch:renderer` — esbuild watch mode for the two renderer bundles (`public/build/header.js`, `public/build/content.js`).
- `npm run build:renderer` — one-shot renderer bundle.
- `npm run build:web` — build the Next.js dashboard (`pickleglass_web`) into `pickleglass_web/out`. Must exist before `npm start` or the app aborts.
- `npm run build:all` — both of the above.
- `npm run build` / `npm run build:win` / `npm run publish` — package via electron-builder (uses `electron-builder.yml`).
- `npm run lint` — eslint over `.ts/.tsx/.js`.
- `cd functions && npm run serve` — Firebase Functions local emulator. `npm run deploy` deploys to Firebase. Functions are Node 20.

There is no test runner configured in this repo.

## High-Level Architecture

Glass is an Electron desktop app with three coordinated runtimes:

1. **Electron main process** (`src/index.js`) — owns all data access, AI calls, system integrations, and window management.
2. **Electron renderer** (`src/ui/`) — LitElement-style web components bundled by esbuild into `public/build/{header,content}.js`. Two entry points: `HeaderController.js` (always-on header window) and `PickleGlassApp.js` (content windows like Listen/Ask/Settings).
3. **Local Next.js dashboard** (`pickleglass_web/`) — built statically into `out/`, served by an in-process Express server inside the Electron main process. A second Express server (`pickleglass_web/backend_node/`) exposes the REST API the dashboard calls. Both ports are allocated at runtime in `startWebStack()` and exposed to the frontend via `/runtime-config.json`.

Optional fourth runtime: **Firebase Cloud Functions** (`functions/index.js`) — handles things like `pickleGlassAuthCallback` (ID-token → custom-token exchange) referenced from `src/index.js`.

### Core architectural rules (see `docs/DESIGN_PATTERNS.md` for the full version)

These are load-bearing — code that violates them tends to break things subtly:

- **All data access lives in the main process.** Renderer and the Next.js dashboard never touch SQLite or Firestore directly. The dashboard's Node backend reaches the main process via the IPC bridge described below.
- **Service–Repository layering.** Services (`*Service.js`) hold business logic; repositories (`*.repository.js`) are the only modules that talk to `sqliteClient` / `firebaseClient`. Feature-local code lives under `src/features/<feature>/`; shared code under `src/features/common/`.
- **Dual-repository factory.** Every user-data repository has *two* implementations (`sqlite.repository.js` and `firebase.repository.js`) behind an adapter `index.js`. The adapter checks `authService.getCurrentUser()` and routes to Firebase if logged in, otherwise SQLite, *and injects the `uid`* so services never pass user IDs around. Pattern reference: `src/features/common/repositories/session/index.js`. Both implementations must expose identical interfaces.
- **AI provider factory.** All LLM/STT calls go through `src/features/common/ai/factory.js` (`createLLM`, `createStreamingLLM`, `createSTT`). To add a provider, drop a module in `providers/` exposing `createLLM` / `createSTT` / class export, then register it in the `PROVIDERS` map. Provider IDs ending in `-glass` (e.g. `openai-glass`) reuse the underlying provider but are billed/keyed via Glass; `sanitizeModelId` strips the suffix before the provider sees it.
- **Schema single source of truth:** `src/features/common/config/schema.js`. Any SQLite schema change updates this file; the table list is loaded by `databaseInitializer` at boot.
- **Encryption by default for cloud data.** Anything written to Firestore that contains user content (titles, transcripts, summaries, API keys, AI messages) must go through `createEncryptedConverter` (see `firestoreConverter.js` and `encryptionService.js`). The encryption key is bound to the user and initialized via `initialize-encryption-key` IPC.

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
- `features/ask/` — one-shot Q&A with screen-capture context. `askService` orchestrates screenshot + transcript + LLM call.
- `features/settings/` — model/provider settings, presets. The active preset id is persisted on `users.selected_preset_id`; `settingsService.getSelectedPresetPrompt()` is the consumer-facing accessor that `askService` and `summaryService` call before each LLM request. In `promptBuilder.getSystemPrompt`, a non-empty `userPresetText` **replaces** the profile entirely — it is not layered on top. Default presets (school/sales/meetings/...) are seeded as full role descriptions ("You are a school assistant…") and rely on this replace behaviour, so don't downgrade preset injection back to a sub-section without rewriting the seed data.
- `features/shortcuts/` — global keybinds; coordinates with windowManager via `internalBridge`.
- `features/common/services/` — cross-cutting: `authService`, `modelStateService` (single source of truth for API keys + selected models, exposed as `global.modelStateService`), `ollamaService`, `whisperService`, `localAIManager`, `permissionService`, `encryptionService`, `migrationService`.

### Startup sequence (`src/index.js`)

Order matters — services have implicit init dependencies:
1. `initializeFirebase()` (no-op if no creds).
2. `databaseInitializer.initialize()` — opens SQLite, runs schema sync.
3. `authService.initialize()` — also ends zombie sessions from previous runs.
4. `modelStateService.initialize()`.
5. `featureBridge.initialize()` + `windowBridge.initialize()` + `setupWebDataHandlers()`.
6. `ollamaModelRepository.initializeDefaultModels()` then background warm-up.
7. `startWebStack()` allocates two ports, writes `runtime-config.json` to temp, starts frontend + API Express servers.
8. `createWindows()`.
9. `initAutoUpdater()` (skipped in dev).

Shutdown (`before-quit`) is gated by `isShuttingDown` to prevent loops; it stops listen capture, ends active sessions, gracefully shuts Ollama (8s timeout, then forced), and closes the DB.

### Custom URL scheme

`pickleglass://` is registered as the default protocol client. Deep links route through `handleCustomUrl()` — `login` / `auth-success` exchange a Firebase ID token for a custom token via the cloud function, `personalize` opens settings; everything else is treated as a path on the local frontend server.
