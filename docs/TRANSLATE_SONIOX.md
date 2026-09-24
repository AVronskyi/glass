# Translate engines and the Soniox integration

Status (2026-09-24): implemented on `dev`. Verified offline (self-check, replay of a recorded Soniox stream) and against the live Soniox API with 72 s of TTS audio. **The A/B comparison on real audio has not been run yet** — see [Pending](#pending).

CLAUDE.md keeps the invariants; this file keeps the evidence and the reasoning behind them.

## Engines

Picked in **Settings → Translate Engine**, stored as `translateEngine` in `settingsService` (electron-store), read at every Translate session start. A running session keeps its engine: Stop, pick, Translate. The Settings **STT Model** list is Listen's and Translate never reads it.

| Engine id (= `[TranslateAB]` id) | Pipeline | Keys |
|---|---|---|
| `deepgram+llm` (default) | Deepgram `nova-3` → OpenRouter `gemini-2.5-flash`, commit/draft flow | Deepgram, OpenRouter |
| `soniox+llm` | Soniox `stt-rt-v5` → the same LLM, prompt and flow | Soniox, OpenRouter |
| `soniox-native` | Soniox transcribes and translates in one socket, no LLM | Soniox |
| `openrouter+llm` | OpenRouter chunked STT → the same LLM (baseline) | OpenRouter |

IPC: `translate:get-engines` → `{ engines: [{id, name}], selected }`, `translate:set-engine` (unknown ids refused). A stale stored id falls back to `deepgram+llm` with a warning. There is no env switch; `PICKLE_TRANSLATE_STT_PROVIDER` / `_ENGINE` / `_STT_MODEL` were removed.

## Running an A/B comparison

1. Save the Soniox key in Settings → API Keys → Soniox (the app never reads `SONIOX_API_KEY` from `.env`).
2. For each engine: pick it, press Translate, play the same audio, press Stop.
3. Compare the `[TranslateAB-session] engine=<id> EN="…" UK="…"` lines. They are whole-session text in speech order. Fragment boundaries differ between Deepgram and Soniox, so per-fragment lines don't line up across them. `soniox+llm` and `soniox-native` do share boundaries, so their `[TranslateAB]` lines pair one to one.
4. Latency: `firstUkMs` on each `[TranslateAB]` line is the time from a fragment's first English text to its first Ukrainian text.
5. Native only: `[TranslateAB-native] alternation violations: …` on Stop should stay at 0; anything else means Soniox broke the O→T pattern below.

## Soniox protocol as observed

Probe of 2026-09-23: 72 s of TTS English, 24 kHz, streamed in 100 ms frames at real time. The findings are about protocol and timing only — TTS says nothing about recognition or translation quality, and its pauses are unnaturally regular.

- **24 kHz works.** The 24 kHz and 16 kHz transcripts of the same audio differed by 0 words out of 182, so no resampling.
- `GET https://api.soniox.com/v1/models` with `Authorization: Bearer` returns 200, which is what `validateApiKey` uses. `stt-rt-v5` is current; older ids alias to it.
- **Without `translation`, finalization suits us badly.** In continuous speech, text freezes in ~2 s audio windows running ~4 s behind (finalization latency p50 3.3 s, p90 5.8 s) and is cut mid-word (`" tal"|"k"`, `" wh"|"at"`: 5 and 10 cuts in two runs). `<end>` is unreliable: 12 on one run, 1 on another run of the same audio.
- **With `translation: one_way uk`, finalization changes.** Final originals come as clause-sized units: 26 in 72 s, 5–67 chars, every p50 2.7 s, ~0.7 s after the clause ends (finalization p50 1.7 s), 0 mid-word cuts. **This is why both Soniox engines always enable translation.** Soniox charges nothing extra for it ($0.12/h either way).
- **Translation timing.** The translation run follows its original run in the *next* message, 14–77 ms later (p50 46 ms), always whole. Order was strictly O,T,O,T, and no non-final translation token was ever sent.
- The first non-final token appears ~650 ms after the word is spoken.
- **Markers.** `<end>` carries status `none` (or none at all), `<fin>` carries `original`. Filter them by text, never by status.
- **End of stream.** An empty frame alone flushes the tail (`finished` after ~190 ms). `finalize` → `<fin>` (~180 ms) → empty frame → `finished` (~130 ms) flushed the translation too. `close()` uses the latter.
- **Idle.** About 20 s with no frame gets `{"error_code":408,"error_type":"request_timeout",…}` followed by a close with code **1000**. Errors carry `tokens: []`; only `error_code` identifies them. The provider's keepalive (after 5 s idle) held a silent socket for 32 s.

## Design decisions

- **Native lives in `translateService`** (`handleNativeUpdate`), not in sttService or the provider. sttService only parses tokens (`handleSonioxMessage`, one parse point for both engines). Fragment rules are Translate's concern, and a separate service would duplicate the session lifecycle, Listen exclusivity and audio routing.
- **Native fragment = original run + the translation run after it.** The observed O→T alternation is not assumed to be a contract:
  - an extra original run before the translation joins the open fragment (`pendingUnits`);
  - a translation owed to nobody becomes its own fragment;
  - a timeout (`PICKLE_TRANSLATE_NATIVE_TIMEOUT_MS`, 5 s) closes a fragment whose translation never comes.

  Each case is counted.
- **`soniox+llm` ignores translation tokens strictly** (`translation_status === 'original'` only; `none` is dropped in both engines).
- **Trailing commit after `closeSessions()`, before the abort.** Soniox's `close()` flushes the tail, so committing earlier would translate it twice. For Deepgram/OpenRouter the order is equivalent, and each such commit logs `Committing trailing draft on stop` so this can be checked.
- **A commit never reuses an `isFinalizing` segment.** Back-to-back commits, which `finalize` on Stop can produce, used to overwrite the previous clause and abort its translation. Several segments can now finalize at once, so `closeSession()` waits for every one in `streamingSegments`. The session summary and `recentTurns` keep speech order through slots/`seq` reserved when a fragment is created.
- **No 20-minute auto-renewal for Soniox.** A stream may run 300 min, and a renewal's 2 s overlap would mix two sockets' finals.

## Verification done

- `node src/features/translate/translateService.selfcheck.js` covers:
  - markers and translation tokens never reaching commits or the UI;
  - every native fragment rule;
  - back-to-back commits, including right before Stop;
  - speech order;
  - engine switching between sessions without a restart.
- Recorded Soniox stream replayed through the real services (`soniox+llm`, fake LLM): 26 commits, 0 visible collapses, 0 markers in prompts or UI.
- Live Soniox, `soniox-native`, TTS with Stop mid-word:
  - 26 fragments, 0 violations, the last sentence complete, Stop in ~0.3 s;
  - `firstUkMs` 0.26–4.26 s (median 2.1 s);
  - real 408 → `Transcription disconnected. Press Stop, then start again.`
- The missing-key status is exact for every engine, and the app boots cleanly.

## Pending

- Live A/B on real audio (a podcast) for `deepgram+llm`, `soniox+llm` and `soniox-native`.
- Deepgram, Stop mid-sentence: exactly one `Committing trailing draft on stop`, with the tail once in `[TranslateAB]` and once in `[TranslateAB-session]`. If not, make the trailing-commit order provider-dependent (Deepgram/OpenRouter before `closeSessions()`).
- `firstUkMs` on a long sentence without pauses, `deepgram+llm` vs `soniox-native`. Native has no Ukrainian draft, so it is expected to lose here.
- Visual check of the Settings block and the header label; Translate → Listen → Translate.

## Known limits

- Native shows no Ukrainian until a clause is final (`…` meanwhile).
- Speech in a non-source language (`translation_status: none`) is dropped by both Soniox engines.
- Per-fragment `[TranslateAB]` lines print at freeze time, so overlapping commits may appear swapped. Use the session line.
- A Soniox session past 300 min ends with the disconnect status (no reconnect).
