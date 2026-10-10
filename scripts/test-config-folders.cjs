// Run with: node --test scripts/test-config-folders.cjs
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
require.extensions['.ts'] = (module, filename) => {
    const source = fs.readFileSync(filename, 'utf8');
    module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
};
const local = new Map();
global.localStorage = {
    getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key),
    key: index => [...local.keys()][index] ?? null, get length() { return local.size; },
};
const events = new EventTarget();
// JSZip's browser Blob path needs FileReader; Node supplies Blob but not FileReader.
global.FileReader = class {
    readAsArrayBuffer(blob) {
        blob.arrayBuffer().then(result => { this.result = result; this.onload?.({ target: this }); }, error => this.onerror?.(error));
    }
};
global.window = { localStorage, location: { origin: 'http://localhost:3000' }, dispatchEvent: event => events.dispatchEvent(event), addEventListener: (...args) => events.addEventListener(...args), removeEventListener: (...args) => events.removeEventListener(...args) };
const Dexie = require('dexie').default;
const kv = require('../lib/kv-db.ts');
const folders = require('../lib/config-folder-storage.ts');
const types = require('../lib/config-folder-types.ts');
const { importSource, exportSource } = require('../lib/data-management/idb.ts');
const { DATA_MODULES } = require('../lib/data-management/modules.ts');
const { createBackupBlob, importBackupBlob } = require('../lib/data-management/backup.ts');
const { resolveBinding, loadBindingConfig } = require('../lib/settings-storage.ts');
const { hydrateSettingsDb, readPresetsCache, readWorldBooksCache, addImportedPresetCacheAsync, addImportedWorldBookCacheAsync } = require('../lib/settings-db.ts');
const db = new Dexie('AiPhoneKvDB');
db.version(1).stores({ entries: 'key' });
const TablePrototype = Object.getPrototypeOf(Object.getPrototypeOf(db.table('entries')));
const persisted = async category => (await db.table('entries').get(types.CONFIG_FOLDER_KEYS[category]))?.value ?? null;
const act = (category, operation) => folders.updateConfigFolders(category, operation);
const key = types.CONFIG_FOLDER_KEYS.api;

