const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
require('fake-indexeddb/auto');
const root = path.resolve(__dirname, '..');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...args) {
    return originalResolve.call(this, request.startsWith('@/') ? path.join(root, request.slice(2)) : request, ...args);
};
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, filename);
};
const local = new Map();
global.localStorage = {
    getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key),
    key: index => [...local.keys()][index] ?? null, get length() { return local.size; },
};
const events = new EventTarget();
global.window = { localStorage, location: { origin: 'http://localhost:3000' }, dispatchEvent: event => events.dispatchEvent(event),
    addEventListener: (...args) => events.addEventListener(...args), removeEventListener: (...args) => events.removeEventListener(...args) };
const Dexie = require('dexie').default;
const kv = require('../lib/kv-db.ts');
const storage = require('../lib/settings-storage.ts');
const state = require('../lib/online-text-generation.ts');
const db = new Dexie('AiPhoneKvDB');
db.version(1).stores({ entries: 'key' });
const bindingKey = 'ai_phone_bindings_v1', apiKey = 'ai_phone_api_configs_v1';
const apis = ['base', 'next', 'other'].map(id => ({ id, name: id + ' config', provider: 'OpenAI', apiKey: 'saved-test-key',
    baseUrl: 'https://example.test/v1', defaultModel: id + '-model', enableImageRecognition: false, enableImageGeneration: false }));
const baseline = { appDefaults: {}, globalDefaults: { apiConfigId: 'base', presetId: 'preset', worldBookIds: ['world'], voiceConfigId: 'voice' },
    characterBindings: [{ characterId: 'alice', defaults: {}, appOverrides: { chat: { regexIds: ['regex'] }, story: { apiConfigId: 'other' } } },
        { characterId: 'bob', defaults: { apiConfigId: 'other' }, appOverrides: {} }] };
const persisted = async () => JSON.parse((await db.table('entries').get(bindingKey)).value);
const seed = async (config = baseline) => {
    await kv.kvSetAsync(apiKey, JSON.stringify(apis));
    await kv.kvSetAsync(bindingKey, JSON.stringify(config));
};
const chat = (config, id = 'alice') => storage.resolveBinding(config, id, 'chat');

