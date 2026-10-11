const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
require('fake-indexeddb/auto');
const root = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...args) {
    return resolve.call(this, request.startsWith('@/') ? path.join(root, request.slice(2)) : request, ...args);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const local = new Map();
global.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value),
    removeItem: key => local.delete(key), key: index => [...local.keys()][index] ?? null, get length() { return local.size; } };
const events = new EventTarget();
global.window = { localStorage, location: { origin: 'http://localhost:3000' }, dispatchEvent: e => events.dispatchEvent(e),
    addEventListener: (...args) => events.addEventListener(...args), removeEventListener: (...args) => events.removeEventListener(...args) };
global.document = { visibilityState: 'visible' };
global.FileReader = class {
    readAsDataURL(blob) { blob.arrayBuffer().then(data => { this.result = `data:${blob.type};base64,${Buffer.from(data).toString('base64')}`; this.onload?.(); }); }
};
const played = [];
global.Audio = class {
    constructor(src) { this.src = src; this.loop = false; this.paused = true; }
    play() { this.paused = false; played.push(this); return Promise.resolve(); }
    pause() { this.paused = true; }
};
const kv = require('../lib/kv-db.ts');
const storage = require('../lib/chat-storage.ts');
const sounds = require('../lib/chat-sound.ts');
const assets = require('../lib/chat-asset-storage.ts');
const db = require('../lib/chat-db.ts').chatDb;
const flush = () => new Promise(resolve => setImmediate(resolve));
const config = extra => ({ enabled: true, sourceType: 'url', value: 'https://audio.test/global.wav', ...extra });
const setGlobal = extra => storage.saveChatAppSettings({ ...storage.loadChatAppSettings(), globalChatSounds: {
    newMessage: config(), sendMessage: config(), incomingCall: config(), outgoingCall: config(), hangup: config(), ...extra,
} });
const msg = (extra = {}) => storage.pushChatMessage({ sessionId: 'alice', role: 'assistant', content: '你好', ...extra });

