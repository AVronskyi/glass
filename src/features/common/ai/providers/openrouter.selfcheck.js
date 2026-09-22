// Self-check for the OpenRouter STT audio encoding. Run: node src/features/common/ai/providers/openrouter.selfcheck.js
// Covers pcm16ToWav, whose byte offsets are the one thing that fails silently as a
// bare "400 invalid audio" from OpenRouter, and the RMS silence gate.
const assert = require('assert');
const { pcm16ToWav, OpenRouterSTTSession } = require('./openrouter');

const SAMPLE_RATE = 24000;
const pcm = Buffer.alloc(480 * 2); // 20 ms of silence, 480 samples
for (let i = 0; i < 480; i++) pcm.writeInt16LE(i % 2 ? 1000 : -1000, i * 2);

const wav = pcm16ToWav(pcm, SAMPLE_RATE);

assert.strictEqual(wav.length, 44 + pcm.length, 'header must be exactly 44 bytes');
assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
assert.strictEqual(wav.readUInt32LE(4), 36 + pcm.length, 'RIFF chunk size = 36 + data');
assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE');
assert.strictEqual(wav.toString('ascii', 12, 16), 'fmt ');
assert.strictEqual(wav.readUInt32LE(16), 16, 'PCM fmt chunk is 16 bytes');
assert.strictEqual(wav.readUInt16LE(20), 1, 'format 1 = uncompressed PCM');
assert.strictEqual(wav.readUInt16LE(22), 1, 'mono');
assert.strictEqual(wav.readUInt32LE(24), SAMPLE_RATE);
assert.strictEqual(wav.readUInt32LE(28), SAMPLE_RATE * 2, 'byte rate = rate * blockAlign');
assert.strictEqual(wav.readUInt16LE(32), 2, 'block align = channels * bytesPerSample');
assert.strictEqual(wav.readUInt16LE(34), 16, 'bits per sample');
assert.strictEqual(wav.toString('ascii', 36, 40), 'data');
assert.strictEqual(wav.readUInt32LE(40), pcm.length, 'data chunk size = payload length');
assert.ok(wav.subarray(44).equals(pcm), 'payload must survive verbatim');

// The silence gate decides whether we spend a request on a chunk at all.
const session = new OpenRouterSTTSession({ apiKey: 'sk-or-test' });
assert.strictEqual(session.calculatePcmRms(Buffer.alloc(4800)), 0, 'digital silence is rms 0');
assert.ok(session.calculatePcmRms(pcm) > 900, 'a 1000-amplitude square wave is well above the gate');
assert.ok(session.calculatePcmRms(Buffer.alloc(0)) === 0, 'empty buffer must not throw');

console.log('openrouter selfcheck: OK');
