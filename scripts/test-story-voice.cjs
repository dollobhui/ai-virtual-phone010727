const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const originalLoad = Module._load;
Module._load = function (request, ...args) {
    if (request === '@/lib/reasoning-translate') return { translateReasoningText: async () => ({ content: '' }) };
    return originalLoad.call(this, request, ...args);
};
require.extensions['.tsx'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText, filename);
const { StoryHtmlRenderer } = require('../components/ui/story-html-renderer.tsx');
const render = (content, voice = true, messageId = 'story-fixture') => renderToStaticMarkup(React.createElement(StoryHtmlRenderer, {
    content, messageId, ...(voice ? { onVoicePlay: () => {} } : {}),
}));
const spokenTexts = html => [...html.matchAll(/data-story-voice-text="([^"]+)"/g)].map(match => decodeURIComponent(match[1]));

test('momo dialogue formats preserve ordered segments and legacy speaker metadata', () => {
    const html = render('她轻声说「你好。」\n⌈小夏：明天见。⌋\n“等一下！”\n“……”');
    assert.deepEqual(spokenTexts(html), ['你好。', '明天见。', '等一下！']);
    assert.match(html, /data-story-voice-speaker="%E5%B0%8F%E5%A4%8F"/);
    assert.equal((html.match(/aria-label="朗读这句对白"/g) || []).length, 3);
    assert.match(html, /data-story-voice-segment="story-fixture:md:0:2"/);
});

test('user messages and other consumers without voice callback keep existing rendering', () => {
    const html = render('「你好。」\n⌈小夏：明天见。⌋\n**保留加粗**', false);
    assert.deepEqual(spokenTexts(html), []);
    assert.match(html, /⌈小夏：明天见。⌋/);
    assert.match(html, /<strong>保留加粗<\/strong>/);
});

test('narration, thoughts, punctuation-only sounds and HTML pages are not queued', () => {
    const html = render('她走到窗边。\n*她想回家。*\n“……！”\n```html\n<div>「页面内容」</div>\n```');
    assert.deepEqual(spokenTexts(html), []);
    assert.match(html, /<em>她想回家。<\/em>/);
    assert.match(html, /<iframe/);
});

test('quoted markup is escaped and dialogue IDs are isolated per message', () => {
    const html = render('「<img src=x onerror=bad()>」', true, 'story-other');
    assert.deepEqual(spokenTexts(html), ['<img src=x onerror=bad()>']);
    assert.match(html, /&lt;img src=x onerror=bad\(\)&gt;/);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /story-other:md:0:0/);
});

test('folded sections remain lazy and do not enter the visible voice sequence', () => {
    const html = render('<!--RHR-FOLD:think-->「内部思考」<!--/RHR-FOLD-->\n「正文对白」');
    assert.deepEqual(spokenTexts(html), ['正文对白']);
    assert.match(html, /data-fold-tag="think"/);
});
