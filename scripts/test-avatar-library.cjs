const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
require('fake-indexeddb/auto');
const root = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...args) { return resolve.call(this, request.startsWith('@/') ? path.join(root, request.slice(2)) : request, ...args); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const local = new Map();
global.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key,value) => local.set(key,value), removeItem: key => local.delete(key), key: index => [...local.keys()][index] ?? null, get length() { return local.size; } };
const events = new EventTarget();
global.window = { localStorage, location: { origin: 'http://localhost:3000' }, dispatchEvent: e => events.dispatchEvent(e), addEventListener: (...a) => events.addEventListener(...a), removeEventListener: (...a) => events.removeEventListener(...a) };
const Dexie = require('dexie').default;
const kv = require('../lib/kv-db.ts');
const model = require('../lib/avatar-library.ts');
const store = require('../lib/avatar-library-storage.ts');
const characters = require('../lib/character-storage.ts');
const chat = require('../lib/chat-storage.ts');
const intent = require('../lib/chat-avatar-intent.ts');
const parser = require('../lib/rich-message-parser.ts');
const { shareLibraryAvatar } = require('../lib/avatar-library-share.ts');
const { DATA_MODULES } = require('../lib/data-management/modules.ts');
const db = new Dexie('AiPhoneKvDB'); db.version(1).stores({ entries:'key' });
const TablePrototype = Object.getPrototypeOf(Object.getPrototypeOf(db.table('entries')));
const persisted = async () => (await db.table('entries').get(model.AVATAR_LIBRARY_KEY))?.value;
const act = store.updateAvatarLibrary;
const add = (text,category='single',folderId=null) => act({ type:'add',text,category,folderId });

test('multi-select operations commit atomically and preserve input on collision', () => {
    let library = model.applyAvatarLibraryOperation(model.emptyAvatarLibrary(), {type:'add',text:'https://example.com/one.png\nhttps://example.com/two.png',category:'single',folderId:null}).library;
    library = model.applyAvatarLibraryOperation(library, {type:'add',text:'https://example.com/two.png',category:'couple',folderId:null}).library;
    const ids = library.images.filter(x=>x.category==='single').map(x=>x.id);
    const original = JSON.stringify(library);
    assert.throws(()=>model.applyAvatarLibraryOperation(library,{type:'batch',operations:ids.map(id=>({type:'move',id,category:'couple',folderId:null}))}),/相同 URL/);
    assert.equal(JSON.stringify(library),original);
    const deleted = model.applyAvatarLibraryOperation(library,{type:'batch',operations:ids.map(id=>({type:'delete',id}))}).library;
    assert.equal(deleted.images.filter(x=>x.deletedAt).length,2);
    const restored = model.applyAvatarLibraryOperation(deleted,{type:'batch',operations:ids.map(id=>({type:'restore',id}))}).library;
    assert.equal(restored.images.filter(x=>x.deletedAt).length,0);
    assert.equal(restored.images.length,3);
});

