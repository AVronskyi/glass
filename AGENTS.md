# AGENTS.md

This file gives Codex and other coding agents the operational rules for this repo. `CLAUDE.md` is the fuller architecture reference; keep this file short and action-oriented.

## Current Defaults

- This fork runs against its **own** Firebase project (`glass-f347d`, region `us-west1`), not upstream `pickle-3651a`. `PICKLE_AUTH_MODE=firebase` is set in a gitignored `.env`, so `npm start` boots in Firebase mode by default.
- Both auth modes still coexist: local-only is the fallback when `.env` is missing or env var is unset. Local-only mode uses SQLite with `default_user`. Firebase mode signs in via Google → Cloud Function `pickleGlassAuthCallback` → custom token, then routes user-data repos to Firestore database `pickle-glass`.
- The `openai-glass` virtual-key flow that calls upstream `serverless-api-sf3o.vercel.app` is disabled. The current fork has no access to that backend. `getVirtualKeyByEmail` only runs if `PICKLE_VIRTUAL_KEY_ENDPOINT` env var is set; otherwise the call is skipped and Firebase users use their own API keys, identical to local-only behavior.
- If Electron starts as Node and `app.getPath` is undefined, clear `ELECTRON_RUN_AS_NODE` before `npm start`.

## Firebase Gotchas (read before touching auth/Firestore code)

- The Firebase web config lives in TWO places that must stay in sync: `src/features/common/services/firebaseClient.js` (main process) and `pickleglass_web/utils/firebase.ts` (web bundle). After editing the web file, run `npm run build:web` — the bundle in `pickleglass_web/out/` is static and the browser will keep minting ID tokens against the old project until rebuilt.
- The Firestore database ID is the literal `'pickle-glass'` (not `(default)`). Encoded in `getFirestore(firebaseApp, 'pickle-glass')`. The named DB lives at `firebase.json`'s `firestore.database` field — must be set, otherwise rules deploy to the wrong DB and the app gets `PERMISSION_DENIED` on every Firestore call.
- The Cloud Function URL is hardcoded in `src/index.js` inside `handleFirebaseAuthCallback`. Region must match `functions/index.js`'s `onRequest({region: ...})`. Both currently `us-west1`.
- New Firebase projects need IAM role `Service Account Token Creator` granted to the default compute SA, or `admin.auth().createCustomToken()` fails with `signBlob denied`. One-time setup in GCP Console → IAM.
- Cloud Functions v2 (`firebase-functions/v2/https`) require the Blaze plan.
- `firestore.rules` are strict per-user. Sessions allow read for `resource.data.uid == auth.uid OR auth.uid in resource.data.members`. Don't relax these without checking the actual queries in `src/features/**/repositories/*/firebase.repository.js` first — Firestore rejects queries whose filters don't satisfy the rule predicates even if individual docs would pass.
- `update` rules on `prompt_presets` and `sessions` enforce `request.resource.data.uid == resource.data.uid` — uid is immutable. Don't drop this; without it a signed-in user can hand off their preset/session to another UID.

## Provider Gating

- `modelStateService.hasValidApiKey()` and `areProvidersConfigured()` do not short-circuit on Firebase login. A Firebase user without personal API keys (and without `PICKLE_VIRTUAL_KEY_ENDPOINT`) is treated as not configured. The header controller routes such users straight to ApiKeyHeader (not the welcome screen, which would loop).
- If you re-introduce a "logged in is enough" shortcut, you also need to guarantee a usable LLM provider and STT provider are present — otherwise the user lands in the main UI with no way to make requests.

## Whisper Download

- `ApiKeyHeader.downloadWhisperModel(modelId)` throws on failure (returns `{success: true}` on success). The submit flow's `try/catch` blocks setup if the model didn't install. Non-submit callers (auto-default on load, dropdown change) wrap the call in their own `try/catch` because the error is already surfaced via `this.sttError`.
- Local Whisper should resolve to `whisper-cli.exe`. Newer `whisper.cpp` ships deprecated shim binaries such as `whisper-whisper.exe`; `whisperService` probes candidates with `--help` and must reject deprecated shims instead of accepting file existence alone.
- The current Whisper provider starts `whisper-cli` per audio chunk, so model loading is the main latency cost. Tune with `PICKLE_WHISPER_LANGUAGE`, `PICKLE_WHISPER_THREADS`, `PICKLE_WHISPER_CHUNK_SECONDS`, `PICKLE_WHISPER_INTERVAL_MS`, `PICKLE_WHISPER_SILENCE_RMS`, and `PICKLE_WHISPER_DEBUG`.
- Whisper UI updates are intentionally partial-first and debounce-final in `sttService.handleWhisperMessage()`. Do not send the same Whisper chunk as an immediate final and then flush it as final again, or Listen will show duplicate bubbles.

## Translate Mode (live EN→UK)

