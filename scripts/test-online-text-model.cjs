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
const bindingKey = 'ai_phone_bindings_v1';
const apiKey = 'ai_phone_api_configs_v1';
const apis = ['base', 'next', 'other'].map(id => ({ id, name: id + ' config', provider: 'OpenAI', apiKey: 'saved-test-key',
    baseUrl: 'https://example.test/v1', defaultModel: id + '-model', enableImageRecognition: false, enableImageGeneration: false }));
const baseline = { appDefaults: {}, globalDefaults: { apiConfigId: 'base', presetId: 'preset', worldBookIds: ['world'], voiceConfigId: 'voice' },
    characterBindings: [{ characterId: 'alice', defaults: {}, appOverrides: { chat: { regexIds: ['regex'] }, story: { apiConfigId: 'other' } } }] };
const persisted = async () => JSON.parse((await db.table('entries').get(bindingKey)).value);
const seed = async () => {
    await kv.kvSetAsync(apiKey, JSON.stringify(apis));
    await kv.kvSetAsync(bindingKey, JSON.stringify(baseline));
};

test('independent online text API lifecycle', async t => {
    await kv.hydrateKvDb();
    await seed();
    await t.test('old bindings keep the original resolution', () => {
        assert.deepEqual(storage.resolveOnlineTextBinding(storage.loadBindingConfig(), 'alice'), storage.resolveBinding(baseline, 'alice', 'chat'));
    });
    await t.test('selection commits only one role API and keeps all other fields', async () => {
        const originalApis = storage.loadApiConfigs();
        await storage.saveOnlineTextApiConfig('alice', 'next');
        const saved = await persisted();
        assert.deepEqual(saved.characterBindings[0], { ...baseline.characterBindings[0], onlineText: { apiConfigId: 'next' } });
        const effective = storage.resolveOnlineTextBinding(saved, 'alice');
        assert.equal(effective.apiConfigId, 'next');
        assert.equal(effective.presetId, 'preset');
        assert.deepEqual(effective.worldBookIds, ['world']);
        assert.equal(effective.voiceConfigId, 'voice');
        assert.deepEqual(effective.regexIds, ['regex']);
        for (const app of ['chat', 'story', 'diary', 'group_chat']) {
            assert.deepEqual(storage.resolveBinding(saved, 'alice', app), storage.resolveBinding(baseline, 'alice', app));
        }
        assert.equal(storage.resolveOnlineTextBinding(saved, 'bob').apiConfigId, 'base');
        assert.deepEqual(storage.loadApiConfigs(), originalApis);
    });
    await t.test('concurrent saves for different roles do not overwrite each other', async () => {
        await Promise.all([storage.saveOnlineTextApiConfig('alice', 'next'), storage.saveOnlineTextApiConfig('bob', 'other')]);
        const saved = await persisted();
        assert.equal(storage.resolveOnlineTextBinding(saved, 'alice').apiConfigId, 'next');
        assert.equal(storage.resolveOnlineTextBinding(saved, 'bob').apiConfigId, 'other');
    });
    await t.test('legacy editors cannot erase selections from a stale snapshot', async () => {
        storage.saveBindingConfig({ ...baseline, globalDefaults: { ...baseline.globalDefaults, presetId: 'changed-preset' } });
        assert.equal(storage.resolveOnlineTextBinding(storage.loadBindingConfig(), 'alice').apiConfigId, 'next');
        assert.equal(storage.resolveOnlineTextBinding(storage.loadBindingConfig(), 'bob').apiConfigId, 'other');
    });
    await t.test('scope classifier excludes calls, offline, theater, groups and other apps', () => {
        assert.equal(state.isOrdinaryOnlineTextRequest(false, { appTags: ['chat', 'text'] }), true);
        assert.equal(state.isOrdinaryOnlineTextRequest(false, { appTags: ['chat', 'text', 'followup'] }), true);
        for (const tags of [['chat'], ['chat', 'offline'], ['chat', 'voice'], ['chat', 'video'], ['chat', 'text', 'voice']]) {
            assert.equal(state.isOrdinaryOnlineTextRequest(false, { appTags: tags }), false);
        }
        assert.equal(state.isOrdinaryOnlineTextRequest(true, { appTags: ['chat', 'text'] }), false);
        assert.equal(state.isOrdinaryOnlineTextRequest(false, { appId: 'diary', appTags: ['chat', 'text'] }), false);
    });
    await t.test('generation prevents selection, including programmatic calls', async () => {
        const run = state.beginOnlineTextGeneration('alice', 'next');
        const before = await persisted();
        await assert.rejects(storage.saveOnlineTextApiConfig('alice', 'other'), state.OnlineTextBusyError);
        assert.deepEqual(await persisted(), before);
        run.finish();
        assert.equal(state.isOnlineTextBusy('alice'), false);
    });
    await t.test('saving prevents a new generation and releases its lock on error', async () => {
        let release;
        const saving = state.withOnlineTextSwitch('alice', () => new Promise(resolve => { release = resolve; }));
        assert.throws(() => state.beginOnlineTextGeneration('alice', 'next'), state.OnlineTextBusyError);
        release(); await saving;
        await assert.rejects(state.withOnlineTextSwitch('alice', async () => { throw new Error('write failed'); }), /write failed/);
        assert.equal(state.isOnlineTextBusy('alice'), false);
    });
    await t.test('transaction failure keeps cache and disk and sends no success event', async () => {
        const before = await persisted();
        let notices = 0;
        const listener = () => notices++;
        events.addEventListener('settings-bindings-updated', listener);
        const tablePrototype = Object.getPrototypeOf(Object.getPrototypeOf(db.table('entries')));
        const put = tablePrototype.put;
        tablePrototype.put = function(value, ...args) {
            if (value.key === bindingKey) return Promise.reject(new Error('simulated quota failure'));
            return put.call(this, value, ...args);
        };
        try { await assert.rejects(storage.saveOnlineTextApiConfig('alice', 'other'), /simulated quota failure/); }
        finally { tablePrototype.put = put; events.removeEventListener('settings-bindings-updated', listener); }
        assert.deepEqual(storage.loadBindingConfig(), before);
        assert.deepEqual(await persisted(), before);
        assert.equal(notices, 0);
    });
    await t.test('delete cancels only affected text runs and preserves the invalid ID', async () => {
        const run = state.beginOnlineTextGeneration('alice', 'next');
        const otherRun = state.beginOnlineTextGeneration('bob', 'other');
        storage.saveApiConfigs(apis.filter(api => api.id !== 'next'));
        storage.removeApiConfigReferences('next');
        storage.ensureGlobalBindingDefaults();
        assert.equal(run.signal.aborted, true);
        assert.ok(run.signal.reason instanceof state.OnlineTextApiUnavailableError);
        assert.equal(otherRun.signal.aborted, false);
        assert.equal(storage.resolveOnlineTextBinding(storage.loadBindingConfig(), 'alice').apiConfigId, 'next');
        assert.equal(storage.loadApiConfigs().some(api => api.id === 'next'), false);
        run.finish(); otherRun.finish();
        await assert.rejects(storage.saveOnlineTextApiConfig('alice', 'next'), /已删除/);
        await storage.saveOnlineTextApiConfig('alice', 'other');
        assert.equal((await persisted()).characterBindings[0].onlineText.apiConfigId, 'other');
    });
    await t.test('target validation reads the committed API list rather than stale cache', async () => {
        await seed();
        await db.table('entries').put({ key: apiKey, value: JSON.stringify(apis.filter(api => api.id !== 'next')) });
        assert.equal(storage.loadApiConfigs().some(api => api.id === 'next'), true);
        await assert.rejects(storage.saveOnlineTextApiConfig('alice', 'next'), /已删除/);
        assert.deepEqual(await persisted(), baseline);
    });
    await t.test('a legacy save during a pending switch cannot erase the committed selection', async () => {
        await seed();
        const selection = storage.saveOnlineTextApiConfig('alice', 'next');
        storage.saveBindingConfig({ ...baseline, globalDefaults: { ...baseline.globalDefaults, presetId: 'edited-preset' } });
        await selection;
        // A read-write barrier waits for the queued legacy transaction too.
        await kv.kvUpdateCommitted(bindingKey, raw => raw);
        const saved = await persisted();
        assert.equal(saved.characterBindings[0].onlineText.apiConfigId, 'next');
        assert.equal(saved.globalDefaults.presetId, 'edited-preset');
        assert.equal(storage.loadBindingConfig().characterBindings[0].onlineText.apiConfigId, 'next');
    });
    await t.test('deleting a previously inherited API also pauses text before default cleanup', async () => {
        await seed();
        storage.saveApiConfigs(apis.filter(api => api.id !== 'base'));
        storage.removeApiConfigReferences('base');
        storage.ensureGlobalBindingDefaults();
        await kv.kvUpdateCommitted(bindingKey, raw => raw);
        const saved = await persisted();
        assert.equal(storage.resolveOnlineTextBinding(saved, 'alice').apiConfigId, 'base');
        assert.equal(storage.resolveBinding(saved, 'alice', 'chat').apiConfigId, 'next');
        assert.equal(saved.characterBindings[0].onlineText.apiConfigId, 'base');
    });
    db.close();
});