test('URL avatar library and existing chat integration', async t => {
    await t.test('URL-only and description + URL parsing; binary/unsafe URLs rejected', () => {
        const parsed = model.parseAvatarUrls('https://example.com/a.png\n黑色西装头像：https://example.com/b.png\nEnglish: https://example.com/c.png\n');
        assert.equal(parsed.entries.length,3); assert.equal(parsed.entries[1].description,'黑色西装头像'); assert.deepEqual(parsed.errors,[]);
        for(const text of ['data:image/png;base64,a','blob:https://example.com/a','javascript:alert(1)','https://user:password@example.com/a','broken']) assert.ok(model.parseAvatarUrls(text).errors.length);
    });
    await t.test('storage hydration failure refuses writes and can retry', async () => {
        const original = TablePrototype.toArray; const warn = console.warn; console.warn = () => {};
        TablePrototype.toArray = function(...a) { return this.name === 'entries' ? Promise.reject(Error('injected read failure')) : original.apply(this,a); };
        try { await assert.rejects(add('https://example.com/unsafe.png'),/读取失败/); assert.equal(kv.isKvHydrated(),false); }
        finally { TablePrototype.toArray = original; console.warn = warn; }
        await kv.hydrateKvDb();
    });
    await t.test('URL add, batch dedup, invalid batch is atomic', async () => {
        assert.equal((await add('https://example.com/a.png')).added,1);
        const result = await add('黑色西装：https://example.com/b.png\nhttps://example.com/b.png\nhttps://example.com/a.png');
        assert.equal(result.added,1); assert.equal(result.skipped,2);
        const before = await persisted();
        await assert.rejects(add('https://example.com/good.png\nbad'),/第 2 行/);
        assert.equal(await persisted(),before);
    });
    let folder, image;
    await t.test('folder create/rename, edit description and move between folders/categories', async () => {
        await act({type:'create-folder',name:'西装',category:'single'});
        let data = await store.loadAvatarLibrary(); folder = data.folders[0]; image = data.images[0];
        await act({type:'rename-folder',id:folder.id,name:'收藏'});
        await act({type:'edit',id:image.id,description:'分享描述'});
        await act({type:'move',id:image.id,category:'single',folderId:folder.id});
        data = await store.loadAvatarLibrary(); assert.equal(data.images[0].folderId,folder.id); assert.equal(data.images[0].description,'分享描述');
        await assert.rejects(act({type:'move',id:image.id,category:'couple',folderId:folder.id}),/分类不匹配/);
        await act({type:'move',id:image.id,category:'couple',folderId:null});
        assert.equal((await store.loadAvatarLibrary()).images[0].category,'couple');
        await act({type:'move',id:image.id,category:'single',folderId:folder.id});
    });
    await t.test('recycle restore, delete folder keeps active and deleted images', async () => {
        await act({type:'delete',id:image.id}); assert.ok((await store.loadAvatarLibrary()).images[0].deletedAt);
        assert.equal((await add(image.url)).skipped,1);
        await act({type:'delete-folder',id:folder.id});
        await act({type:'restore',id:image.id});
        const data = await store.loadAvatarLibrary(); assert.equal(data.images[0].folderId,null); assert.equal(data.images[0].deletedAt,undefined); assert.equal(data.images.length,2);
    });
    await t.test('JSON round trip, merge collision mapping, reimport is idempotent', async () => {
        const before = await store.loadAvatarLibrary();
        const incoming = model.emptyAvatarLibrary();
        incoming.folders = [{id:'external-folder',name:'情侣',category:'couple'}];
        incoming.images = [{id:before.images[0].id,url:'https://example.com/pair.png',description:'情侣头像',category:'couple',folderId:'external-folder'}, before.images[1]];
        const result = await act({type:'import',data:model.parseAvatarLibrary(JSON.stringify(incoming))});
        assert.equal(result.added,1); assert.equal(result.skipped,1);
        const pair = result.library.images.find(x=>x.url.endsWith('pair.png')); assert.notEqual(pair.id,before.images[0].id); assert.equal(pair.folderId,'external-folder');
        assert.deepEqual(result.library.images.slice(0,2),before.images);
        assert.equal((await act({type:'import',data:incoming})).added,0);
        assert.deepEqual(model.parseAvatarLibrary(JSON.stringify(result.library)),result.library);
        const collided = structuredClone(incoming); collided.folders[0].name='另一个'; collided.images[0].url='https://example.com/another.png';
        const mapped = await act({type:'import',data:collided});
        const added = mapped.library.images.at(-1); assert.notEqual(added.folderId,'external-folder'); assert.equal(mapped.library.folders.find(x=>x.id===added.folderId).name,'另一个');
    });
    await t.test('JSON validation and quota failures preserve existing data', async () => {
        const before = await persisted();
        for (const data of [{}, { ...model.emptyAvatarLibrary(),version:2 },{ ...model.emptyAvatarLibrary(),images:[{id:'bad',url:'data:image/png;a',description:'',category:'single',folderId:null}] },{...model.emptyAvatarLibrary(),images:[{id:'bad',url:'https://example.com/bad',description:'',category:'single',folderId:'missing'}]}]) await assert.rejects(act({type:'import',data}));
        assert.equal(await persisted(),before);
        const original = TablePrototype.put;
        TablePrototype.put = function(row,...a) { return row.key === model.AVATAR_LIBRARY_KEY ? Promise.reject(Error('quota')) : original.call(this,row,...a); };
        try { await assert.rejects(add('https://example.com/quota.png'),/quota/); assert.equal(await persisted(),before); assert.equal(kv.kvGet(model.AVATAR_LIBRARY_KEY),before); }
        finally { TablePrototype.put = original; }
    });
    await t.test('concurrent updates and other-tab data survive durable writes', async () => {
        await Promise.all(Array.from({length:8},(_,i)=>add(`https://example.com/concurrent-${i}.png`)));
        const data = model.parseAvatarLibrary(await persisted()); assert.equal(data.images.length,12);
        data.folders.push({id:'other-tab',category:'single',name:'其他标签页'});
        await db.table('entries').put({key:model.AVATAR_LIBRARY_KEY,value:JSON.stringify(data)});
        await add('https://example.com/new.png');
        assert.ok((await store.loadAvatarLibrary()).folders.some(x=>x.id==='other-tab'));
    });
    await t.test('corrupt persisted library is never overwritten', async () => {
        const good = await persisted();
        await kv.kvUpdateCommitted(model.AVATAR_LIBRARY_KEY,()=>'{broken');
        await assert.rejects(add('https://example.com/lost.png'),/原数据已保留/);
        assert.equal(await persisted(),'{broken');
        await kv.kvUpdateCommitted(model.AVATAR_LIBRARY_KEY,()=>good);
    });
    await t.test('library metadata registered with existing whole-phone backup', () => {
        assert.ok(DATA_MODULES.some(m=>m.sources.some(s=>s.type==='kv' && s.keys?.includes(model.AVATAR_LIBRARY_KEY))));
    });
    await chat.hydrateChatStorage();
    characters.saveCharacters(['alice','bob'].map(id=>({ id,name:id==='alice'?'小爱':'小白',avatar:'https://example.com/old.png',persona:'测试',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString() })));
    chat.addChatContact('alice'); chat.addChatContact('bob');
    let shared;
    await t.test('share sends existing image message with description/target and navigates existing chat', async () => {
        let launch; const handler = e=>launch=e.detail; events.addEventListener('open-app',handler);
        try { shared = await shareLibraryAvatar(image.id,'alice'); } finally { events.removeEventListener('open-app',handler); }
        assert.equal(shared.message.mediaType,'image'); assert.equal(shared.message.mediaUrl,image.url);
        assert.equal(shared.message.mediaData.label,'分享描述'); assert.equal(shared.message.mediaData.avatarRecommendationForCharacterId,'alice');
        assert.equal(launch.appId,'chat'); assert.equal(launch.sessionId,shared.session.id);
    });
    const reply = (sessionId,raw,extra={}) => chat.pushChatMessage({sessionId,role:'assistant',content:parser.parseAIResponse(raw,[]).parts.map(x=>x.content).join('\n\n'),rawResponseText:raw,responseBatchId:chat.createResponseBatchId(),...extra});
    await t.test('accepted recommendation changes only target; normal reply retained; one system notice', () => {
        const raw = `好呀，我这就换上。\n[接受头像推荐:${shared.message.id}]`;
        const saved = reply(shared.session.id,raw);
        assert.equal(saved.content,'好呀，我这就换上。'); assert.equal(characters.loadCharacters().find(x=>x.id==='alice').avatar,image.url);
        assert.equal(characters.loadCharacters().find(x=>x.id==='bob').avatar,'https://example.com/old.png');
        assert.equal(shared.message.mediaData.avatarRecommendationStatus,'accepted');
        assert.equal(chat.loadChatMessages(shared.session.id).filter(x=>x.role==='system' && x.content==='小爱更换了头像').length,1);
        reply(shared.session.id,raw); assert.equal(chat.loadChatMessages(shared.session.id).filter(x=>x.content==='小爱更换了头像').length,1);
    });
    await t.test('rejection wins over conflicting acceptance and preserves avatar', async () => {
        shared = await shareLibraryAvatar(image.id,'bob');
        reply(shared.session.id,`我想保留现在的头像。[接受头像推荐:${shared.message.id}][拒绝头像推荐:${shared.message.id}]`);
        assert.equal(shared.message.mediaData.avatarRecommendationStatus,'declined'); assert.equal(characters.loadCharacters().find(x=>x.id==='bob').avatar,'https://example.com/old.png');
    });
    await t.test('ordinary photos and own-avatar messages never opt in even with control markers', () => {
        const session = chat.createOrGetSession('bob');
        chat.pushChatMessage({sessionId:session.id,role:'user',content:'我换头像了',mediaType:'image',mediaUrl:'https://example.com/ordinary.png',mediaData:{label:'给你换头像'}});
        reply(session.id,'[接受头像推荐]');
        assert.equal(characters.loadCharacters().find(x=>x.id==='bob').avatar,'https://example.com/old.png');
    });
    await t.test('wrong target, wrong image ID, group and stale recommendations are ignored', async () => {
        const session = chat.createOrGetSession('bob');
        const marked = chat.pushChatMessage({sessionId:session.id,role:'user',content:'',mediaType:'image',mediaUrl:image.url,mediaData:{avatarRecommendationForCharacterId:'alice',avatarRecommendationStatus:'pending'}});
        reply(session.id,`[接受头像推荐:${marked.id}]`); assert.equal(marked.mediaData.avatarRecommendationStatus,'pending');
        shared = await shareLibraryAvatar(image.id,'bob'); reply(session.id,'[接受头像推荐:wrong-image]'); assert.equal(shared.message.mediaData.avatarRecommendationStatus,'pending');
        const group = chat.createGroupSession('group',['alice','bob']);
        const groupImage = chat.pushChatMessage({sessionId:group.id,role:'user',content:'',mediaType:'image',mediaUrl:image.url,mediaData:{avatarRecommendationForCharacterId:'bob',avatarRecommendationStatus:'pending'}});
        reply(group.id,`[接受头像推荐:${groupImage.id}]`); assert.equal(groupImage.mediaData.avatarRecommendationStatus,'pending');
        const old = chat.pushChatMessage({sessionId:session.id,role:'user',createdAt:new Date(Date.now()-31*60_000).toISOString(),content:'',mediaType:'image',mediaUrl:image.url,mediaData:{avatarRecommendationForCharacterId:'bob',avatarRecommendationStatus:'pending'}});
        reply(session.id,`[接受头像推荐:${old.id}]`); assert.equal(old.mediaData.avatarRecommendationStatus,'pending');
    });
    await t.test('newer ordinary photo and delayed replies cannot change a different recommendation', async () => {
        shared = await shareLibraryAvatar(image.id,'bob');
        chat.pushChatMessage({sessionId:shared.session.id,role:'user',content:'',mediaType:'image',mediaUrl:'https://example.com/normal.png'});
        reply(shared.session.id,`[接受头像推荐:${shared.message.id}]`); assert.equal(shared.message.mediaData.avatarRecommendationStatus,'pending');
        const first = await shareLibraryAvatar(image.id,'bob');
        const second = await shareLibraryAvatar(image.id,'bob');
        reply(second.session.id,`[接受头像推荐:${first.message.id}]`); assert.equal(second.message.mediaData.avatarRecommendationStatus,'pending');
        const third = await shareLibraryAvatar(image.id,'bob');
        reply(third.session.id,'[接受头像推荐]',{avatarRecommendationReplyToId:first.message.id}); assert.equal(third.message.mediaData.avatarRecommendationStatus,'pending');
        const fourth = await shareLibraryAvatar(image.id,'bob');
        reply(fourth.session.id,'我这就换上这张当头像',{avatarRecommendationReplyToId:null}); assert.equal(fourth.message.mediaData.avatarRecommendationStatus,'pending');
    });
    await t.test('momo natural fallback is conservative and regex protection hides only control markers', async () => {
        assert.equal(intent.inferAvatarDecisionFromReply('我这就换上这张当头像'),'accepted');
        for (const text of ['这张很好看','我收下了','你就用这张当头像','我帮你换头像','我不想换头像','以后再换头像','如果我换上头像会怎样','我换上头像了吗？','就用这张当头像[接受头像推荐:a][接受头像推荐:b]']) assert.notEqual(intent.inferAvatarDecisionFromReply(text),'accepted');
        const protectedReply = intent.applyWithProtectedAvatarDecisionMarkers('好的[接受头像推荐:abc]',text=>text.replace(/\[[^\]]+\]/g,''));
        assert.equal(protectedReply,'好的[接受头像推荐:abc]'); assert.equal(parser.parseAIResponse(protectedReply,[]).parts[0].content,'好的');
        shared = await shareLibraryAvatar(image.id,'bob'); reply(shared.session.id,'我这就换上这张当头像');
        assert.equal(shared.message.mediaData.avatarRecommendationStatus,'accepted');
    });
    await t.test('stream preview removes completed and incomplete recommendation controls', () => {
        const {cleanStreamText}=require('../lib/stream-preview.ts');
        for(const marker of ['[接受头像推荐:abc]','【拒绝头像推荐】','[接受头像推荐:','[接受头像推']) assert.equal(cleanStreamText('好呀。'+marker),'好呀。');
    });
    await t.test('disk survives new module cache (refresh) and stores metadata only', async () => {
        const disk = model.parseAvatarLibrary(await persisted());
        assert.deepEqual(disk,await store.loadAvatarLibrary()); assert.ok(disk.images.every(x=>/^https?:/.test(x.url)));
        await new Promise(resolve=>setTimeout(resolve,100));
        const diskCharacters = JSON.parse((await db.table('entries').get('ai_phone_characters_v1')).value);
        assert.equal(diskCharacters.find(x=>x.id==='bob').avatar,image.url);
        const chatDb = require('../lib/chat-db.ts').chatDb;
        const stored = await chatDb.messages.get(shared.message.id); assert.equal(stored.mediaData.avatarRecommendationStatus,'accepted');
    });
});