- TranslateService (`src/features/translate/translateService.js`) is a singleton that owns its own `SttService` instance configured with `enabledSpeakers: ['Them']`, `modelInfoOverride: { provider: 'whisper', model: PICKLE_TRANSLATE_WHISPER_MODEL || 'whisper-base', apiKey: 'local' }`, and `whisperMode: 'server'`. It does **not** use the Settings-side active STT provider/model. It is **mutually exclusive** with Listen — both are in `SIDE_FEATURE_WINDOW_NAMES`, and entering one auto-stops the other via `stopForModeSwitch` / `stopListenForModeSwitch`.
- **LLM is hardcoded** to `provider='openrouter'`, `model='google/gemini-2.5-flash-lite'`. Settings-side LLM picker does not affect Translate. The OpenRouter API key is fetched via `modelStateService.getAllApiKeys().openrouter`. Without that key Translate shows a friendly status (`No OpenRouter key. Open Settings → API Keys → OpenRouter.`) and translation calls fail. Don't replace this with `getCurrentModelInfo('llm')` — Translate is intentionally pinned to a fast, fluent-Ukrainian model.
- **Whisper persistent server is required.** TranslateService relies on `whisper-server.exe` running as a subprocess. `whisper-cli.exe` alone is not enough. `whisperService.getWhisperServerPath()` checks configured env, local managed dirs, PATH, then provisions via Homebrew/autoInstall and checks again before failing.
- **Active-segment streaming.** One on-screen card per utterance, identified by a stable `segment.id`. Each Whisper chunk fires `onPartialTranscript` (a callback added to sttService — fires alongside the existing `Them` partial-update path for whisper/gemini/deepgram/openai). `handlePartial` updates `segment.sourceText`. A new LLM stream is kicked off **only if `streamInFlight` is false**. Only the current `segment.abortController` owner may clear `streamInFlight` or re-kick; stale aborted streams must not touch the active pass. Don't reintroduce a "abort on every chunk" pattern; it was the cause of the disappearing-card bug.
- **Stabilization is prefix-gated.** While streaming, `processTranslationStream.emit()` holds the previous translation on screen until the new stream's text catches up in length. The snapshot is **only** valid when `newSrc.startsWith(oldSrc)` and `newSrc.length >= oldSrc.length` (i.e. source genuinely grew). When source shrinks (hard-cap flush hands `handleFinal(front)` to translate just the front portion), the snapshot must reset to `''`, otherwise the card visibly cuts off when the (correct, shorter) translation completes.
- **Hard-cap with sentence-aware split.** sttService accepts `maxCompletionBufferChars` (TranslateService passes 250). When the buffer exceeds it, sttService flushes early at the last `.`/`?`/`!` past the halfway point. The flushed "front" segment is marked `isFinalizing`, so the remaining "back" partial must start a new card instead of overwriting the old card. This prevents one giant monologue card that exceeds `maxTokens`.
- **Close flushes pending buffer.** `sttService.closeSessions()` calls and awaits `flushTheirCompletion()` / `flushMyCompletion()` before clearing buffers. `translateService.closeSession()` runs `sttService.closeSessions()` FIRST, waits up to 5 s for the final LLM stream, then aborts `sessionAbortController`. Don't reorder — aborting first kills the final-pass stream and drops the last 1-2 sentences.
- **Audio routing.** `src/ui/listen/audioCore/listenCapture.js` reads `?view=translate` from the URL and routes system audio to `window.api.translateCapture`; mic capture is skipped (`shouldCaptureMic = false`).
- Tunables (all optional): `PICKLE_TRANSLATE_DEBOUNCE_MS` (default 2000), `PICKLE_TRANSLATE_WHISPER_CHUNK_SECONDS` (1.0), `PICKLE_TRANSLATE_WHISPER_INTERVAL_MS` (250), `PICKLE_TRANSLATE_TEMPERATURE` (0.1), `PICKLE_TRANSLATE_MAX_TOKENS` (1024), `PICKLE_TRANSLATE_SEGMENT_GAP_MS` (4000), `PICKLE_TRANSLATE_MIN_PARTIAL_CHARS` (4), `PICKLE_TRANSLATE_CONTEXT_TURNS` (2; 0 disables), `PICKLE_TRANSLATE_MAX_BUFFER_CHARS` (250).

## Architecture Rules

- Keep data access in the Electron main process. Renderer code and the local Next.js dashboard should not touch SQLite or Firestore directly.
- Preserve service/repository layering: services contain business logic; repositories are the only modules that talk to `sqliteClient` or `firebaseClient`.
- User-data repositories have SQLite and Firebase implementations behind an adapter. The adapter injects `uid` and should route to Firebase only for an authenticated Firebase-mode user.
- LLM/STT calls go through `src/features/common/ai/factory.js`. Register providers in the `PROVIDERS` map and keep provider modules behind that factory.
- SQLite schema changes must update `src/features/common/config/schema.js`.

## AI Provider Notes

- `features/ask` sends screenshot context as `image_url` content.
- Any OpenRouter model exposed for Ask should support image input. Do not add text-only OpenRouter models, including the removed DeepSeek entries, unless you also implement a deliberate text-only fallback.
- OpenRouter is LLM-only in this app. Startup/setup requires both an LLM provider and an STT provider; a saved OpenRouter key alone does not satisfy STT.
- The preferred local STT setup on Windows is Whisper Local with `whisper-base`. Whisper storage defaults to `F:\programs\Whisper` when that directory exists; override with `PICKLE_WHISPER_DIR` or `PICKLE_WHISPER_BIN`.

## Validation

- Use `npm run build:renderer` as the quick validation after renderer or UI changes.
- Use `node --check <main-process-file.js>` for targeted syntax checks on main-process JavaScript.
- Use `node --check src/preload.js` after preload bridge changes.
- Use `node --check src/features/common/services/whisperService.js`, `node --check src/features/common/ai/providers/whisper.js`, and `node --check src/features/listen/stt/sttService.js` after Whisper path or STT changes.
- `npm run lint` exists, but can fail in this repo if the root `eslint` binary is unavailable or not resolvable; report that clearly instead of treating it as a code failure.

## Editing Guidance

- Keep changes scoped to the requested behavior.
- Do not revert unrelated user edits.
- When adding renderer-to-main capabilities, wire both `src/bridge/featureBridge.js` and `src/preload.js`.
- Prefer existing local patterns over new abstractions unless the change genuinely needs one.
