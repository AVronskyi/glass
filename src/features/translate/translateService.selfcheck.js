// Self-check for the Soniox paths of Translate. Run: node src/features/translate/translateService.selfcheck.js
// Covers what fails quietly on live audio: <end>/<fin> leaking into text, translation
// tokens leaking into llm-engine commits, the native fragment rules when Soniox
// does not alternate original → translation one to one, back-to-back commits, and
// the Settings engine choice applying per session without a restart.
const assert = require('assert');

process.env.PICKLE_TRANSLATE_NATIVE_TIMEOUT_MS = '150';

// modelStateService and settingsService pull in electron-store, which needs a
// running Electron app. The settings stub holds the Translate Engine choice.
const stub = (request, exports) => {
    const file = require.resolve(request);
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
let storedSettings = {};
stub('../common/services/modelStateService', { getAllApiKeys: async () => ({ openrouter: 'test' }) });
stub('../settings/settingsService', {
    getSettings: async () => ({ ...storedSettings }),
    saveSettings: async settings => { storedSettings = { ...storedSettings, ...settings }; return { success: true }; },
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fake LLM for the commit path: answers with the source uppercased after 50 ms
// (200 ms if the source says "slow"), so commits can overlap in either order.
// translateService binds it at require time.
let llmCalls = 0;
const factory = require('../common/ai/factory');
factory.createStreamingLLM = () => ({
    streamChat: async messages => {
        llmCalls++;
        const encoder = new TextEncoder();
        const text = messages.at(-1).content.toUpperCase();
        return {
            body: ReadableStream.from((async function* () {
                await sleep(/slow/i.test(text) ? 200 : 50);
                yield encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
                yield encoder.encode('data: [DONE]\n\n');
            })()),
        };
    },
});

const SttService = require('../listen/stt/sttService');
const translateService = require('./translateService');

const O = (text, isFinal = true) => ({ text, is_final: isFinal, translation_status: 'original' });
const T = text => ({ text, is_final: true, translation_status: 'translation' });
const END = { text: '<end>', is_final: true, translation_status: 'none' };
const FIN = { text: '<fin>', is_final: true, translation_status: 'original' };

(async () => {
    // What sttService hands to handleCommit / handleDraft.
    const stt = new SttService({ enabledSpeakers: ['Them'] });
    const segments = [];
    stt.setCallbacks({ onStreamSegment: (speaker, text, isCommitted) => segments.push([text, isCommitted]) });
    stt.handleSonioxMessage('Them', { tokens: [O('Hey'), O(' there.'), END, O(' So to', false), O('day', false)] });
    stt.handleSonioxMessage('Them', { tokens: [T('Привіт.')] });
    stt.handleSonioxMessage('Them', { tokens: [O(' So today'), FIN] });
    assert.deepStrictEqual(segments, [['Hey there.', true], ['So today', false], ['So today', true]],
        'translation tokens and <end>/<fin> must never reach a commit or a draft');

    // Engine choice, as the Settings list sees it.
    const { log, warn } = console;
    console.warn = () => {};
    const options = await translateService.getEngineOptions();
    assert.deepStrictEqual(options.engines.map(e => e.id), ['deepgram+llm', 'soniox+llm', 'soniox-native', 'openrouter+llm']);
    assert.deepStrictEqual(options.engines.map(e => e.name),
        ['Deepgram + gemini-2.5-flash', 'Soniox + gemini-2.5-flash', 'Soniox native', 'OpenRouter + gemini-2.5-flash']);
    assert.strictEqual(options.selected, 'deepgram+llm', 'nothing stored means Deepgram + LLM');
    assert.strictEqual((await translateService.setEngine('sonix')).success, false, 'unknown id is refused');
    storedSettings.translateEngine = 'removed-engine';
    assert.strictEqual(await translateService.getSelectedEngineId(), 'deepgram+llm', 'a stale stored id falls back to the default');

    // native engine.
    const updates = [];
    const logs = [];
    translateService.sendToRenderer = (channel, data) => {
        if (channel === 'translate:translation-update') updates.push(data);
    };
    translateService.sttService.initializeSttSessions = async () => true;
    translateService.sttService.closeSessions = async () => {};
    console.log = (...args) => logs.push(args.join(' '));
    const feed = tokens => translateService.sttService.handleSonioxMessage('Them', { tokens });
    const finals = () => updates.filter(u => u.isFinal).map(u => [u.sourceText, u.translation]);

    assert.strictEqual((await translateService.setEngine('soniox-native')).success, true);
    await translateService.initializeSession();
    assert.strictEqual(translateService.engine.label, 'Soniox native');
    assert.strictEqual(translateService.sttService.providerOptions().translation?.target_language, 'uk', 'Soniox socket opens with translation');

    // The shape observed live: O unit, then its translation in the next message.
    feed([O('He', false), O('y', false)]);
    feed([O('Hey'), O(' there.'), END, O(' So', false)]);
    assert.strictEqual(updates.at(-1).sourceText, 'Hey there. So', 'open fragment shows the committed EN plus the draft tail');
    feed([T('Привіт.')]);
    assert.deepStrictEqual(finals(), [['Hey there.', 'Привіт.']], 'the translation closes the fragment without the next draft');
    assert.strictEqual(updates.find(u => u.isFinal).id, updates[0].id, 'draft and final are one fragment id');

    // A second clause before the first translation joins the open fragment.
    feed([O(' So', false), O(' today', false)]);
    feed([O(' So today')]);
    feed([O(' we talk.')]);
    feed([T(' Тож сьогодні')]);
    assert.strictEqual(finals().length, 1, 'one translation still owed, fragment stays open');
    feed([T(' ми говоримо.')]);
    assert.deepStrictEqual(finals()[1], ['So today we talk.', 'Тож сьогодні ми говоримо.']);

    // A translation nothing is waiting for becomes its own fragment.
    feed([T(' Зайве.')]);
    assert.deepStrictEqual(finals()[2], ['', 'Зайве.']);

    // No translation within the timeout: close with what there is.
    feed([O(' Lost clause.')]);
    await sleep(250);
    assert.deepStrictEqual(finals()[3], ['Lost clause.', '']);

    // Stop while only a draft is open: the words stay.
    feed([O(' and then', false)]);
    await translateService.closeSession();
    assert.deepStrictEqual(finals()[4], ['and then', '']);

    assert.strictEqual(llmCalls, 0, 'the native engine never calls the LLM');
    assert.ok(updates.every(u => !/<end>|<fin>/.test(u.sourceText + u.translation)), 'markers never reach the renderer');
    assert.strictEqual(logs.filter(l => l.startsWith('[TranslateAB] engine=soniox-native')).length, 5);
    assert.ok(logs.includes('[TranslateAB-session] engine=soniox-native EN="Hey there. So today we talk. Lost clause. and then" UK="Привіт. Тож сьогодні ми говоримо. Зайве."'));
    assert.ok(logs.includes('[TranslateAB-native] alternation violations: clauseBeforeTranslation=1 orphanTranslation=1 timeout=1'));

    // Switched in Settings, no restart: the next session runs soniox+llm.
    // A second commit while the first one's stream is still in flight — back-to-back
    // Deepgram finals, a Soniox unit whose tail was under PARTIAL_MIN_CHARS, several
    // units flushed by finalize on Stop — must open its own fragment. Reusing the
    // finalizing one replaced clause 1's text and aborted its translation. The first
    // clause's LLM is the slower one, so passes finish out of speech order; context
    // and the session summary must still follow speech order.
    await translateService.setEngine('soniox+llm');
    await translateService.initializeSession();
    assert.strictEqual(translateService.engine.label, 'Soniox + gemini-2.5-flash');
    updates.length = 0;
    logs.length = 0;
    feed([O('Slow first clause.')]);
    feed([T('Повільна перша клауза.')]);
    feed([O(' Second clause.')]);
    await sleep(400);
    const committed = updates.filter(u => u.isFinal);
    assert.strictEqual(new Set(committed.map(u => u.id)).size, 2, 'two commits, two fragments; the translation token is ignored');
    assert.deepStrictEqual(committed.map(u => [u.sourceText, u.translation]).sort(),
        [['Second clause.', 'SECOND CLAUSE.'], ['Slow first clause.', 'SLOW FIRST CLAUSE.']]);
    assert.deepStrictEqual(translateService.recentTurns.map(turn => turn.en), ['Slow first clause.', 'Second clause.'],
        'LLM context is in speech order, not in the order passes finished');
    await translateService.closeSession();
    assert.ok(logs.includes('[TranslateAB-session] engine=soniox+llm EN="Slow first clause. Second clause." UK="SLOW FIRST CLAUSE. SECOND CLAUSE."'),
        'session summary is in speech order');

    // Stop right after two such commits, the first one slower: closeSession must
    // wait for every stream in flight, not only the active segment's.
    await translateService.initializeSession();
    updates.length = 0;
    logs.length = 0;
    translateService.handleCommit('Slow clause.');
    translateService.handleCommit('Fast clause.');
    await translateService.closeSession();
    assert.deepStrictEqual(updates.filter(u => u.isFinal).map(u => [u.sourceText, u.translation]).sort(),
        [['Fast clause.', 'FAST CLAUSE.'], ['Slow clause.', 'SLOW CLAUSE.']],
        'both commits made just before Stop are translated');
    assert.ok(logs.includes('[TranslateAB-session] engine=soniox+llm EN="Slow clause. Fast clause." UK="SLOW CLAUSE. FAST CLAUSE."'),
        'session summary is in speech order after Stop too');

    // Deepgram sessions open their socket without Soniox's translation option.
    await translateService.setEngine('deepgram+llm');
    await translateService.initializeSession();
    assert.strictEqual(translateService.sttService.providerOptions().translation, undefined);
    await translateService.closeSession();

    console.log = log;
    console.warn = warn;
    console.log('translateService selfcheck: OK');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
