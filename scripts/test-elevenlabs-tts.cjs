const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
    module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText, filename);
};

const eleven = require("../lib/elevenlabs-tts.ts");
// Exercise the existing dispatcher without loading unrelated browser storage.
const settingsPath = path.resolve(__dirname, "../lib/settings-storage.ts");
require.cache[settingsPath] = { id: settingsPath, filename: settingsPath, loaded: true, exports: {
    loadVoiceConfigs: () => [config],
    loadBindingConfig: () => ({}),
    resolveBinding: () => ({ voiceConfigId: config.id }),
} };
const tts = require("../lib/tts-service.ts");
const config = {
    id: "test-voice", provider: "ElevenLabs", apiKey: "test-key", defaultVoice: "voice/id",
    model: "eleven_multilingual_v2", enableTTS: true, enableSTT: false,
};

test("stage directions are removed while dialogue and ordinary parentheses survive", () => {
    assert.equal(eleven.cleanElevenLabsText("(breath) (low voice) [emotion] #1.0# 你好。"), "你好。");
    assert.equal(eleven.cleanElevenLabsText("{voice:whispers}（轻声）[sigh] 你好（周五见）。"), "你好（周五见）。");
    assert.equal(eleven.cleanElevenLabsText("Meet me at 5 (local time)."), "Meet me at 5 (local time).");
    assert.equal(eleven.cleanElevenLabsText("[emotion"), "");
    assert.throws(() => eleven.elevenLabsSpeechRequest("(breath) [emotion]", config), /没有可朗读/);
});

test("Y2K request contract uses Voice ID, HTTPS base path and supported model settings", () => {
    const request = eleven.elevenLabsSpeechRequest("(low voice) 你好", {
        ...config, baseUrl: "https://example.test/proxy/v2/", speechSpeed: 5,
        elevenLabs: { stability: -1, similarity: 2, style: .3, speakerBoost: false },
    });
    assert.equal(request.url, "https://example.test/proxy/v1/text-to-speech/voice%2Fid?output_format=mp3_44100_128");
    assert.deepEqual(request.body, { text: "你好", model_id: config.model, voice_settings: {
        stability: 0, similarity_boost: 1, style: .3, use_speaker_boost: false, speed: 1.2,
    } });
    assert.equal(eleven.elevenLabsSpeechRequest("你好", { ...config, model: "eleven_v3" }).body.voice_settings, undefined);
    assert.deepEqual(eleven.elevenLabsSpeechRequest("你好", {
        ...config, model: "eleven_v4", elevenLabs: { languageCode: "ZH" },
    }).body, { text: "你好", model_id: "eleven_v4", language_code: "zh",
        voice_settings: { stability: .5, similarity_boost: .75 } });
    assert.throws(() => eleven.elevenLabsSpeechRequest("你好", { ...config, defaultVoice: "" }), /Voice ID/);
    for (const baseUrl of ["http://example.test", "https://user:pass@example.test", "https://example.test?key=secret"]) {
        assert.throws(() => eleven.elevenLabsSpeechRequest("你好", { ...config, baseUrl }), /HTTPS/);
    }
});

test("existing TTS dispatch produces ElevenLabs audio without changing legacy providers", async t => {
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });
    const requests = [];
    global.fetch = async (url, init) => {
        requests.push({ url, init, body: JSON.parse(init.body) });
        if (url.endsWith("/t2a_v2")) return Response.json({ data: { audio: "010203" } });
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    };
    assert.equal(tts.resolveVoiceConfig("role-a").id, config.id);
    const blob = await tts.synthesizeSpeech("(breath) #1.0# 你好", config);
    assert.equal(blob.type, "audio/mpeg");
    assert.equal(blob.size, 3);
    assert.equal(requests[0].body.text, "你好");
    assert.equal(requests[0].init.headers["xi-api-key"], "test-key");
    assert.equal(requests[0].init.redirect, "error");
    await tts.synthesizeSpeech("你好", { ...config, provider: "OpenAI", defaultVoice: "alloy", model: "tts-1" });
    assert.equal(requests[1].body.input, "你好");
    assert.equal(requests[1].body.voice, "alloy");
    await tts.synthesizeSpeech("你好", { ...config, provider: "Minimax", model: "speech-01-turbo", defaultVoice: "legacy-id" });
    assert.equal(requests[2].body.voice_setting.voice_id, "legacy-id");
    assert.equal(await tts.synthesizeSpeech("   ", config), null);
});

test("voice sync paginates and deduplicates IDs while keeping display names", async t => {
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });
    let page = 0;
    global.fetch = async (url, init) => {
        assert.equal(init.headers["xi-api-key"], "test-key");
        assert.equal(new URL(url).pathname, "/v2/voices");
        assert.equal(new URL(url).searchParams.get("page_size"), "100");
        if (page++ === 0) return Response.json({ voices: [{ voice_id: "a", name: "Alice" }, { name: "invalid" }],
            has_more: true, next_page_token: "second" });
        assert.equal(new URL(url).searchParams.get("next_page_token"), "second");
        return Response.json({ voices: [{ voice_id: "a", name: "Alice" }, { voice_id: "b", name: "Bob" }], has_more: false });
    };
    assert.deepEqual(await eleven.listElevenLabsVoices(config), [{ id: "a", name: "Alice" }, { id: "b", name: "Bob" }]);
    global.fetch = async () => Response.json({ voices: [], has_more: true, next_page_token: "repeated" });
    await assert.rejects(eleven.listElevenLabsVoices(config), /分页异常/);
});

test("missing credentials, provider errors and invalid audio fail with safe messages", async t => {
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });
    await assert.rejects(eleven.synthesizeElevenLabs("你好", { ...config, apiKey: "" }), /API Key/);
    global.fetch = async () => Response.json({ detail: { message: "sensitive upstream text" } }, { status: 403 });
    await assert.rejects(eleven.synthesizeElevenLabs("你好", config), error =>
        /权限/.test(error.message) && !error.message.includes("sensitive"));
    global.fetch = async () => Response.json({ detail: { status: "quota_exceeded" } }, { status: 401 });
    await assert.rejects(eleven.synthesizeElevenLabs("你好", config), /额度不足/);
    global.fetch = async () => Response.json({ audio: "not audio" });
    await assert.rejects(eleven.synthesizeElevenLabs("你好", config), /不是音频/);
    global.fetch = async () => new Response(null, { headers: { "content-type": "audio/mpeg" } });
    await assert.rejects(eleven.synthesizeElevenLabs("你好", config), /空音频/);
});