test('momo sound configuration, storage and real message events', async t => {
    await kv.hydrateKvDb();
    await storage.hydrateChatStorage();
    storage.saveChatSessions(['alice', 'bob'].map(id => ({ id, contactId: id, unreadCount: 0, isPinned: false, updatedAt: new Date().toISOString(), customCSS: 'keep-history' })));
    await t.test('legacy settings default silent and unrelated settings survive saves', async () => {
        storage.saveChatAppSettings({ enterToSendEnabled: true, unknownSetting: { keep: true } });
        assert.deepEqual(storage.resolveChatSoundConfig('newMessage', null), {});
        await sounds.playChatSoundOnce('newMessage'); assert.equal(played.length, 0);
        setGlobal(); assert.equal(storage.loadChatAppSettings().enterToSendEnabled, true);
        assert.deepEqual(storage.loadChatAppSettings().unknownSetting, { keep: true });
    });
    await t.test('global / custom / off; missing custom source and subrules inherit', () => {
        setGlobal({ newMessage: config({ muteActiveChat: true, notifyOncePerBurst: true }) });
        assert.equal(storage.resolveChatSoundConfig('newMessage', {}).value, 'https://audio.test/global.wav');
        const custom = storage.resolveChatSoundConfig('newMessage', { sounds: { newMessage: { enabled: true, value: undefined, muteActiveChat: false } } });
        assert.equal(custom.enabled, true); assert.equal(custom.value, 'https://audio.test/global.wav');
        assert.equal(custom.muteActiveChat, false); assert.equal(custom.notifyOncePerBurst, true);
        assert.equal(storage.resolveChatSoundConfig('newMessage', { sounds: { newMessage: { enabled: false } } }).enabled, false);
    });
    await t.test('uploaded audio roundtrips through existing assets; preview ignores enable switch', async () => {
        const id = await assets.saveChatAudioToIndexedDB(new Blob(['fixture-wave'], { type: 'audio/wav' }));
        const data = await assets.getChatAudioFromIndexedDB(id); assert.match(data, /^data:audio\/wav;base64,/);
        setGlobal({ sendMessage: { enabled: false, sourceType: 'file', value: id } });
        const before = played.length; await sounds.playChatSoundOnce('sendMessage'); assert.equal(played.length, before);
        await sounds.previewChatSound('sendMessage'); assert.equal(played.at(-1).src, data);
        await sounds.previewChatSound('sendMessage'); assert.equal(played.at(-1).src, data);
    });
    const dispose = sounds.installChatSoundListener();
    await t.test('actual pushChatMessage sends and receives; role custom and off apply', async () => {
        setGlobal(); const before = played.length;
        msg({ role: 'user' }); msg(); await flush(); assert.equal(played.length, before + 2);
        const sessions = storage.loadChatSessions(); sessions.find(s => s.id === 'alice').sounds = { newMessage: config({ value: 'https://audio.test/alice.wav' }) };
        storage.saveChatSessions(sessions); msg(); await flush(); assert.equal(played.at(-1).src, 'https://audio.test/alice.wav');
        sessions.find(s => s.id === 'alice').sounds.newMessage.enabled = false; storage.saveChatSessions(sessions);
        const count = played.length; msg(); await flush(); assert.equal(played.length, count);
        delete sessions.find(s => s.id === 'alice').sounds; storage.saveChatSessions(sessions);
    });
    await t.test('visible main and mini chat mute; background or another session still alerts', async () => {
        setGlobal({ newMessage: config({ muteActiveChat: true }) }); storage.setActiveChatSessionId('alice');
        let count = played.length; msg(); await flush(); assert.equal(played.length, count);
        msg({ sessionId: 'bob' }); await flush(); assert.equal(played.length, ++count);
        document.visibilityState = 'hidden'; msg(); await flush(); assert.equal(played.length, ++count);
        document.visibilityState = 'visible'; storage.setActiveChatSessionId(null); sounds.setMiniChatSoundSessionId('alice');
        msg(); await flush(); assert.equal(played.length, count);
        sounds.setMiniChatSoundSessionId(null); msg(); await flush(); assert.equal(played.length, ++count);
    });
    await t.test('10 second burst suppression is per sender, configurable, and expires', async () => {
        setGlobal({ newMessage: config({ notifyOncePerBurst: true }) });
        const now = Date.now; let clock = now() + 20000; Date.now = () => clock;
        try {
            let count = played.length;
            msg({ senderCharacterId: 'burst-a' }); msg({ senderCharacterId: 'burst-a' }); msg({ senderCharacterId: 'burst-b' });
            await flush(); assert.equal(played.length, count + 2); count += 2;
            clock += 9999; msg({ senderCharacterId: 'burst-a' }); await flush(); assert.equal(played.length, count);
            clock += 1; msg({ senderCharacterId: 'burst-a' }); await flush(); assert.equal(played.length, ++count);
            setGlobal(); msg({ senderCharacterId: 'burst-a' }); msg({ senderCharacterId: 'burst-a' }); await flush(); assert.equal(played.length, count + 2);
        } finally { Date.now = now; }
    });
    await t.test('system/tool/call/narrative events and import notifications never sound', async () => {
        setGlobal(); const count = played.length;
        for (const mediaType of ['tool_call', 'tool_result', 'tool_notice', 'memory_write_request', 'voice_call', 'video_call', 'system_instruction', 'group_admin_notice']) msg({ mediaType });
        for (const origin of ['reading_discuss', 'story_floating_phone']) { msg({ origin }); msg({ role: 'user', origin }); }
        for (const content of ['[我向你发起了语音通话]', '[我挂断了视频通话]', '[我拒绝了语音通话]', '[我取消了群语音通话]']) { msg({ content }); msg({ role: 'user', content }); }
        msg({ content: '' }); msg({ role: 'system' });
        window.dispatchEvent(new CustomEvent(storage.CHAT_MESSAGE_PUSHED_EVENT));
        await flush(); assert.equal(played.length, count);
    });
    await t.test('loop is single, old cleanup cannot stop replacement; cancellation prevents late play', async () => {
        const stopA = sounds.startChatSoundLoop('incomingCall'); await flush(); const a = played.at(-1); assert.equal(a.loop, true);
        const stopB = sounds.startChatSoundLoop('outgoingCall'); await flush(); const b = played.at(-1); assert.equal(a.paused, true);
        stopA(); assert.equal(b.paused, false); stopB(); assert.equal(b.paused, true);
        const count = played.length; const stop = sounds.startChatSoundLoop('incomingCall'); stop(); await flush(); assert.equal(played.length, count);
    });
    await t.test('listener cleanup and history/config persistence', async () => {
        dispose(); const count = played.length; msg(); await flush(); assert.equal(played.length, count);
        assert.ok(storage.loadChatMessages('alice').length > 10);
        assert.equal(storage.findChatSessionById('alice').customCSS, 'keep-history');
        await flush(); assert.equal((await db.sessions.get('alice')).customCSS, 'keep-history');
        const kvDb = new (require('dexie').default)('AiPhoneKvDB');
        kvDb.version(1).stores({ entries: 'key' });
        assert.equal(JSON.parse((await kvDb.table('entries').get('ai_phone_chat_settings_v1')).value).unknownSetting.keep, true);
        kvDb.close();
    });
});