test('folder data safety and backup lifecycle', async t => {
    await t.test('read failure refuses mutation and retries without deleting old data', async () => {
        await db.table('entries').put({ key, value: JSON.stringify(types.emptyConfigFolders()) });
        const original = TablePrototype.toArray;
        TablePrototype.toArray = function(...args) {
            if (this.name === 'entries') return Promise.reject(new Error('injected read failure'));
            return original.apply(this,args);
        };
        const warn = console.warn; console.warn = () => {};
        try {
            await assert.rejects(folders.loadConfigFolders('api'), /读取失败/);
            await assert.rejects(act('api', { type: 'create', id: 'unsafe', name: 'unsafe' }));
            assert.equal(kv.isKvHydrated(), false);
            assert.equal(await persisted('api'), JSON.stringify(types.emptyConfigFolders()));
        } finally { TablePrototype.toArray = original; console.warn = warn; }
        await kv.hydrateKvDb();
        assert.equal(kv.isKvHydrated(), true);
    });
    await t.test('four categories are independent; historical and external IDs are unclassified', async () => {
        for (const category of types.CONFIG_FOLDER_CATEGORIES) {
            assert.equal(types.configFolderFor(await folders.loadConfigFolders(category), 'history'), types.UNCLASSIFIED_FOLDER_ID);
            await act(category, { type: 'create', id: category+'-folder', name: category });
            await act(category, { type: 'move', configIds: [category+'-config'], folderId: category+'-folder' });
        }
        const metadata = await folders.loadConfigFolders('api');
        assert.equal(metadata.folders.length, 1);
        assert.equal(types.configFolderFor(metadata, 'voice-config'), types.UNCLASSIFIED_FOLDER_ID);
        assert.equal(types.configFolderFor(metadata, 'external-new'), types.UNCLASSIFIED_FOLDER_ID);
    });
    await t.test('names trim, allow duplicates, count Unicode characters and reject reserved names', async () => {
        await act('api', { type: 'create', id: 'duplicate', name: '  api  ' });
        assert.deepEqual((await folders.loadConfigFolders('api')).folders.map(folder => folder.name), ['api','api']);
        for (const name of [' ', ' 未分类 ', '长'.repeat(31), '😀'.repeat(31)]) {
            await assert.rejects(act('api', { type: 'rename', id: 'duplicate', name }));
        }
        await act('api', { type: 'rename', id: 'duplicate', name: '😀'.repeat(30) });
    });
    await t.test('rapid operations retain every update and persist unclassified grid order', async () => {
        await Promise.all(Array.from({ length: 20 }, (_, index) => act('api', { type: 'move', configIds: ['rapid-'+index], folderId: 'api-folder' })));
        const metadata = await folders.loadConfigFolders('api');
        assert.equal(Object.keys(metadata.assignments).length, 21);
        const order = ['api-folder', types.UNCLASSIFIED_FOLDER_ID, 'duplicate'];
        await act('api', { type: 'reorder', order });
        assert.deepEqual(types.parseConfigFolders(await persisted('api')).order, order);
        assert.deepEqual(types.moveFolderInOrder(order, 0, 1), [types.UNCLASSIFIED_FOLDER_ID,'api-folder','duplicate']);
        await assert.rejects(act('api', { type: 'reorder', order: ['api-folder'] }));
    });
    await t.test('durable failure leaves cache and disk unchanged and never reports success', async () => {
        const before = await persisted('api');
        const original = TablePrototype.put;
        TablePrototype.put = function(record, ...args) {
            if (record.key === key) return Promise.reject(new Error('injected quota failure'));
            return original.call(this, record, ...args);
        };
        try {
            await assert.rejects(act('api', { type: 'rename', id: 'api-folder', name: 'must-not-save' }), /quota/);
            assert.equal(kv.kvGet(key), before);
            assert.equal(await persisted('api'), before);
        } finally { TablePrototype.put = original; }
        await act('api', { type: 'rename', id: 'api-folder', name: 'saved-after-failure' });
    });
    await t.test('corruption is not overwritten; read-modify-write uses durable latest data', async () => {
        const good = await persisted('api');
        for (const bad of ['{broken', '{}', JSON.stringify({ ...types.emptyConfigFolders(), order: [] })]) {
            await kv.kvUpdateCommitted(key, () => bad);
            await assert.rejects(folders.loadConfigFolders('api'), /损坏/);
            await assert.rejects(act('api', { type: 'create', id: 'unsafe', name: 'unsafe' }));
            assert.equal(await persisted('api'), bad);
            assert.equal(kv.kvGet(key), bad);
        }
        await folders.restoreConfigFolders('api',good,true);
        // Simulate a second tab writing without updating this tab's cache.
        const fresh = types.applyConfigFolderOperation(types.parseConfigFolders(good), { type: 'create', id: 'other-tab', name: '另一个标签页' });
        await db.table('entries').put({ key, value: JSON.stringify(fresh) });
        await act('api', { type: 'rename', id: 'api-folder', name: 'after-other-tab' });
        assert.ok((await folders.loadConfigFolders('api')).folders.some(folder => folder.id === 'other-tab'));
    });
    await t.test('delete folder changes metadata only; missing import targets fall back safely', async () => {
        const configs = [{ id: 'api-config', enabled: true, updatedAt: 123, apiKey: 'fixture-secret' }, { id: 'second', updatedAt: 456 }];
        await kv.kvUpdateCommitted('ai_phone_api_configs_v1', () => JSON.stringify(configs));
        await kv.kvUpdateCommitted('ai_phone_bindings_v1', () => JSON.stringify({ globalDefaults: { apiConfigId:'api-config', voiceConfigId:'voice-config', presetId:'preset-config', worldBookIds:['worldbook-config'] }, appDefaults: {}, characterBindings: [] }));
        const before = kv.kvGet('ai_phone_api_configs_v1');
        const binding = kv.kvGet('ai_phone_bindings_v1');
        const resolved = ['chat','story','diary'].map(app => resolveBinding(loadBindingConfig(),'fixture-character',app));
        await act('api', { type: 'delete', id: 'api-folder' });
        assert.equal(types.configFolderFor(await folders.loadConfigFolders('api'),'api-config'), types.UNCLASSIFIED_FOLDER_ID);
        assert.equal(kv.kvGet('ai_phone_api_configs_v1'), before);
        assert.equal(kv.kvGet('ai_phone_bindings_v1'), binding);
        assert.deepEqual(['chat','story','diary'].map(app => resolveBinding(loadBindingConfig(),'fixture-character',app)),resolved);
        assert.ok(!(await persisted('api')).includes('fixture-secret'));
        await assert.rejects(act('api', { type: 'move', configIds: ['second'], folderId: 'gone' }));
        await act('api', { type: 'move', configIds: ['imported'], folderId: 'gone', fallbackToUnclassified: true });
        assert.equal(types.configFolderFor(await folders.loadConfigFolders('api'),'imported'), types.UNCLASSIFIED_FOLDER_ID);
        await act('api', { type: 'delete', id: 'other-tab' }); // empty folder
        await act('api', { type: 'move', configIds: ['second'], folderId: 'duplicate' });
        await act('api', { type: 'remove-config', configId: 'second' });
        assert.ok((await folders.loadConfigFolders('api')).folders.some(folder => folder.id === 'duplicate'));
        assert.equal(Object.hasOwn((await folders.loadConfigFolders('api')).assignments,'second'),false);
    });
    await t.test('local and cloud source registry includes folders and cache excludes them', async () => {
        const settings = DATA_MODULES.find(module => module.id === 'settings');
        const source = settings.sources.find(source => source.type === 'kv');
        const payload = await exportSource(source);
        assert.equal(payload.records.filter(record => Object.values(types.CONFIG_FOLDER_KEYS).includes(record.key)).length, 4);
        const cache = DATA_MODULES.find(module => module.id === 'cache');
        const cacheSource = cache.sources.find(source => source.type === 'kv');
        assert.ok(Object.values(types.CONFIG_FOLDER_KEYS).every(key => cacheSource.excludeKeys.includes(key)));
        const backup = await createBackupBlob(['settings']);
        const before = await Promise.all(types.CONFIG_FOLDER_CATEGORIES.map(persisted));
        await folders.finishConfigFolderRestore(new Set());
        const result = await importBackupBlob(Buffer.from(await backup.blob.arrayBuffer()), ['settings'], { overwrite: true });
        assert.deepEqual(result.errors, []);
        assert.deepEqual(await Promise.all(types.CONFIG_FOLDER_CATEGORIES.map(persisted)), before);
    });
    await t.test('non-overwrite restore preserves classifications and reports unsupported merging', async () => {
        const before = await persisted('api');
        const result = await importSource({ type:'kv', label:'fixture', records:[{ key, value: JSON.stringify(types.emptyConfigFolders()) }] },false);
        assert.equal(result.skipped, 1);
        assert.match(result.errors.join(''), /非覆盖恢复/);
        assert.equal(await persisted('api'), before);
        const bad = await importSource({ type:'kv', label:'fixture', records:[{ key, value: '{broken' }] },true);
        assert.equal(bad.errors.length,1);
        assert.equal(await persisted('api'), before);
    });
    await t.test('failed whole-config imports do not change caches or create associations', async () => {
        await hydrateSettingsDb();
        const presets = readPresetsCache(); const books = readWorldBooksCache();
        const metadata = await Promise.all(types.CONFIG_FOLDER_CATEGORIES.map(persisted));
        const original = TablePrototype.add;
        TablePrototype.add = function(...args) {
            if (this.name === 'presets' || this.name === 'worldBooks') return Promise.reject(new Error('injected import failure'));
            return original.apply(this,args);
        };
        try {
            await assert.rejects(addImportedPresetCacheAsync({ id:'failed-preset' }), /import failure/);
            await assert.rejects(addImportedWorldBookCacheAsync({ id:'failed-book' }), /import failure/);
            assert.equal(readPresetsCache(),presets);
            assert.equal(readWorldBooksCache(),books);
            assert.deepEqual(await Promise.all(types.CONFIG_FOLDER_CATEGORIES.map(persisted)),metadata);
        } finally { TablePrototype.add = original; }
    });
    await t.test('old overwrite backup resets old ID associations to unclassified', async () => {
        const JSZip = require('jszip');
        const backup = await createBackupBlob(['settings']);
        const zip = await JSZip.loadAsync(Buffer.from(await backup.blob.arrayBuffer()));
        for (const file of Object.values(zip.files).filter(file => file.name.startsWith('modules/') && file.name.endsWith('.json'))) {
            const payload = JSON.parse(await file.async('string'));
            for (const source of payload.sources) if (source.type === 'kv') source.records = source.records.filter(record => !Object.values(types.CONFIG_FOLDER_KEYS).includes(record.key));
            zip.file(file.name,JSON.stringify(payload));
        }
        const result = await importBackupBlob(await zip.generateAsync({type:'nodebuffer'}), ['settings'], {overwrite:true});
        assert.deepEqual(result.errors, []);
        for (const category of types.CONFIG_FOLDER_CATEGORIES) assert.deepEqual(await folders.loadConfigFolders(category), types.parseConfigFolders(JSON.stringify(types.emptyConfigFolders())));
    });
    db.close();
});