test('shared character API lifecycle', async t => {
    await kv.hydrateKvDb();
    await require('../lib/settings-db.ts').hydrateSettingsDb();
    await t.test('legacy onlineText and selectionRequired are inert and never promoted', async () => {
        const legacy = structuredClone(baseline);
        legacy.selectionRequired = true;
        legacy.characterBindings[0].selectionRequired = true;
        legacy.characterBindings[0].onlineText = { apiConfigId: 'deleted-legacy', selectionRequired: true };
        await seed(legacy);
        for (let pass = 0; pass < 3; pass++) {
            assert.equal(chat(storage.loadBindingConfig()).apiConfigId, 'base');
            assert.deepEqual(storage.getCharacterChatApiSelection(storage.loadBindingConfig(), 'alice'), { apiConfigId: 'base', inherits: true });
        }
        assert.deepEqual(await persisted(), legacy);
        await storage.saveCharacterApiConfig('alice', 'next');
        const saved = await persisted();
        assert.deepEqual(saved.characterBindings[0].onlineText, legacy.characterBindings[0].onlineText);
        assert.equal(chat(saved).apiConfigId, 'next');
    });
    await t.test('shared selection writes original defaults and keeps every non-API field and API object', async () => {
        await seed(); const originalApis = storage.loadApiConfigs();
        await storage.saveCharacterApiConfig('alice', 'next');
        const saved = await persisted();
        const expected = structuredClone(baseline); expected.characterBindings[0].defaults.apiConfigId = 'next';
        assert.deepEqual(saved, expected);
        assert.deepEqual(storage.loadApiConfigs(), originalApis);
        assert.deepEqual(chat(saved), { ...chat(baseline), apiConfigId: 'next' });
        assert.deepEqual(saved.characterBindings[1], baseline.characterBindings[1]);
    });
    await t.test('existing chat override is displayed and explicit selection updates it without changing other slots', async () => {
        const config = structuredClone(baseline); config.characterBindings[0].appOverrides.chat.apiConfigId = 'other';
        await seed(config);
        assert.equal(storage.getCharacterChatApiSelection(config, 'alice').apiConfigId, 'other');
        await storage.saveCharacterApiConfig('alice', 'next');
        const saved = await persisted();
        assert.equal(saved.characterBindings[0].defaults.apiConfigId, 'next');
        assert.deepEqual(saved.characterBindings[0].appOverrides.chat, { apiConfigId: 'next', regexIds: ['regex'] });
        assert.deepEqual(saved.characterBindings[0].appOverrides.story, config.characterBindings[0].appOverrides.story);
        assert.deepEqual(chat(saved), { ...chat(config), apiConfigId: 'next' });
    });
    await t.test('app defaults retain priority and explicit role choice cannot be shadowed', async () => {
        const config = structuredClone(baseline); config.appDefaults.chat = { apiConfigId: 'other', presetId: 'app-preset' };
        await seed(config); assert.equal(chat(config).apiConfigId, 'other');
        await storage.saveCharacterApiConfig('alice', 'next');
        const saved = await persisted();
        assert.equal(chat(saved).apiConfigId, 'next'); assert.equal(chat(saved).presetId, 'app-preset');
        assert.deepEqual(saved.appDefaults, config.appDefaults);
        assert.equal(chat(saved, 'bob').apiConfigId, 'other');
        await storage.saveCharacterApiConfig('alice');
        const inherited = await persisted();
        assert.equal(chat(inherited).apiConfigId, 'other');
        assert.equal(storage.getCharacterChatApiSelection(inherited, 'alice').inherits, true);
        assert.deepEqual(inherited.characterBindings[0].appOverrides.chat, { regexIds: ['regex'] });
    });
    await t.test('original inheritance and override order remains intact', () => {
        const config = structuredClone(baseline);
        assert.equal(chat(config).apiConfigId, 'base');
        config.characterBindings[0].defaults.apiConfigId = 'next'; assert.equal(chat(config).apiConfigId, 'next');
        config.appDefaults.chat = { apiConfigId: 'other' }; assert.equal(chat(config).apiConfigId, 'other');
        config.characterBindings[0].appOverrides.chat.apiConfigId = 'base'; assert.equal(chat(config).apiConfigId, 'base');
    });
    await t.test('concurrent different roles persist independently', async () => {
        await seed(); await Promise.all([storage.saveCharacterApiConfig('alice', 'next'), storage.saveCharacterApiConfig('bob', 'base')]);
        const saved = await persisted(); assert.equal(chat(saved).apiConfigId, 'next'); assert.equal(chat(saved, 'bob').apiConfigId, 'base');
    });
    await t.test('generation prevents either picker from saving and inheritance from bypassing the lock', async () => {
        await seed(); const before = await persisted(), run = state.beginOnlineTextGeneration('alice', 'base');
        await assert.rejects(storage.saveCharacterApiConfig('alice', 'next'), state.OnlineTextBusyError);
        await assert.rejects(storage.saveCharacterApiConfig('alice'), state.OnlineTextBusyError);
        assert.deepEqual(await persisted(), before); run.finish();
    });
    await t.test('pending save blocks generation and failure releases the guard', async () => {
        let release; const saving = state.withOnlineTextSwitch('alice', () => new Promise(resolve => { release = resolve; }));
        assert.throws(() => state.beginOnlineTextGeneration('alice', 'base'), state.OnlineTextBusyError);
        release(); await saving;
        await assert.rejects(state.withOnlineTextSwitch('alice', async () => { throw new Error('write failed'); }), /write failed/);
        assert.equal(state.isOnlineTextBusy('alice'), false);
    });
    await t.test('failed transaction keeps cache and durable binding and never announces success', async () => {
        await seed(); const before = await persisted(); let notices = 0;
        const listener = () => notices++; events.addEventListener('settings-bindings-updated', listener);
        const proto = Object.getPrototypeOf(Object.getPrototypeOf(db.table('entries'))), put = proto.put;
        proto.put = function(value, ...args) { return value.key === bindingKey ? Promise.reject(new Error('simulated quota failure')) : put.call(this, value, ...args); };
        try { await assert.rejects(storage.saveCharacterApiConfig('alice', 'next'), /simulated quota failure/); }
        finally { proto.put = put; events.removeEventListener('settings-bindings-updated', listener); }
        assert.deepEqual(storage.loadBindingConfig(), before); assert.deepEqual(await persisted(), before); assert.equal(notices, 0);
    });
    await t.test('deletion freezes inherited chat API, cancels only affected runs and survives default cleanup', async () => {
        await seed(); const run = state.beginOnlineTextGeneration('alice', 'base'), other = state.beginOnlineTextGeneration('bob', 'other');
        storage.saveApiConfigs(apis.filter(api => api.id !== 'base'));
        storage.removeApiConfigReferences('base'); storage.ensureGlobalBindingDefaults();
        await kv.kvUpdateCommitted(bindingKey, raw => raw);
        assert.equal(run.signal.aborted, true); assert.ok(run.signal.reason instanceof state.OnlineTextApiUnavailableError);
        assert.equal(other.signal.aborted, false);
        const saved = await persisted(); assert.equal(chat(saved).apiConfigId, 'base'); assert.equal(chat(saved, 'bob').apiConfigId, 'other');
        assert.equal(saved.characterBindings[0].onlineText, undefined);
        assert.equal(saved.characterBindings[0].appOverrides.chat.apiConfigId, 'base');
        run.finish(); other.finish();
        await assert.rejects(storage.saveCharacterApiConfig('alice', 'base'), /已删除/);
        await storage.saveCharacterApiConfig('alice', 'other'); assert.equal(chat(await persisted()).apiConfigId, 'other');
    });
    await t.test('target validation uses committed API list rather than a stale cache', async () => {
        await seed(); await db.table('entries').put({ key: apiKey, value: JSON.stringify(apis.filter(api => api.id !== 'next')) });
        assert.equal(storage.loadApiConfigs().some(api => api.id === 'next'), true);
        await assert.rejects(storage.saveCharacterApiConfig('alice', 'next'), /已删除/); assert.deepEqual(await persisted(), baseline);
    });
    await t.test('reference cleanup alone cannot discard a missing role chat selection', async () => {
        await seed(); await storage.saveCharacterApiConfig('alice', 'next');
        // Simulate an external API deletion that bypasses the ordinary settings save event.
        await kv.kvSetAsync(apiKey, JSON.stringify(apis.filter(api => api.id !== 'next')));
        storage.removeApiConfigReferences('next');
        await kv.kvUpdateCommitted(bindingKey, raw => raw);
        const saved = await persisted();
        assert.equal(chat(saved).apiConfigId, 'next');
        assert.equal(saved.characterBindings[0].appOverrides.chat.apiConfigId, 'next');
        assert.equal(chat(saved, 'bob').apiConfigId, 'other');
        storage.removeApiConfigReferences('next');
        assert.deepEqual(storage.loadBindingConfig(), saved);
    });
    db.close();
});
