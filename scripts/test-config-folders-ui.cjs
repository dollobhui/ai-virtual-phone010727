const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const fixtureDir = path.join(root, 'app', 'folder-test');
const fixtureFile = path.join(fixtureDir, 'page.tsx');
const fixtureSource = path.join(root, 'scripts', 'fixtures', 'config-folders-page.tsx');
const baseUrl = 'http://127.0.0.1:' + (process.env.FOLDER_TEST_PORT || '3017');
(async () => {
    if (fs.existsSync(fixtureDir)) throw new Error('Refusing to overwrite an existing app/folder-test route');
    fs.mkdirSync(fixtureDir);
    fs.copyFileSync(fixtureSource, fixtureFile);
    const logPath = path.join(os.tmpdir(), 'config-folders-test-' + Date.now() + '.log');
    const logFile = fs.openSync(logPath, 'w');
    const server = spawn(process.execPath, ['--max-old-space-size=8192','scripts/local-next-server.mjs','--dev','--host','127.0.0.1','--port',process.env.FOLDER_TEST_PORT || '3017'], {
        cwd:root, env:{...process.env,NEXT_PUBLIC_SELF_HOSTED_MODE:'true',NEXT_TELEMETRY_DISABLED:'1'}, stdio:['ignore',logFile,logFile], windowsHide:true,
    });
    try {
    for (let attempt=0;attempt<120;attempt++) {
        if (server.exitCode !== null) throw new Error('Test server exited: '+fs.readFileSync(logPath,'utf8'));
        try { await fetch(baseUrl+'/icon-192.png'); break; } catch { await new Promise(resolve=>setTimeout(resolve,500)); }
    }
    const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || (process.platform === 'win32' && fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined),headless:true});
    const context = await browser.newContext({ viewport:{width:440,height:900}, hasTouch:true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror',error => errors.push(error.message));
    const check = async (name,fn) => { await fn(); console.log('PASS',name); };
    const card = name => page.locator('[data-folder-id]').filter({has:page.locator('span').filter({hasText:new RegExp('^'+name+'$')})});
    const createFolder = async name => {
        await page.getByRole('button',{name:'新建文件夹',exact:true}).click();
        await page.getByRole('textbox',{name:'文件夹名称'}).fill(name);
        await page.getByRole('button',{name:'保存',exact:true}).click();
        await page.getByRole('textbox',{name:'文件夹名称'}).waitFor({state:'hidden'});
    };
    const metadata = category => page.evaluate(async category => {
        const db = await new Promise((resolve,reject) => {const req=indexedDB.open('AiPhoneKvDB');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
        const record = await new Promise((resolve,reject) => {const req=db.transaction('entries').objectStore('entries').get('ai_phone_config_folders_'+category+'_v1');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
        db.close();return record ? JSON.parse(record.value) : {folders:[],assignments:{},order:['__unclassified__']};
    },category);
    const moveSelected = async name => {
        await page.getByRole('button',{name:'移动到',exact:true}).click();
        await page.getByRole('combobox').selectOption({label:name});
        await page.getByRole('button',{name:'确定',exact:true}).click();
        await page.getByRole('combobox').waitFor({state:'hidden'});
    };
    try {
        await page.goto(baseUrl+'/folder-test',{waitUntil:'networkidle',timeout:120000});
        await card('未分类').waitFor();
        await check('API double-column folders, name validation and duplicate names',async()=>{
            await createFolder('工作'); await createFolder('收藏');
            const rects=await page.locator('[data-folder-id]').evaluateAll(nodes=>nodes.map(node=>({x:node.getBoundingClientRect().x,y:node.getBoundingClientRect().y,w:node.getBoundingClientRect().width})));
            assert.equal(rects[0].y,rects[1].y);assert.ok(rects[1].x>rects[0].x);assert.ok(rects[2].y>rects[0].y);
            await page.getByRole('button',{name:'新建文件夹',exact:true}).click();
            await page.getByRole('textbox',{name:'文件夹名称'}).fill(' 未分类 ');
            await page.getByRole('button',{name:'保存',exact:true}).click();
            await page.getByRole('alert').filter({hasText:'保留名称'}).first().waitFor();
            await page.getByRole('button',{name:'取消',exact:true}).click();
            assert.equal((await metadata('api')).folders.length,2);
        });
        await check('desktop grid drag moves unclassified and persists after refresh',async()=>{
            await page.getByRole('button',{name:'管理文件夹 工作',exact:true}).click();
            await page.getByRole('button',{name:'排序',exact:true}).click();
            const from=await card('未分类').boundingBox(),to=await card('收藏').boundingBox();
            await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();
            await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:8});await page.mouse.up();
            await page.getByRole('button',{name:'保存排序'}).click();
            await page.getByRole('button',{name:'保存排序'}).waitFor({state:'hidden'});
            const order=(await metadata('api')).order;assert.notEqual(order[0],'__unclassified__');
            await page.reload({waitUntil:'networkidle'});await card('未分类').waitFor();
            assert.deepEqual(await page.locator('[data-folder-id]').evaluateAll(nodes=>nodes.map(node=>node.dataset.folderId)),order);
        });
        await check('API cross-folder basic search, batch move and cancelled creation cleanup',async()=>{
            await page.getByRole('textbox',{name:'搜索当前类别的全部配置'}).fill('test-model');
            await page.getByRole('button',{name:'批量选择'}).click();
            await page.getByRole('button',{name:'全选',exact:true}).click();
            await moveSelected('工作');
            const meta=await metadata('api');assert.equal(meta.assignments['fixture-api'],meta.folders.find(folder=>folder.name==='工作').id);
            await page.getByRole('textbox',{name:'搜索当前类别的全部配置'}).fill('fixture-secret');
            await page.getByText('没有匹配的配置',{exact:true}).waitFor();
            await page.getByRole('textbox',{name:'搜索当前类别的全部配置'}).fill('');
            await card('工作').click();
            await page.getByRole('button',{name:'新增API方案'}).click();
            await page.locator('.modal-header-btn-muted').click();
            await page.locator('.modal-sheet').waitFor({state:'hidden'});
            assert.deepEqual(Object.keys((await metadata('api')).assignments),['fixture-api']);
        });
        await check('API editor connection test retains provider/model resolution',async()=>{
            await page.route('https://example.test/**',route=>route.fulfill({json:{choices:[{message:{role:'assistant',content:'fixture hello'}}]}}));
            await page.getByRole('button',{name:'编辑 Alpha API',exact:true}).click();
            await page.getByRole('button',{name:'测试连接',exact:true}).click();
            await page.getByText(/测试成功! 模型回复:/).waitFor({timeout:30000});
            await page.locator('.modal-header-btn-action').click();
        });
        await check('folder deletion confirms name/count and retains original configuration',async()=>{
            await page.getByRole('button',{name:'返回文件夹主页',exact:true}).click();
            await page.getByRole('button',{name:'管理文件夹 工作',exact:true}).click();
            await page.getByRole('button',{name:'删除文件夹',exact:true}).click();
            await page.getByText(/「工作」包含 1 个配置/).waitFor();
            await page.getByRole('button',{name:'确认',exact:true}).click();
            await card('工作').waitFor({state:'hidden'});
            await card('未分类').click();await page.getByRole('button',{name:'编辑 Alpha API',exact:true}).waitFor();
        });
        await check('voice folders are independent, new creation goes into current folder',async()=>{
            await page.locator('[data-tab="voice"]').click();await card('未分类').waitFor();
            assert.equal((await metadata('voice')).folders.length,0);
            await createFolder('声音');await card('声音').click();
            await page.getByRole('button',{name:'新增语音方案'}).click();
            await page.locator('.modal-header-btn-action').click();
            const meta=await metadata('voice');assert.equal(Object.keys(meta.assignments).length,1);
            await page.getByRole('button',{name:'编辑 新语音配置',exact:true}).click();
            await page.locator('input[type=password]').fill('fixture-secret');
            await page.getByRole('button',{name:/克隆/}).click();
            await page.getByText('克隆 Minimax 音色',{exact:true}).waitFor();
            await page.route('https://api.minimaxi.com/v1/files/upload',route=>route.fulfill({json:{file:{file_id:'fixture-file'},base_resp:{status_code:0}}}));
            await page.route('https://api.minimaxi.com/v1/voice_clone',route=>route.fulfill({json:{base_resp:{status_code:0}}}));
            await page.getByPlaceholder('例如 voice_xxx',{exact:true}).fill('fixture_cloned_voice');
            await page.locator('input[type=file]').setInputFiles({name:'fixture.wav',mimeType:'audio/wav',buffer:Buffer.alloc(256)});
            await page.getByRole('button',{name:'开始克隆并写入 Voice ID',exact:true}).click();
            await page.getByText('克隆 Minimax 音色',{exact:true}).waitFor({state:'hidden'});
            await page.getByRole('option',{name:'克隆音色 (fixture_cloned_voice)',exact:true}).waitFor({state:'attached'});
            // Valid silent WAV: exercise the native browser audio decoder and the
            // existing TTS request without calling a paid provider.
            const audio=Buffer.alloc(44+88200);
            audio.write('RIFF',0);audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);
            audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);
            audio.writeUInt32LE(44100,24);audio.writeUInt32LE(88200,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);
            audio.write('data',36);audio.writeUInt32LE(88200,40);
            let requestVoice;
            await page.route('https://api.minimaxi.com/v1/t2a_v2',route=>{
                requestVoice=route.request().postDataJSON();
                return route.fulfill({json:{data:{audio:audio.toString('hex')},base_resp:{status_code:0}}});
            });
            await page.evaluate(()=>{
                const play=HTMLMediaElement.prototype.play;
                HTMLMediaElement.prototype.play=async function(...args) { const result=await play.apply(this,args);window.__folderAudioPlayed=true;return result; };
            });
            await page.locator('button.ui-icon-btn[data-active]').click();
            await page.waitForFunction(()=>window.__folderAudioPlayed===true);
            assert.equal(requestVoice.voice_setting.voice_id,'fixture_cloned_voice');
            assert.equal(requestVoice.model,'speech-2.8-turbo');
            await page.locator('.modal-header-btn-action').click();
        });
        await check('worldbook import destination, failure isolation and no body search',async()=>{
            await page.locator('[data-tab="worldbook"]').click();await card('未分类').waitFor();
            await createFolder('设定');
            await page.getByRole('button',{name:'导入世界书',exact:true}).click();
            await page.getByRole('combobox').selectOption({label:'设定'});
            await page.getByRole('button',{name:'确定',exact:true}).click();
            await page.locator('input[type=file]').first().setInputFiles({name:'import-book.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({name:'Imported Book',entries:[]}))});
            await page.waitForFunction(()=>document.querySelector('[data-folder-id]')?.textContent);
            await page.getByRole('textbox',{name:'搜索当前类别的全部配置'}).fill('Imported Book');
            await page.getByRole('button',{name:'编辑 Imported Book',exact:true}).waitFor();
            const before=await metadata('worldbook');assert.equal(Object.keys(before.assignments).length,1);
            await page.getByRole('textbox',{name:'搜索当前类别的全部配置'}).fill('secret-body-not-searchable');
            await page.getByText('没有匹配的配置',{exact:true}).waitFor();
            await page.getByRole('button',{name:'导入世界书',exact:true}).click();await page.getByRole('button',{name:'确定',exact:true}).click();
            await page.locator('input[type=file]').first().setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{bad')});
            await page.getByText(/无法解析世界书文件/).waitFor();
            assert.deepEqual(await metadata('worldbook'),before);
            await page.getByRole('button',{name:'知道了',exact:true}).click();
        });
        await check('preset built-in move/copy/reset and prompt selection isolation',async()=>{
            await page.locator('[data-tab="presets"]').click();await card('未分类').waitFor();
            await createFolder('预设组');await card('未分类').click();
            const names=await page.locator('[aria-label^="编辑 "]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')));assert.ok(names.length);
            await page.getByRole('button',{name:'批量选择'}).click();await page.getByRole('button',{name:'全选',exact:true}).click();await moveSelected('预设组');
            await page.getByRole('button',{name:'返回文件夹主页',exact:true}).click();await card('预设组').click();
            await page.getByRole('button',{name:names[0],exact:true}).click();
            await page.getByRole('button',{name:'多选',exact:true}).click();
            await page.getByRole('button',{name:'全选可见',exact:true}).click();
            assert.equal(await page.getByRole('button',{name:'移动到',exact:true}).count(),0);
            await page.getByRole('button',{name:'完成',exact:true}).click();
            await page.getByRole('button',{name:'复制预设',exact:true}).click();
            await page.getByRole('button',{name:'删除预设',exact:true}).waitFor();
            const meta=await metadata('preset');const target=meta.folders.find(folder=>folder.name==='预设组').id;assert.ok(Object.values(meta.assignments).every(id=>id===target));
            await page.getByRole('button',{name:'页面返回'}).click();
            await page.getByRole('button',{name:'批量选择',exact:true}).waitFor();
            assert.equal(await page.getByRole('button',{name:'移动到',exact:true}).count(),0);
            await page.getByRole('button',{name:names[0],exact:true}).click();
            await page.getByRole('button',{name:'重置默认',exact:true}).click();
            await page.getByRole('button',{name:/重置/}).last().click();
            assert.deepEqual(await metadata('preset'),meta);
            await page.getByRole('button',{name:'页面返回'}).click();
            await page.getByRole('button',{name:'返回文件夹主页',exact:true}).click();
            await page.screenshot({path:process.env.FOLDER_TEST_SCREENSHOT || path.join(os.tmpdir(),'config-folders-ui.png'),fullPage:true});
        });
        await check('touch long-press menu, rename and keyboard grid sorting',async()=>{
            await page.locator('[data-tab="worldbook"]').click();await card('设定').waitFor();
            const target=card('设定');const rect=await target.boundingBox();
            const touch=await context.newCDPSession(page);
            await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rect.x+20,y:rect.y+25}]});
            await page.getByRole('button',{name:'重命名',exact:true}).waitFor();
            await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
            await page.getByRole('button',{name:'重命名',exact:true}).click();
            await page.getByRole('textbox',{name:'文件夹名称'}).fill('  设定收藏  ');
            await page.getByRole('button',{name:'保存',exact:true}).click();await card('设定收藏').waitFor();
            await page.getByRole('button',{name:'管理文件夹 未分类',exact:true}).click();await page.getByRole('button',{name:'排序',exact:true}).click();
            await card('未分类').focus();await page.keyboard.press('ArrowRight');
            await page.getByRole('button',{name:'保存排序'}).click();await page.getByRole('button',{name:'保存排序'}).waitFor({state:'hidden'});
            assert.equal((await metadata('worldbook')).order[1],'__unclassified__');
            await page.getByRole('button',{name:'管理文件夹 未分类',exact:true}).click();await page.getByRole('button',{name:'排序',exact:true}).click();
            const start=await card('未分类').boundingBox(),end=await card('设定收藏').boundingBox();
            await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:start.x+start.width/2,y:start.y+start.height/2}]});
            await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:end.x+end.width/2,y:end.y+end.height/2}]});
            await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
            await page.getByRole('button',{name:'保存排序'}).click();await page.getByRole('button',{name:'保存排序'}).waitFor({state:'hidden'});
            assert.equal((await metadata('worldbook')).order[0],'__unclassified__');
            await touch.detach();
        });
        assert.deepEqual(errors,[]);
        console.log('PASS no browser runtime errors');
    } finally { await browser.close(); }
    } finally {
        server.kill();
        fs.closeSync(logFile);
        if (fs.existsSync(fixtureFile) && fs.readFileSync(fixtureFile,'utf8') === fs.readFileSync(fixtureSource,'utf8')) {
            fs.unlinkSync(fixtureFile);
            fs.rmdirSync(fixtureDir);
        }
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
