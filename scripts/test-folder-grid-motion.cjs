const assert = require('node:assert/strict');
const path = require('node:path');

// Tests actual rendered positions, trusted input, and IndexedDB persistence.
module.exports = async function testFolderGridMotion(browser, baseUrl, engine, screenshotDir) {
    const context = await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const check = async (name, fn) => { await fn(); console.log('PASS',engine,name); };
    const cards = () => page.locator('[data-folder-id]');
    const card = name => cards().filter({has:page.locator('span').filter({hasText:new RegExp('^'+name+'$')})});
    const order = () => cards().evaluateAll(nodes=>nodes.map(node=>node.dataset.folderId));
    const startSort = async () => {
        await page.getByRole('button',{name:'管理文件夹 未分类',exact:true}).click();
        await page.getByRole('button',{name:'排序',exact:true}).click();
    };
    const save = async () => {
        await page.getByRole('button',{name:'保存排序',exact:true}).click();
        await page.getByRole('button',{name:'保存排序',exact:true}).waitFor({state:'hidden'});
    };
    // Pause native animations deterministically so assertions inspect real halfway pixels.
    await page.addInitScript(() => {
        const animate = Element.prototype.animate;
        Element.prototype.animate = function(frames, options) {
            const animation = animate.call(this, frames, options);
            if (this.matches('[data-folder-id], [data-folder-drag-overlay]')) {
                (window.__gridAnimations ??= []).push({element:this,animation,frames,options});
                if (window.__pauseGridAnimations) { animation.pause(); animation.currentTime = 100; }
            }
            return animation;
        };
    });
    try {
        await page.goto(baseUrl+'/folder-test',{waitUntil:'networkidle',timeout:120000});
        await card('未分类').waitFor();
        const longName = '长名称文件夹验证右侧菜单始终对齐测试';
        for (const name of ['短',longName,'第三','第四']) {
            await page.getByRole('button',{name:'新建文件夹',exact:true}).click();
            await page.getByRole('textbox',{name:'文件夹名称'}).fill(name);
            await page.getByRole('button',{name:'保存',exact:true}).click();
            await page.getByRole('textbox',{name:'文件夹名称'}).waitFor({state:'hidden'});
        }
        const initialOrder = await order();
        const assertLayout = async () => {
            const metrics = await cards().evaluateAll(nodes=>nodes.map(node=>{
                const menu=node.querySelector('button'), arrow=node.querySelector('[data-folder-arrow]');
                const m=menu.getBoundingClientRect(), a=arrow.getBoundingClientRect(), c=node.getBoundingClientRect();
                return {menuWidth:m.width,menuHeight:m.height,delta:Math.abs(m.x+m.width/2-a.x-a.width/2),ratio:c.width/c.height,x:c.x,y:c.y};
            }));
            assert.equal(metrics.length,5);
            metrics.forEach(m=>{assert.ok(m.menuWidth>=44 && m.menuHeight>=44);assert.ok(m.delta<.5,JSON.stringify(m));assert.ok(Math.abs(m.ratio-1.5)<.01);});
            assert.equal(metrics[0].y,metrics[1].y); assert.ok(metrics[1].x>metrics[0].x);
            const input=page.getByRole('textbox',{name:'搜索当前类别的全部配置'});
            assert.equal(await input.getAttribute('placeholder'),'搜索全部文件夹中的配置');
            assert.equal(await input.locator('..').locator('svg').count(),0);
            const padding=await input.evaluate(node=>parseFloat(getComputedStyle(node).paddingLeft));
            assert.ok(padding>=8 && padding<=20,'normal search padding: '+padding);
            assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        };
        await check('phone search icon removed, 44px menus align with arrows including long names/unclassified',assertLayout);
        if (screenshotDir) await page.screenshot({path:path.join(screenshotDir,engine+'-phone-folders.png'),fullPage:true});
        await check('pointer follow, floating scale/shadow, real cross-column yielding and smooth drop',async()=>{
            await startSort();
            const source=await card('未分类').boundingBox(), target=await card('第三').boundingBox();
            assert.ok(target.x>source.x && target.y>source.y,'crosses both columns and rows');
            const start={x:source.x+source.width/2,y:source.y+source.height/2};
            await page.mouse.move(start.x,start.y); await page.mouse.down();
            await page.mouse.move(start.x+25,start.y+18);
            const overlay=page.locator('[data-folder-drag-overlay]'); await overlay.waitFor();
            const follow=await overlay.boundingBox();
            assert.ok(Math.abs(follow.x+follow.width/2-start.x-25)<1);
            assert.ok(Math.abs(follow.y+follow.height/2-start.y-18)<1);
            assert.ok(follow.width>source.width*1.02);
            assert.notEqual(await overlay.evaluate(node=>getComputedStyle(node).boxShadow),'none');
            await page.evaluate(()=>{window.__pauseGridAnimations=true;window.__gridAnimations=[];});
            await page.mouse.move(target.x+target.width/2,target.y+target.height/2);
            await page.waitForFunction(()=>window.__gridAnimations.some(record=>record.element.hasAttribute('data-folder-id')));
            const yieldMotion=await page.evaluate(()=>window.__gridAnimations.filter(record=>record.element.hasAttribute('data-folder-id')).map(record=>{
                const visual=record.element.getBoundingClientRect(),slot=record.element.parentElement.getBoundingClientRect();
                const first=record.frames[0].transform;
                const matrix=new DOMMatrix(first);
                return {duration:record.options.duration,remaining:Math.hypot(visual.x-slot.x,visual.y-slot.y),start:Math.hypot(matrix.m41,matrix.m42)};
            }));
            assert.ok(yieldMotion.length);
            yieldMotion.forEach(m=>{assert.equal(m.duration,200);assert.ok(m.remaining>0 && m.remaining<m.start,'real interpolated yielding '+JSON.stringify(m));});
            await page.evaluate(()=>{window.__gridAnimations.forEach(record=>record.animation.play());window.__gridAnimations=[];});
            await page.mouse.up();
            await page.waitForFunction(()=>window.__gridAnimations.some(record=>record.element.hasAttribute('data-folder-drag-overlay')));
            assert.equal(await page.getByRole('button',{name:'保存排序'}).isDisabled(),true);
            const dropMotion=await page.evaluate(()=>{
                const record=window.__gridAnimations.find(record=>record.element.hasAttribute('data-folder-drag-overlay'));
                const visual=record.element.getBoundingClientRect();
                const slot=[...document.querySelectorAll('[data-folder-slot]')].find(node=>node.dataset.folderSlot===record.element.dataset.folderDragOverlay).getBoundingClientRect();
                return {duration:record.options.duration,delta:Math.abs(visual.width-slot.width),target:record.frames[1].transform};
            });
            assert.equal(dropMotion.duration,200); assert.ok(dropMotion.delta>0 && dropMotion.delta<source.width*.035);
            assert.ok(dropMotion.target.endsWith('scale(1)'));
            await page.evaluate(()=>{window.__pauseGridAnimations=false;window.__gridAnimations.forEach(record=>record.animation.play());});
            await overlay.waitFor({state:'hidden'});
            const moved=await order(); assert.notDeepEqual(moved,initialOrder);
            await save();
            await page.reload({waitUntil:'networkidle'}); await card('未分类').waitFor(); assert.deepEqual(await order(),moved);
        });
        await check('keyboard moves animate, focus survives reordering, cancel preserves saved order',async()=>{
            const saved=await order(); await startSort();
            await page.evaluate(()=>window.__gridAnimations=[]);
            await card('未分类').focus();
            for (const key of ['ArrowLeft','ArrowUp','ArrowRight','ArrowDown']) {
                await page.keyboard.press(key);
                assert.equal(await card('未分类').evaluate(node=>document.activeElement===node),true,'focus retained after '+key);
            }
            assert.ok(await page.evaluate(()=>window.__gridAnimations.some(record=>record.element.hasAttribute('data-folder-id'))),'keyboard uses real animations');
            await page.keyboard.press('Shift+F10');
            assert.equal(await page.getByRole('button',{name:'重命名',exact:true}).count(),0);
            await page.getByRole('button',{name:'取消',exact:true}).click();
            assert.deepEqual(await order(),saved);
        });
        if (engine==='chromium') await check('trusted touch crosses columns/rows, long hold cannot open menu in sort mode, pointer cancel cleans up',async()=>{
            await startSort();
            const source=await card('未分类').boundingBox(), target=await cards().first().boundingBox();
            assert.ok(source.x>target.x && source.y>target.y,'touch crosses both columns and rows');
            const session=await context.newCDPSession(page);
            const points=rect=>[{x:rect.x+rect.width/2,y:rect.y+rect.height/2}];
            await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points(source)});
            await page.waitForTimeout(650);
            assert.equal(await page.getByRole('button',{name:'重命名',exact:true}).count(),0);
            await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:source.x+source.width/2-20,y:source.y+source.height/2-15}]});
            const following=await page.locator('[data-folder-drag-overlay]').boundingBox();
            assert.ok(Math.abs(following.x+following.width/2-source.x-source.width/2+20)<1);
            await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:points(target)});
            await page.waitForFunction(()=>document.querySelector('[data-folder-slot]')?.dataset.folderSlot==='__unclassified__');
            const overlay=await page.locator('[data-folder-drag-overlay]').boundingBox();
            assert.ok(Math.abs(overlay.x+overlay.width/2-target.x-target.width/2)<1);
            await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
            await save();
            await startSort();
            const rect=await card('未分类').boundingBox();
            await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points(rect)});
            await session.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
            await page.locator('[data-folder-drag-overlay]').waitFor({state:'hidden'});
            assert.equal(await page.getByRole('button',{name:'保存排序'}).isDisabled(),false);
            await page.getByRole('button',{name:'取消',exact:true}).click(); await session.detach();
        });
        if (engine==='chromium') await check('normal touch scroll cancels long press, sorting does not scroll the page',async()=>{
            await page.locator('.page-body').evaluate(node=>{node.style.height='380px';node.scrollTop=0;});
            const session=await context.newCDPSession(page);
            await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:60,y:300}]});
            for (let y=285;y>=165;y-=15) await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:60,y}]});
            await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
            await page.waitForFunction(()=>document.querySelector('.page-body').scrollTop>0);
            assert.equal(await page.getByRole('button',{name:'排序',exact:true}).count(),0);
            await page.locator('.page-body').evaluate(node=>{node.style.height='100dvh';node.scrollTop=0;});
            await startSort();
            const rect=await card('未分类').boundingBox(), scroll=await page.locator('.page-body').evaluate(node=>node.scrollTop);
            await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rect.x+rect.width/2,y:rect.y+rect.height/2}]});
            await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:rect.x+rect.width/2+20,y:rect.y+rect.height/2+20}]});
            assert.equal(await page.locator('.page-body').evaluate(node=>node.scrollTop),scroll);
            await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
            await page.locator('[data-folder-drag-overlay]').waitFor({state:'hidden'});
            await page.getByRole('button',{name:'取消',exact:true}).click();await session.detach();
        });
        await check('leaving the page during drag removes the floating card and pointer capture',async()=>{
            await startSort();const rect=await card('未分类').boundingBox();
            await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down();
            await page.locator('[data-folder-drag-overlay]').waitFor();
            // Another navigation source can change the mounted page during a gesture.
            await page.locator('[data-tab="voice"]').evaluate(node=>node.click());
            await page.locator('[data-folder-drag-overlay]').waitFor({state:'hidden'});await page.mouse.up();
            await page.locator('[data-tab="api"]').click();await card('未分类').waitFor();
        });
        await check('reduced motion removes scale/animations, pointer outside grid settles and persists',async()=>{
            await page.emulateMedia({reducedMotion:'reduce'}); await startSort();
            const rect=await card('未分类').boundingBox();
            await page.evaluate(()=>window.__gridAnimations=[]);
            await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down();
            const overlay=await page.locator('[data-folder-drag-overlay]').boundingBox();
            assert.ok(Math.abs(overlay.width-rect.width)<.5);
            await page.mouse.move(370,700); await page.mouse.up();
            await page.locator('[data-folder-drag-overlay]').waitFor({state:'hidden'});
            assert.equal(await page.evaluate(()=>window.__gridAnimations.length),0);
            await save(); const saved=await order();
            await page.reload({waitUntil:'networkidle'});await card('未分类').waitFor(); assert.deepEqual(await order(),saved);
        });
        await check('desktop layout and all four shared configuration pages retain aligned actions',async()=>{
            await page.setViewportSize({width:1280,height:900}); await assertLayout();
            if (screenshotDir) await page.screenshot({path:path.join(screenshotDir,engine+'-desktop-folders.png'),fullPage:true});
            for (const tab of ['voice','worldbook','presets']) {
                await page.locator('[data-tab="'+tab+'"]').click();await card('未分类').waitFor();
                const delta=await card('未分类').evaluate(node=>{const m=node.querySelector('button').getBoundingClientRect(),a=node.querySelector('[data-folder-arrow]').getBoundingClientRect();return Math.abs(m.x+m.width/2-a.x-a.width/2)});
                assert.ok(delta<.5);
                assert.equal(await page.getByRole('textbox',{name:'搜索当前类别的全部配置'}).locator('..').locator('svg').count(),0);
            }
        });
        assert.deepEqual(errors,[]);
    } finally { await context.close(); }
};
