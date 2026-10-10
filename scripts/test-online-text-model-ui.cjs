const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const fixtureDir = path.join(root, 'app', 'online-text-test');
const fixtureFile = path.join(fixtureDir, 'page.tsx');
const port = process.env.MODEL_TEST_PORT || '3018';
const baseUrl = 'http://127.0.0.1:' + port;
(async () => {
    if (fs.existsSync(fixtureDir)) throw new Error('Refusing to overwrite an existing online-text-test route');
    fs.mkdirSync(fixtureDir);
    fs.copyFileSync(path.join(root, 'scripts', 'fixtures', 'online-text-model-page.tsx'), fixtureFile);
    const logPath = path.join(os.tmpdir(), 'online-text-model-' + Date.now() + '.log');
    const logFile = fs.openSync(logPath, 'w');
    const server = spawn(process.execPath, ['--max-old-space-size=8192', 'scripts/local-next-server.mjs', '--dev', '--host', '127.0.0.1', '--port', port], {
        cwd: root, env: { ...process.env, NEXT_PUBLIC_SELF_HOSTED_MODE: 'true', NEXT_TELEMETRY_DISABLED: '1' },
        stdio: ['ignore', logFile, logFile], windowsHide: true,
    });
    let browser;
    try {
        for (let attempt = 0; attempt < 120; attempt++) {
            if (server.exitCode !== null) throw new Error('Server exited: ' + fs.readFileSync(logPath, 'utf8'));
            try { await fetch(baseUrl + '/icon-192.png'); break; } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
        }
        browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'win32' && fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined), headless: true });
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const requests = [];
        let failure = false, delay = false, release;
        await page.route('https://example.test/**', async route => {
            if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
            requests.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
            if (delay) await new Promise(resolve => { release = resolve; });
            await route.fulfill({ status: failure ? 401 : 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(failure
                ? { error: { message: 'mock unauthorized' } }
                : { choices: [{ message: { role: 'assistant', content: '测试回复' }, finish_reason: 'stop' }] }) }).catch(() => {});
        });
        const check = async (name, work) => { await work(); console.log('PASS', name); };
        const snapshot = async () => {
            await page.getByRole('button', { name: '读取状态', exact: true }).click();
            return JSON.parse(await page.getByTestId('snapshot').textContent());
        };
        const open = async () => {
            await page.getByRole('button', { name: '更多功能', exact: true }).click();
            await page.getByRole('button', { name: '切换模型', exact: true }).click();
            await page.getByRole('dialog', { name: '切换模型', exact: true }).waitFor();
        };
        await page.goto(baseUrl + '/online-text-test', { waitUntil: 'networkidle', timeout: 180000 });
        // Keep the existing decorative floating-button animation from defeating click stability.
        await page.addStyleTag({ content: '.quick-action-float-button { animation:none !important; transition:none !important; }' });
        await page.getByRole('button', { name: '更多功能', exact: true }).waitFor();
        const before = await snapshot();
        await check('twelfth menu position, linear icon and inert legacy API', async () => {
            await page.getByRole('button', { name: '更多功能', exact: true }).click();
            const labels = await page.locator('.chat-plus-menu-item').allTextContents();
            assert.equal(labels[10], '语音条'); assert.equal(labels[11], '切换模型');
            const item = page.getByRole('button', { name: '切换模型', exact: true });
            const icon = item.locator('svg');
            assert.equal(await icon.getAttribute('width'), '22'); assert.equal(await icon.getAttribute('stroke-width'), '1.5');
            assert.equal(await icon.getAttribute('stroke'), 'var(--c-text)');
            assert.ok((await icon.getAttribute('class')).includes('lucide-sliders-horizontal'));
            const threeColumns = await page.addStyleTag({ content: '.chat-plus-menu { grid-template-columns:repeat(3,1fr) !important; }' });
            const positions = await page.locator('.chat-plus-menu-item').evaluateAll(elements => elements.map(element => {
                const rect = element.getBoundingClientRect(); return { x:rect.x, y:rect.y };
            }));
            assert.equal(positions[11].x, positions[2].x);
            assert.equal(positions[11].y, positions[9].y);
            assert.equal(new Set(positions.slice(0, 12).map(position => position.y)).size, 4);
            await threeColumns.evaluate(element => element.remove());
            await item.click();
            const dialog = page.getByRole('dialog', { name: '切换模型' });
            assert.equal(await dialog.getByRole('button', { name: '原配置', exact: true }).getAttribute('aria-pressed'), 'true');
            assert.equal(await dialog.getByRole('button', { name: '工作配置', exact: true }).getAttribute('aria-pressed'), 'false');
            await page.getByRole('button', { name: '关闭切换模型' }).click();
        });
        await check('model icon matches native icons in light/dark themes and custom SVG overrides', async () => {
            await page.getByRole('button', { name: '更多功能', exact: true }).click();
            const menu = page.locator('.chat-plus-menu');
            const measure = () => menu.locator('.chat-plus-menu-item').evaluateAll(items => items.slice(0, 12).map(item => {
                const icon = item.querySelector('svg'), box = item.querySelector('.chat-plus-icon-box');
                const css = getComputedStyle(icon), boxCss = getComputedStyle(box);
                const r = icon.getBoundingClientRect(), b = box.getBoundingClientRect();
                return { stroke:css.stroke, width:css.width, height:css.height, strokeWidth:css.strokeWidth,
                    linecap:css.strokeLinecap, linejoin:css.strokeLinejoin, fill:css.fill,
                    boxWidth:boxCss.width, boxHeight:boxCss.height,
                    offsetX:Math.round(Math.abs(r.x + r.width / 2 - b.x - b.width / 2) * 100) / 100,
                    offsetY:Math.round(Math.abs(r.y + r.height / 2 - b.y - b.height / 2) * 100) / 100 };
            }));
            const compare = async expectedStroke => {
                const metrics = await measure();
                assert.equal(metrics.length, 12);
                for (const index of [0, 2, 8, 10]) assert.deepEqual(metrics[11], metrics[index]);
                assert.equal(metrics[11].stroke, expectedStroke);
                assert.equal(metrics[11].width, '22px'); assert.equal(metrics[11].height, '22px');
                assert.equal(parseFloat(metrics[11].strokeWidth), 1.5);
                assert.equal(metrics[11].boxWidth, '44px'); assert.equal(metrics[11].boxHeight, '44px');
                assert.ok(metrics[11].offsetX < 1 && metrics[11].offsetY < 1);
            };
            for (const [theme, text, panel] of [['light', '#161616', '#f6f6f8'], ['dark', '#ffffff', '#292929']]) {
                // Deliberately retain a different parent color: the old currentColor icon failed here.
                const themeStyle = await page.addStyleTag({ content: `.chat-app { --c-text:${text}; --c-panel:${panel}; } .chat-plus-menu { color:#2c3440; grid-template-columns:repeat(3,1fr); background:var(--c-panel); }` });
                await compare(theme === 'light' ? 'rgb(22, 22, 22)' : 'rgb(255, 255, 255)');
                if (process.env.MODEL_ICON_SCREENSHOT_DIR) {
                    fs.mkdirSync(process.env.MODEL_ICON_SCREENSHOT_DIR, { recursive:true });
                    await menu.screenshot({ path:path.join(process.env.MODEL_ICON_SCREENSHOT_DIR, `model-icon-${theme}.png`), animations:'disabled' });
                }
                await themeStyle.evaluate(element => element.remove());
            }
            const customStyle = await page.addStyleTag({ content: '.chat-plus-icon-box svg[stroke="var(--c-text)"] { stroke:#a855f7; stroke-width:2.25; }' });
            const custom = await measure();
            for (const index of [0, 2, 8, 10]) assert.deepEqual(custom[11], custom[index]);
            assert.equal(custom[11].stroke, 'rgb(168, 85, 247)'); assert.equal(parseFloat(custom[11].strokeWidth), 2.25);
            await customStyle.evaluate(element => element.remove());
            await page.getByRole('button', { name: '更多功能', exact: true }).click();
        });
        await check('flat complete API list, no model/key/folder fields, switch preserves history and all non-API bindings', async () => {
            await open();
            const dialog = page.getByRole('dialog', { name: '切换模型' });
            for (const name of ['原配置', '收藏配置', '工作配置']) assert.equal(await dialog.getByRole('button', { name, exact: true }).count(), 1);
            const text = await dialog.textContent();
            assert.ok(!/hidden-model|saved-test-key|收藏文件夹|工作文件夹/.test(text));
            if (process.env.MODEL_TEST_SCREENSHOT) {
                await page.locator('nav').evaluate(element => { element.style.visibility = 'hidden'; });
                await page.screenshot({ path: process.env.MODEL_TEST_SCREENSHOT, animations: 'disabled' });
                await page.locator('nav').evaluate(element => { element.style.visibility = 'visible'; });
            }
            await dialog.getByRole('button', { name: '收藏配置', exact: true }).click();
            await dialog.waitFor({ state: 'hidden' });
            const after = await snapshot();
            assert.deepEqual(after.messages, before.messages);
            assert.deepEqual(after.apis, before.apis);
            assert.deepEqual(after.bindings.globalDefaults, before.bindings.globalDefaults);
            assert.equal(after.bindings.characterBindings[0].defaults.apiConfigId, 'next');
            assert.equal(after.bindings.characterBindings[0].appOverrides.chat.apiConfigId, 'next');
            assert.deepEqual(after.bindings.characterBindings[0].onlineText, before.bindings.characterBindings[0].onlineText);
        });
        const quick = async () => {
            await page.addStyleTag({ content: '.quick-action-float-button { animation:none !important; transition:none !important; }' });
            await page.getByRole('button', { name: '打开快捷操作', exact: true }).click();
            const popover = page.getByRole('dialog', { name: '快捷操作', exact: true });
            await popover.getByRole('button', { name: '角色', exact: true }).click();
            await popover.locator('select').selectOption('alice');
            return popover;
        };
        await check('chat picker and actual floating picker synchronize in both directions', async () => {
            let popover = await quick();
            assert.equal(await popover.getByRole('button', { name: '当前来源：默认 API（原配置）', exact: true }).count(), 1);
            assert.equal(await popover.getByRole('button', { name: '收藏配置', exact: true }).getAttribute('data-selected'), 'true');
            await popover.getByRole('button', { name: '工作配置', exact: true }).click();
            await page.waitForFunction(() => document.querySelector('.quick-action-option[data-selected="true"] span')?.textContent === '工作配置');
            await popover.getByRole('button', { name: '关闭快捷操作' }).click();
            await page.getByTitle('触发 AI 主动回复', { exact: true }).click();
            await page.getByText('测试回复', { exact: true }).first().waitFor();
            await page.getByRole('button', { name: '停止本轮生成' }).waitFor({ state: 'hidden' });
            assert.equal(requests.at(-1).body.model, 'other-hidden-model');
            assert.equal(requests.at(-1).headers.authorization, 'Bearer saved-test-key');
            await open(); const dialog = page.getByRole('dialog', { name: '切换模型' });
            assert.equal(await dialog.getByRole('button', { name: '工作配置', exact: true }).getAttribute('aria-pressed'), 'true');
            await dialog.getByRole('button', { name: '继承默认 API', exact: true }).click();
            popover = await quick();
            assert.equal(await popover.getByRole('button', { name: '原配置', exact: true }).getAttribute('data-selected'), 'true');
            await popover.getByRole('button', { name: '关闭快捷操作' }).click();
            await open(); await page.getByRole('dialog', { name: '切换模型' }).getByRole('button', { name: '收藏配置', exact: true }).click();
        });
        await check('actual prompt builder uses the shared API in text/offline/voice/video and keeps preset/context', async () => {
            await page.getByRole('button', { name: '检查范围', exact: true }).click();
            await page.waitForFunction(() => document.querySelector('[data-testid="scopes"]').textContent.startsWith('['));
            const scopes = JSON.parse(await page.getByTestId('scopes').textContent());
            for (const scope of scopes) {
                assert.equal(scope.api, 'next');
                assert.equal(scope.preset, 'fixture-preset');
                assert.ok(JSON.stringify(scope.messages).includes('original-user-context'));
            }
            assert.ok(JSON.stringify(scopes.find(scope => scope.tag === 'text').messages).includes('worldbook-context'));
        });
        await check('all model-switch variables can override scoped visuals and long mobile list scrolls', async () => {
            await page.getByRole('button', { name: '增加列表配置', exact: true }).click();
            const override = await page.addStyleTag({ content: ':root { --model-switch-modal-bg:#123456; --model-switch-title-color:#112233; --model-switch-text-color:#334455; --model-switch-secondary-color:#445566; --model-switch-item-bg:#223344; --model-switch-item-border:3px solid #345678; --model-switch-item-text:#556677; --model-switch-selected-bg:#456789; --model-switch-selected-border:4px solid #56789a; --model-switch-selected-text:#667788; --model-switch-close-color:#778899; --model-switch-radius:25px; --model-switch-shadow:0 2px 8px rgb(1,2,3); --model-switch-overlay-bg:rgba(1,2,3,.4); --model-switch-modal-border:2px solid #abcdef; --model-switch-item-radius:18px; --model-switch-item-shadow:0 1px 2px rgb(4,5,6); --model-switch-error-color:#8899aa; }' });
            await open();
            const dialog = page.getByRole('dialog', { name: '切换模型' });
            const metrics = await dialog.evaluate(element => {
                const css = target => { const c = getComputedStyle(target); return { bg:c.backgroundColor, color:c.color, radius:c.borderRadius, border:c.borderTopWidth, borderColor:c.borderTopColor, shadow:c.boxShadow }; };
                const body = element.querySelector('.modal-body');
                return { modal:css(element), title:css(element.querySelector('.modal-title')), hint:css(element.querySelector('.chat-model-switch-hint')), close:css(element.querySelector('.chat-model-switch-close')), item:css(element.querySelector('.chat-model-switch-option[aria-pressed="false"]')), selected:css(element.querySelector('[aria-pressed="true"]')), scroll:body.scrollHeight > body.clientHeight, overlay:css(element.parentElement) };
            });
            assert.equal(metrics.modal.bg, 'rgb(18, 52, 86)'); assert.equal(metrics.modal.color, 'rgb(51, 68, 85)');
            assert.equal(metrics.modal.radius, '25px'); assert.equal(metrics.modal.border, '2px'); assert.equal(metrics.modal.borderColor, 'rgb(171, 205, 239)'); assert.ok(metrics.modal.shadow.includes('rgb(1, 2, 3)'));
            assert.equal(metrics.title.color, 'rgb(17, 34, 51)'); assert.equal(metrics.hint.color, 'rgb(68, 85, 102)'); assert.equal(metrics.close.color, 'rgb(119, 136, 153)');
            assert.equal(metrics.item.bg, 'rgb(34, 51, 68)'); assert.equal(metrics.item.color, 'rgb(85, 102, 119)'); assert.equal(metrics.item.border, '3px'); assert.equal(metrics.item.borderColor, 'rgb(52, 86, 120)'); assert.equal(metrics.item.radius, '18px'); assert.ok(metrics.item.shadow.includes('rgb(4, 5, 6)'));
            assert.equal(metrics.selected.bg, 'rgb(69, 103, 137)'); assert.equal(metrics.selected.color, 'rgb(102, 119, 136)'); assert.equal(metrics.selected.border, '4px'); assert.equal(metrics.selected.borderColor, 'rgb(86, 120, 154)');
            assert.equal(metrics.overlay.bg, 'rgba(1, 2, 3, 0.4)'); assert.equal(metrics.scroll, true);
            await dialog.locator('.modal-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
            await dialog.getByRole('button', { name: '列表配置 39', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
            await open(); await page.getByRole('dialog', { name: '切换模型' }).getByRole('button', { name: '收藏配置', exact: true }).click();
            await override.evaluate(element => element.remove());
            await page.getByRole('button', { name: '恢复配置列表', exact: true }).click();
        });
        await check('selection survives reload and another role stays on its original API', async () => {
            await page.reload({ waitUntil: 'networkidle' }); await open();
            assert.equal(await page.getByRole('button', { name: '收藏配置', exact: true }).getAttribute('aria-pressed'), 'true');
            await page.getByRole('button', { name: '关闭切换模型' }).click();
            await page.getByRole('button', { name: 'bob', exact: true }).click(); await open();
            assert.equal(await page.getByRole('button', { name: '原配置', exact: true }).getAttribute('aria-pressed'), 'true');
            await page.getByRole('button', { name: '关闭切换模型' }).click();
            await page.getByRole('button', { name: 'alice', exact: true }).click();
        });
        await check('group, offline and theater do not offer the switch', async () => {
            await page.getByRole('button', { name: '测试群', exact: true }).click();
            await page.getByRole('button', { name: '更多功能' }).click();
            assert.equal(await page.getByRole('button', { name: '切换模型', exact: true }).count(), 0);
            await page.getByRole('button', { name: 'alice', exact: true }).click();
            await page.getByRole('button', { name: '线下模式', exact: true }).click();
            assert.equal(await page.getByRole('button', { name: '切换模型', exact: true }).count(), 0);
            await page.getByRole('button', { name: '返回线上模式', exact: true }).click();
            await page.getByRole('button', { name: '更多功能' }).click();
            await page.getByRole('button', { name: '番外指令模式', exact: true }).click();
            await page.getByRole('button', { name: '更多功能' }).click();
            assert.equal(await page.getByRole('button', { name: '切换模型', exact: true }).count(), 0);
            await page.getByRole('button', { name: '番外指令模式', exact: true }).click();
        });
        await check('background generation disables an open picker and prevents state changes', async () => {
            await open();
            await page.getByRole('button', { name: '模拟后台生成', exact: true }).click();
            assert.equal(await page.getByRole('button', { name: '工作配置', exact: true }).isDisabled(), true);
            await page.getByRole('button', { name: '关闭切换模型' }).click();
            const popover = await quick();
            assert.equal(await popover.getByRole('button', { name: '工作配置', exact: true }).isDisabled(), true);
            await popover.getByRole('button', { name: '关闭快捷操作' }).click();
            await page.getByRole('button', { name: '结束后台生成', exact: true }).click();
        });
        await check('actual offline generation uses the shared API and locks the floating picker', async () => {
            delay = true; release = undefined;
            await page.getByRole('button', { name: '请求线下生成', exact: true }).click();
            for (let attempt = 0; attempt < 100 && !release; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
            assert.ok(release);
            const popover = await quick();
            assert.equal(await popover.getByRole('button', { name: '工作配置', exact: true }).isDisabled(), true);
            assert.equal(requests.at(-1).body.model, 'next-hidden-model');
            await popover.getByRole('button', { name: '关闭快捷操作' }).click();
            delay = false; release();
            await page.waitForFunction(() => document.querySelector('[data-testid="offline-result"]').textContent === 'next-hidden-model');
        });
        await check('real generation uses saved key and new model, and disables switch', async () => {
            delay = true;
            await page.getByTitle('触发 AI 主动回复', { exact: true }).click();
            await page.waitForFunction(() => document.querySelector('[aria-label="停止本轮生成"]'));
            await page.getByRole('button', { name: '更多功能' }).click();
            assert.equal(await page.getByRole('button', { name: '切换模型', exact: true }).isDisabled(), true);
            for (let count = 0; count < 100 && !release; count++) await new Promise(resolve => setTimeout(resolve, 50));
            assert.ok(release); delay = false; release();
            await page.getByRole('button', { name: '停止本轮生成' }).waitFor({ state: 'hidden' });
            assert.equal(requests.at(-1).body.model, 'next-hidden-model');
            assert.equal(requests.at(-1).headers.authorization, 'Bearer saved-test-key');
            assert.ok(JSON.stringify(requests.at(-1).body.messages).includes('original-user-context'));
        });
        await check('API deletion cancels active generation, blocks retries without history changes, and survives reload', async () => {
            const previous = await snapshot();
            delay = true; release = undefined;
            await page.getByTitle('触发 AI 主动回复', { exact: true }).click();
            for (let attempt = 0; attempt < 100 && !release; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
            assert.ok(release);
            await page.getByRole('button', { name: '删除收藏配置', exact: true }).click();
            await page.getByRole('button', { name: '停止本轮生成' }).waitFor({ state: 'hidden' });
            delay = false; release();
            const count = requests.length;
            await page.getByRole('button', { name: '重新选择', exact: true }).waitFor();
            await page.getByTitle('触发 AI 主动回复', { exact: true }).click();
            const after = await snapshot();
            assert.equal(requests.length, count);
            assert.deepEqual(after.messages, previous.messages);
            assert.equal(after.bindings.characterBindings[0].appOverrides.chat.apiConfigId, 'next');
            await page.reload({ waitUntil: 'networkidle' });
            const popover = await quick();
            assert.ok((await popover.locator('.quick-action-section-heading').first().textContent()).includes('已删除的配置'));
            assert.equal(await popover.getByRole('button', { name: '工作配置', exact: true }).getAttribute('data-selected'), 'false');
            await popover.getByRole('button', { name: '关闭快捷操作' }).click();
            await page.getByRole('button', { name: '重新选择', exact: true }).click();
            const errorStyle = await page.addStyleTag({ content: ':root { --model-switch-error-color:#8899aa; }' });
            assert.equal(await page.locator('.chat-model-switch-error').evaluate(element => getComputedStyle(element).color), 'rgb(136, 153, 170)');
            await errorStyle.evaluate(element => element.remove());
            await page.getByRole('button', { name: '工作配置', exact: true }).click();
            await page.getByRole('dialog').waitFor({ state: 'hidden' });
            assert.equal(await page.getByRole('button', { name: '重新选择', exact: true }).count(), 0);
        });
        await check('request failure preserves the selected API', async () => {
            failure = true;
            await page.getByTitle('触发 AI 主动回复', { exact: true }).click();
            await page.getByText(/发送失败.*401/).waitFor();
            assert.equal((await snapshot()).bindings.characterBindings[0].appOverrides.chat.apiConfigId, 'other');
            assert.equal(requests.at(-1).body.model, 'other-hidden-model');
        });
        assert.deepEqual(errors, []);
        console.log('PASS no uncaught browser errors');
    } finally {
        if (browser) await browser.close();
        if (process.platform === 'win32' && server.pid) spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else server.kill();
        fs.closeSync(logFile);
        fs.unlinkSync(fixtureFile); fs.rmdirSync(fixtureDir);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
