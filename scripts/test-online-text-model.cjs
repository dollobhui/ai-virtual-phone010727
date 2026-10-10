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

// Hold a real IndexedDB transaction open, then enqueue an independent UI action.
// This reproduces slow-storage overlap deterministically instead of relying on timers.
const overlapCommit = async (key, first, whilePending) => {
    const proto = Object.getPrototypeOf(Object.getPrototypeOf(db.table('entries'))), put = proto.put;
    let release, reached, armed = true;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { reached = resolve; });
    proto.put = function(value, ...args) {
        if (armed && value.key === key && Dexie.currentTransaction) {
            armed = false; reached();
            return Dexie.waitFor(gate).then(() => put.call(this, value, ...args));
        }
        return put.call(this, value, ...args);
    };
    let pending, others = [];
    try {
        pending = first();
        await Promise.race([ready, pending.then(() => { throw new Error('Commit was not paused'); })]);
        others = Dexie.ignoreTransaction(whilePending);
        release();
        return await Promise.all([pending, ...others]);
    } finally {
        release();
        await Promise.allSettled([pending, ...others]);
        proto.put = put;
    }
};

const assertCacheMatchesDisk = async () => assert.deepEqual(storage.loadBindingConfig(), await persisted());

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
        await storage.saveApiConfigs(apis.filter(api => api.id !== 'base'));
        await storage.removeApiConfigReferences('base'); await storage.ensureGlobalBindingDefaults();
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
        await storage.removeApiConfigReferences('next');
        await kv.kvUpdateCommitted(bindingKey, raw => raw);
        const saved = await persisted();
        assert.equal(chat(saved).apiConfigId, 'next');
        assert.equal(saved.characterBindings[0].appOverrides.chat.apiConfigId, 'next');
        assert.equal(chat(saved, 'bob').apiConfigId, 'other');
        await storage.removeApiConfigReferences('next');
        assert.deepEqual(storage.loadBindingConfig(), saved);
    });
    await t.test('switch then deletion of the previous API cannot overwrite the new selection', async () => {
        await seed();
        await overlapCommit(bindingKey, () => storage.saveCharacterApiConfig('alice', 'next'), () => [
            storage.saveApiConfigs(apis.filter(api => api.id !== 'base')),
            storage.removeApiConfigReferences('base'),
        ]);
        await assertCacheMatchesDisk();
        const saved = await persisted();
        assert.equal(chat(saved).apiConfigId, 'next');
        assert.equal(chat(saved, 'bob').apiConfigId, 'other');
        assert.deepEqual(chat(saved).worldBookIds, ['world']);
        assert.equal(chat(saved).presetId, 'preset');
        assert.equal(chat(saved).voiceConfigId, 'voice');
    });
    await t.test('deletion then switching to a surviving API replaces only the invalid selection', async () => {
        await seed();
        await overlapCommit(apiKey, () => storage.saveApiConfigs(apis.filter(api => api.id !== 'base')), () => [
            storage.saveCharacterApiConfig('alice', 'next'),
            storage.removeApiConfigReferences('base'),
        ]);
        await assertCacheMatchesDisk();
        assert.equal(chat(await persisted()).apiConfigId, 'next');
        assert.equal(chat(await persisted(), 'bob').apiConfigId, 'other');
    });
    await t.test('deleting the target first rejects the queued switch without fallback', async () => {
        await seed();
        await overlapCommit(apiKey, () => storage.saveApiConfigs(apis.filter(api => api.id !== 'next')), () => [
            assert.rejects(storage.saveCharacterApiConfig('alice', 'next'), /已删除/),
        ]);
        await assertCacheMatchesDisk();
        assert.equal(chat(await persisted()).apiConfigId, 'base');
    });
    await t.test('deleting a newly selected API preserves that invalid binding rather than the previous API', async () => {
        await seed();
        await overlapCommit(bindingKey, () => storage.saveCharacterApiConfig('alice', 'next'), () => [
            storage.saveApiConfigs(apis.filter(api => api.id !== 'next')),
            storage.removeApiConfigReferences('next'),
        ]);
        await assertCacheMatchesDisk();
        const saved = await persisted();
        assert.equal(chat(saved).apiConfigId, 'next');
        assert.equal(saved.characterBindings[0].appOverrides.chat.apiConfigId, 'next');
        assert.equal(storage.loadApiConfigs().some(api => api.id === 'next'), false);
    });
    await t.test('pending and already stale binding edits preserve API selections and other roles', async () => {
        await seed(); const before = storage.loadBindingConfig(), edited = structuredClone(before);
        edited.characterBindings[0].defaults.worldBookIds = ['edited-world'];
        edited.characterBindings[0].appOverrides.chat.presetId = 'edited-preset';
        await overlapCommit(bindingKey, () => storage.saveCharacterApiConfig('alice', 'next'), () => [
            storage.saveBindingConfig(edited, true, before),
            storage.saveCharacterApiConfig('bob', 'base'),
        ]);
        const later = structuredClone(before); later.globalDefaults.voiceConfigId = 'edited-voice';
        await storage.saveBindingConfig(later, true, before);
        await assertCacheMatchesDisk();
        const saved = await persisted();
        assert.equal(chat(saved).apiConfigId, 'next');
        assert.equal(chat(saved, 'bob').apiConfigId, 'base');
        assert.deepEqual(chat(saved).worldBookIds, ['edited-world']);
        assert.equal(chat(saved).presetId, 'edited-preset');
        assert.equal(chat(saved).voiceConfigId, 'edited-voice');
    });
    await t.test('independent stale API list edits cannot resurrect deleted configs or discard unrelated edits', async () => {
        await seed(); const first = apis.filter(api => api.id !== 'base');
        const second = apis.filter(api => api.id !== 'next').map(api => ({ ...api, name: api.id === 'other' ? 'edited name' : 'stale edit to deleted config' }));
        await overlapCommit(apiKey, () => storage.saveApiConfigs(first, apis), () => [storage.saveApiConfigs(second, apis)]);
        assert.deepEqual(storage.loadApiConfigs().map(api => api.id), ['other']);
        assert.equal(storage.loadApiConfigs()[0].name, 'edited name');
        await assertCacheMatchesDisk();
        assert.equal(chat(await persisted()).apiConfigId, 'base');
    });
    await t.test('failed deletion rolls back API and binding records together without events or cancellation', async () => {
        await seed(); const before = await persisted(), beforeApis = storage.loadApiConfigs();
        const run = state.beginOnlineTextGeneration('alice', 'base'); let notices = 0;
        const listener = () => notices++;
        for (const event of ['settings-bindings-updated', 'settings-api-configs-updated']) events.addEventListener(event, listener);
        const proto = Object.getPrototypeOf(Object.getPrototypeOf(db.table('entries'))), put = proto.put;
        proto.put = function(value, ...args) { return value.key === bindingKey ? Promise.reject(new Error('injected deletion failure')) : put.call(this, value, ...args); };
        try { await assert.rejects(storage.saveApiConfigs(apis.filter(api => api.id !== 'base')), /deletion failure/); }
        finally {
            proto.put = put;
            for (const event of ['settings-bindings-updated', 'settings-api-configs-updated']) events.removeEventListener(event, listener);
        }
        assert.deepEqual(await persisted(), before); assert.deepEqual(storage.loadBindingConfig(), before);
        assert.deepEqual(storage.loadApiConfigs(), beforeApis);
        assert.deepEqual(JSON.parse((await db.table('entries').get(apiKey)).value), apis);
        assert.equal(notices, 0); assert.equal(run.signal.aborted, false); run.finish();
        await storage.saveCharacterApiConfig('alice', 'next');
        assert.equal(chat(await persisted()).apiConfigId, 'next');
    });
    await t.test('successful deletion publishes API and binding caches together before either event', async () => {
        await seed(); const observed = [];
        const listener = () => observed.push({ missing: !storage.loadApiConfigs().some(api => api.id === 'base'), binding: chat(storage.loadBindingConfig()).apiConfigId });
        for (const event of ['settings-bindings-updated', 'settings-api-configs-updated']) events.addEventListener(event, listener);
        try { await storage.saveApiConfigs(apis.filter(api => api.id !== 'base')); }
        finally { for (const event of ['settings-bindings-updated', 'settings-api-configs-updated']) events.removeEventListener(event, listener); }
        assert.deepEqual(observed, [{ missing: true, binding: 'base' }, { missing: true, binding: 'base' }]);
        await assertCacheMatchesDisk();
    });
    await t.test('queued default cleanup and binding updater read the committed selection rather than a stale snapshot', async () => {
        await seed(); let observed;
        await overlapCommit(apiKey, () => storage.saveApiConfigs(apis.filter(api => api.id !== 'base')), () => [
            storage.saveCharacterApiConfig('alice', 'other'),
            storage.ensureGlobalBindingDefaults(),
            storage.saveBindingConfig(latest => {
                observed = { chat: chat(latest).apiConfigId, global: latest.globalDefaults.apiConfigId,
                    apiIds: storage.loadApiConfigs().map(api => api.id) };
                return { ...latest, globalDefaults: { ...latest.globalDefaults, worldBookIds: ['updated-world'] } };
            }),
        ]);
        assert.deepEqual(observed, { chat: 'other', global: 'next', apiIds: ['next', 'other'] });
        await assertCacheMatchesDisk();
        assert.equal(chat(await persisted()).apiConfigId, 'other');
        assert.deepEqual(chat(await persisted()).worldBookIds, ['updated-world']);
    });
    await t.test('API commits preserve original legacy role resource bindings before their first normal read', async () => {
        await seed(); kv.kvRemove(bindingKey); await db.table('entries').delete(bindingKey);
        const legacyKey = 'ai_phone_char_settings_v1';
        await kv.kvSetAsync(legacyKey, JSON.stringify([{ characterId: 'alice', presetId: 'legacy-preset', worldBookId: 'legacy-world', regexId: 'legacy-regex' }]));
        try {
            await storage.saveApiConfigs(apis.filter(api => api.id !== 'base'));
            assert.deepEqual((await persisted()).characterBindings[0].defaults,
                { presetId: 'legacy-preset', worldBookIds: ['legacy-world'], regexIds: ['legacy-regex'] });
            await assertCacheMatchesDisk();
        } finally { kv.kvRemove(legacyKey); await db.table('entries').delete(legacyKey); }
    });
    db.close();
});
