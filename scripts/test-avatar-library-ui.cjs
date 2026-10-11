const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname,'..');
const routeDir = path.join(root,'app','avatar-test');
const logPath = path.join(root,'avatar-ui-test.log');
const baseUrl = 'http://127.0.0.1:'+(process.env.AVATAR_TEST_PORT || '3018');
const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" rx="24" fill="#294b58"/><circle cx="90" cy="65" r="28" fill="#eee0d2"/><path d="M35 160 Q35 100 90 100 Q145 100 145 160" fill="#1e2836"/></svg>');

(async()=>{
    if(fs.existsSync(routeDir)) throw Error('Refusing to overwrite avatar-test route');
    fs.mkdirSync(routeDir); fs.copyFileSync(path.join(root,'scripts','fixtures','avatar-library-page.tsx'),path.join(routeDir,'page.tsx'));
    const logFd = fs.openSync(logPath,'w');
    const server = spawn(process.execPath,['--max-old-space-size=8192','scripts/local-next-server.mjs','--dev','--host','127.0.0.1','--port',process.env.AVATAR_TEST_PORT || '3018'],{cwd:root,env:{...process.env,NEXT_PUBLIC_SELF_HOSTED_MODE:'true',NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore',logFd,logFd],windowsHide:true});
    let browser;
    try {
        for(let n=0;n<120;n++) {
            if(server.exitCode !== null) throw Error('Server failed: '+fs.readFileSync(logPath,'utf8'));
            try { await fetch(baseUrl+'/icon-192.png'); break; } catch { await new Promise(r=>setTimeout(r,500)); }
        }
        browser = await chromium.launch({executablePath:process.env.CHROME_PATH || (process.platform==='win32' && fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined),headless:true});
        const context = await browser.newContext({ viewport:{width:440,height:900},acceptDownloads:true });
        const page = await context.newPage(); const errors=[];
        page.on('pageerror',e=>errors.push(e.message));
        await page.route('https://avatars.test/**',route=>route.fulfill({status:200,contentType:'image/svg+xml',body:image}));
        let mode='accepted',requests=[];
        await page.route('https://llm.avatar.test/**',async route=>{
            const body=route.request().postDataJSON(); requests.push(body);
            const prompt=JSON.stringify(body.messages);
            const id=prompt.match(/\[(?:接受|拒绝)头像推荐:(msg_[^\]"\\\s]+)\]/)?.[1];
            const text = id ? (mode==='markerOnly' ? `[接受头像推荐:${id}]` : mode==='accepted' ? `好呀，我这就换上。\n[接受头像推荐:${id}]` : `我想保留现在的头像。\n[拒绝头像推荐:${id}]`) : '普通图片很漂亮。[接受头像推荐]';
            if(body.stream) {
                const chunks = [text.slice(0,8),text.slice(8)];
                const sse = chunks.map(content=>'data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\n').join('')+'data: [DONE]\n\n';
                await route.fulfill({status:200,contentType:'text/event-stream',body:sse});
            } else await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ choices:[{message:{role:'assistant',content:text}}] })});
        });
        const check = async(name,work)=>{ await work(); console.log('PASS',name); };
        const state = ()=>page.evaluate(async()=>{
            const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('AiPhoneKvDB');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
            const get=key=>new Promise((resolve,reject)=>{const req=db.transaction('entries').objectStore('entries').get(key);req.onsuccess=()=>resolve(req.result ? JSON.parse(req.result.value):null);req.onerror=()=>reject(req.error)});
            const library=await get('ai_phone_avatar_library_v1'),characters=await get('ai_phone_characters_v1');db.close();return {library,characters};
        });
        const add = async text=>{ await page.getByRole('button',{name:'添加 URL',exact:true}).click(); await page.getByRole('textbox',{name:'每行一个 URL，或 描述：URL'}).fill(text); await page.getByRole('button',{name:'保存',exact:true}).click(); await page.getByRole('dialog').waitFor({state:'hidden'}); };
        const resources=async()=>{await page.getByRole('button',{name:'测试：资源库',exact:true}).click();await page.getByRole('button',{name:'添加 URL',exact:true}).waitFor();};
        const share=async(name,index=0)=>{await page.getByRole('button',{name:'分享给 TA 换上',exact:true}).nth(index).click();await page.getByRole('combobox',{name:'角色',exact:true}).selectOption({label:name});await page.getByRole('button',{name:'发送推荐',exact:true}).click();await page.getByTitle('触发 AI 主动回复',{exact:true}).waitFor();};
        await page.goto(baseUrl+'/avatar-test',{waitUntil:'networkidle',timeout:120000});
        await page.getByRole('button',{name:'添加 URL',exact:true}).waitFor();
        await check('URL add and batch with descriptions',async()=>{
            await add('黑色西装头像：https://avatars.test/a.png');
            await add('https://avatars.test/b.png\n情侣之一：https://avatars.test/c.png\nhttps://avatars.test/b.png');
            assert.equal((await state()).library.images.length,3); assert.equal(await page.locator('article').count(),3);
        });
        await check('folders create/rename/move/delete without losing images',async()=>{
            await page.getByRole('button',{name:'新建文件夹',exact:true}).click();await page.getByRole('textbox',{name:'文件夹名称'}).fill('收藏');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
            await page.getByRole('button',{name:'移动',exact:true}).first().click();await page.getByRole('combobox',{name:'目标文件夹'}).selectOption({label:'收藏'});await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
            await page.getByRole('combobox',{name:'当前文件夹'}).selectOption({label:'收藏'});assert.equal(await page.locator('article').count(),1);
            await page.getByRole('button',{name:'重命名',exact:true}).click();await page.getByRole('textbox',{name:'文件夹名称'}).fill('西装');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
            await page.getByRole('button',{name:'删除文件夹',exact:true}).click();await page.getByRole('status').filter({hasText:'文件夹已删除'}).waitFor();assert.equal(await page.locator('article').count(),3);
        });
        await check('edit description and recycle restore',async()=>{
            await page.getByRole('button',{name:'描述',exact:true}).first().click();await page.getByRole('textbox',{name:'图片描述'}).fill('换头像用的黑色西装');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
            await page.getByRole('button',{name:'删除',exact:true}).first().click();await page.getByRole('status').filter({hasText:'已移入回收站'}).waitFor();await page.getByRole('button',{name:'回收站',exact:true}).click();assert.equal(await page.locator('article').count(),1);
            await page.getByRole('button',{name:'恢复',exact:true}).click();await page.getByRole('status').filter({hasText:'图片已恢复'}).waitFor();await page.getByRole('button',{name:'返回头像库',exact:true}).click();assert.equal(await page.locator('article').count(),3);
        });
        await check('JSON export/import merge, duplicates and invalid payload rejection',async()=>{
            const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出 JSON',exact:true}).click();const file=await download;const text=fs.readFileSync(await file.path(),'utf8');assert.equal(JSON.parse(text).images.length,3);
            await page.getByLabel('导入头像库 JSON').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(text)});await page.getByRole('status').filter({hasText:'新增 0 张'}).waitFor();
            await page.getByLabel('导入头像库 JSON').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{}')});await page.getByRole('status').filter({hasText:'格式或版本不正确'}).waitFor();assert.equal((await state()).library.images.length,3);
        });
        await check('browser reload preserves avatar library',async()=>{await page.reload({waitUntil:'networkidle'});await page.getByRole('button',{name:'分享给 TA 换上',exact:true}).first().waitFor();assert.equal(await page.locator('article').count(),3);});
        await check('share → existing chat → generated acceptance → live and historical avatars',async()=>{
            await share('小爱');await page.getByTitle('触发 AI 主动回复',{exact:true}).click();await page.locator('.chat-sys-msg').filter({hasText:'小爱更换了头像'}).waitFor({timeout:30000});
            assert.equal((await state()).characters.find(x=>x.id==='alice').avatar,'https://avatars.test/a.png');
            assert.ok(requests.length); assert.match(JSON.stringify(requests.at(-1).messages),/换头像用的黑色西装/);
            assert.ok(await page.locator('.chat-msg-avatar img[src="https://avatars.test/a.png"]').count()>=2);
            assert.equal(await page.getByText('好呀，我这就换上。',{exact:true}).count(),1);
            assert.equal(await page.getByText('[接受头像推荐]',{exact:true}).count(),0);
            const screenshot=process.env.AVATAR_SCREENSHOT; if(screenshot) await page.screenshot({path:screenshot,fullPage:true});
        });
        await check('chat list reflects updated avatar and stays correct after reload',async()=>{
            await page.getByRole('button',{name:'测试：聊天列表',exact:true}).click();await page.locator('img[src="https://avatars.test/a.png"]').first().waitFor();await page.reload({waitUntil:'networkidle'});assert.equal((await state()).characters.find(x=>x.id==='alice').avatar,'https://avatars.test/a.png');
        });
        await check('role refusal keeps previous avatar and normal reply',async()=>{
            mode='declined';await resources();await share('小白');await page.getByTitle('触发 AI 主动回复',{exact:true}).click();await page.locator('.chat-markdown-paragraph').filter({hasText:'我想保留现在的头像。'}).waitFor({timeout:30000});assert.equal((await state()).characters.find(x=>x.id==='bob').avatar,'https://avatars.test/old.png');assert.equal(await page.getByText('小白更换了头像',{exact:true}).count(),0);
        });
        await check('ordinary image does not trigger change even if model emits acceptance tag',async()=>{
            await page.getByRole('button',{name:'测试：普通图片',exact:true}).click();await page.getByTitle('触发 AI 主动回复',{exact:true}).click();await page.locator('.chat-markdown-paragraph').filter({hasText:'普通图片很漂亮。'}).waitFor({timeout:30000});assert.equal((await state()).characters.find(x=>x.id==='bob').avatar,'https://avatars.test/old.png');
        });
        await check('streamed acceptance follows the same persistence and avatar update mechanism',async()=>{
            mode='accepted';await page.getByRole('button',{name:'测试：下次流式回复',exact:true}).click();await share('小白',1);await page.getByTitle('触发 AI 主动回复',{exact:true}).click();await page.locator('.chat-sys-msg').filter({hasText:'小白更换了头像'}).waitFor({timeout:30000});assert.equal((await state()).characters.find(x=>x.id==='bob').avatar,'https://avatars.test/b.png');assert.equal(requests.at(-1).stream,true);
        });
        await check('marker-only model reply still resolves without a visible control-tag bubble',async()=>{
            mode='markerOnly';await resources();await share('小爱',1);await page.getByTitle('触发 AI 主动回复',{exact:true}).click();await page.locator('.chat-sys-msg').filter({hasText:'小爱更换了头像'}).nth(1).waitFor({timeout:30000});assert.equal((await state()).characters.find(x=>x.id==='alice').avatar,'https://avatars.test/b.png');
        });
        assert.deepEqual(errors,[]);console.log('PASS no browser runtime errors');
    } finally {
        await browser?.close();server.kill();fs.closeSync(logFd);
        // Fixed test-owned route only; no computed recursive removal.
        fs.unlinkSync(path.join(routeDir,'page.tsx'));fs.rmdirSync(routeDir);
    }
})().catch(error=>{console.error(error);process.exitCode=1});
