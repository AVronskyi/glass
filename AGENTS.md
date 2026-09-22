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

- TranslateService (`src/features/translate/translateService.js`) is a singleton owning its own `SttService` with `enabledSpeakers: ['Them']`. **Two stages, two providers, two keys:** STT on Deepgram `nova-3`, translation on OpenRouter `google/gemini-2.5-flash`. Each stage reads its own key from `modelStateService.getAllApiKeys()` and, when it is missing, shows a status naming *that* provider (`No Deepgram key. Open Settings → API Keys → Deepgram.`). `initializeSession` compares the STT message by exact equality — change the constant and the comparison together. No local fallback. It does **not** use the Settings-side active STT provider/model. **Mutually exclusive** with Listen — both are in `SIDE_FEATURE_WINDOW_NAMES`, and entering one auto-stops the other via `stopForModeSwitch` / `stopListenForModeSwitch`.
- **Commit/draft is the load-bearing invariant.** Source the provider has frozen is translated exactly once and never re-translated; only the un-frozen tail may change. `sttService.emitStreamSegment(speaker, text, isCommitted)` is the single signal — `isCommitted` = Deepgram `is_final`, or a finished chunk from a chunked recogniser (which therefore has no draft stage). TranslateService splits it into `handleCommit()` / `handleDraft()`. Do not restore the old "re-translate the whole growing utterance" loop: it re-generated finished sentences and they visibly rephrased themselves on screen.
- **One fragment per commit**, stable `segment.id` from first draft to freeze. An entry with `isFinal: true` is never updated again, so the renderer's upsert-by-id needs no notion of commits. If the commit normalizes equal to what the draft translated, `handleCommit` freezes that translation instead of spending a request.
- **STT provider is env-selected.** `PICKLE_TRANSLATE_STT_PROVIDER` = `deepgram` (default) or `openrouter`; anything else falls back to `deepgram`. Read once at module load — switching means restarting, and `.env` works because `dotenv.config()` runs before `translateService` is required. Deepgram is a websocket with `interim_results` + `smart_format` at 24 kHz mono linear16 (~1-1.5 s to first text, `is_final` every 2-4 s **mid-sentence**); OpenRouter is chunked `/chat/completions` with `input_audio` (~6 s) and stays as the A/B baseline — don't delete it, and don't add `openrouter` to `sttModels` in `factory.js`. Whisper is no longer on this path.
- **Translate does not register `onTranscriptionComplete`** — the debounce flush would re-deliver already-committed text. The trailing interim on Stop is committed by `closeSession()` *before* `closeSessions()`, which then waits up to 5 s for the final LLM stream. Don't reorder — aborting first drops the last words.
- **Draft passes are growth-gated.** `shouldRetranslate()`: nothing in flight, text changed, and after the first pass of a segment it must have grown by `PICKLE_TRANSLATE_MIN_PARTIAL_GROWTH_CHARS` (default 30). Otherwise Deepgram's ~150 ms interims re-translate the tail roughly once a second. The first pass is never gated. Don't reintroduce "abort on every chunk" — that was the disappearing-card bug.
- **An aborted pass must not write back.** `reader.cancel()` resolves the pending `read()` as `{done:true}`, so `processTranslationStream` checks `segmentAbort.signal.aborted` before both `finalizeSegment` calls. Without them the aborted draft clobbers `segment.translation` and wipes the stabilization snapshot the commit pass just installed — the fragment blanks and refills.
- **Stabilization is prefix-gated,** compared through `isSourceExtension()` — lowercased, letters/digits only, because `smart_format` re-punctuates an interim when it finalizes it and a raw `startsWith` would fail at every commit. A genuine shrink still resets the snapshot to `''`.
- **A dead STT socket must surface.** `sttService.handleSessionClosed(speaker, generation)` nulls the session and pushes `Transcription disconnected. Press Stop, then start again.` via `onStatusUpdate`. The generation counter distinguishes a real drop from the 2 s overlap socket of an auto-renewal. No auto-reconnect. Known gap: a failed 20-minute auto-renewal handshake leaves the session dead and leaks the old socket.
- **UI is a subtitle flow.** `getParagraphs()` joins fragments into paragraphs (pure function of `translations`; breaks past 180 chars on a sentence boundary). Committed text full opacity, draft tail dimmed. Capped at 100 entries, trimmed only when a new id is appended. Translate never writes to the DB, so Copy returns the last 100 fragments and nothing older.
- **Keep the `translate:translation-update` contract** `{ id, sourceText, translation, isStreaming, isFinal }` and its upsert-by-id: it is the seam a future Soniox integration has to land on without renderer changes.
- **Audio routing.** `src/ui/listen/audioCore/listenCapture.js` reads `?view=translate` from the URL and routes system audio to `window.api.translateCapture`; mic capture is skipped (`shouldCaptureMic = false`).
- Tunables (all optional): `PICKLE_TRANSLATE_STT_PROVIDER` (`deepgram`), `PICKLE_TRANSLATE_LLM_MODEL` (`google/gemini-2.5-flash`), `PICKLE_TRANSLATE_STT_MODEL` (`nova-3` on Deepgram, `google/gemini-2.5-flash` on OpenRouter), `PICKLE_TRANSLATE_STT_CHUNK_SECONDS` (5, OpenRouter only), `PICKLE_TRANSLATE_MIN_PARTIAL_GROWTH_CHARS` (30), `PICKLE_TRANSLATE_DEBOUNCE_MS` (2000), `PICKLE_TRANSLATE_TEMPERATURE` (0.1), `PICKLE_TRANSLATE_MAX_TOKENS` (1024), `PICKLE_TRANSLATE_SEGMENT_GAP_MS` (4000), `PICKLE_TRANSLATE_MIN_PARTIAL_CHARS` (4), `PICKLE_TRANSLATE_CONTEXT_TURNS` (4; 0 disables).

## Architecture Rules

- Keep data access in the Electron main process. Renderer code and the local Next.js dashboard should not touch SQLite or Firestore directly.
- Preserve service/repository layering: services contain business logic; repositories are the only modules that talk to `sqliteClient` or `firebaseClient`.
- User-data repositories have SQLite and Firebase implementations behind an adapter. The adapter injects `uid` and should route to Firebase only for an authenticated Firebase-mode user.
- LLM/STT calls go through `src/features/common/ai/factory.js`. Register providers in the `PROVIDERS` map and keep provider modules behind that factory.
- SQLite schema changes must update `src/features/common/config/schema.js`.

## AI Provider Notes

- `features/ask` sends screenshot context as `image_url` content.
- Any OpenRouter model exposed for Ask should support image input. Do not add text-only OpenRouter models, including the removed DeepSeek entries, unless you also implement a deliberate text-only fallback.
- OpenRouter is LLM-only as far as `factory.js` is concerned: its `sttModels` stays empty, so a saved OpenRouter key alone does not satisfy the setup gate, and it never shows in the Settings STT picker. `providers/openrouter.js` does implement `createSTT`, but only Translate reaches it, via its own `modelInfoOverride`.
- Deepgram (`nova-3`) is Translate's default STT and is enterable in Settings → API Keys like any other provider. Saving the key also makes `nova-3` selectable for Listen; it will not silently replace an already-valid STT selection such as `whisper-base`.
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
