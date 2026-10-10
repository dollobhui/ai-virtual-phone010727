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
        await page.getByRole('button', { name: '更多功能', exact: true }).waitFor();
        const before = await snapshot();
        await check('flat complete API list, no model/key/folder fields, switch preserves history and base binding', async () => {
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
            assert.deepEqual(after.bindings.characterBindings[0].appOverrides, before.bindings.characterBindings[0].appOverrides);
            assert.equal(after.bindings.characterBindings[0].onlineText.apiConfigId, 'next');
        });
        await check('actual prompt builder isolates offline and calls and keeps preset/context', async () => {
            await page.getByRole('button', { name: '检查范围', exact: true }).click();
            await page.waitForFunction(() => document.querySelector('[data-testid="scopes"]').textContent.startsWith('['));
            const scopes = JSON.parse(await page.getByTestId('scopes').textContent());
            for (const scope of scopes) {
                assert.equal(scope.api, scope.tag === 'text' ? 'next' : 'base');
                assert.equal(scope.preset, 'fixture-preset');
                assert.ok(JSON.stringify(scope.messages).includes('original-user-context'));
            }
            assert.ok(JSON.stringify(scopes.find(scope => scope.tag === 'text').messages).includes('worldbook-context'));
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
            await page.getByRole('button', { name: '结束后台生成', exact: true }).click();
            await page.getByRole('button', { name: '关闭切换模型' }).click();
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
            assert.equal(after.bindings.characterBindings[0].onlineText.apiConfigId, 'next');
            await page.reload({ waitUntil: 'networkidle' });
            await page.getByRole('button', { name: '重新选择', exact: true }).click();
            await page.getByRole('button', { name: '工作配置', exact: true }).click();
            await page.getByRole('dialog').waitFor({ state: 'hidden' });
            assert.equal(await page.getByRole('button', { name: '重新选择', exact: true }).count(), 0);
        });
        await check('request failure preserves the selected API', async () => {
            failure = true;
            await page.getByTitle('触发 AI 主动回复', { exact: true }).click();
            await page.getByText(/发送失败.*401/).waitFor();
            assert.equal((await snapshot()).bindings.characterBindings[0].onlineText.apiConfigId, 'other');
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
