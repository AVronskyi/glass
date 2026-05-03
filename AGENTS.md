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
- Use `node --check src/features/common/services/whisperService.js` after Whisper path or STT changes.
- `npm run lint` exists, but can fail in this repo if the root `eslint` binary is unavailable or not resolvable; report that clearly instead of treating it as a code failure.

## Editing Guidance

- Keep changes scoped to the requested behavior.
- Do not revert unrelated user edits.
- When adding renderer-to-main capabilities, wire both `src/bridge/featureBridge.js` and `src/preload.js`.
- Prefer existing local patterns over new abstractions unless the change genuinely needs one.
