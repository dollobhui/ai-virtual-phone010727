"use client";
// Temporary browser-test route only; test runner creates and removes its page.
import { useEffect, useState } from "react";
import { ChatRoom } from "@/components/chat/chat-room";
import { QuickActionFloat } from "@/components/quick-action-float";
import { hydrateKvDb, kvGet, kvSetAsync } from "@/lib/kv-db";
import { hydrateSettingsDb } from "@/lib/settings-db";
import { saveCharacters } from "@/lib/character-storage";
import { createOrGetSession, createGroupSession, hydrateChatStorage, loadChatMessages, pushChatMessage, saveChatSessions, loadChatSessions, saveChatAppSettings, loadChatAppSettings, type ChatSession } from "@/lib/chat-storage";
import { createPreset, createWorldBook, savePresetsAsync, saveWorldBooks, loadBindingConfig, saveApiConfigs, removeApiConfigReferences } from "@/lib/settings-storage";
import { beginOnlineTextGeneration } from "@/lib/online-text-generation";
import { buildChatPromptMessages, generateOfflineChatCompletion } from "@/lib/chat-engine";

export default function Fixture() {
    const [session, setSession] = useState<ChatSession | null>(null);
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [stop, setStop] = useState<(() => void) | null>(null);
    const [snapshot, setSnapshot] = useState("");
    const [scopes, setScopes] = useState("");
    const [offlineResult, setOfflineResult] = useState("");
    useEffect(() => {
        void (async () => {
            await Promise.all([hydrateKvDb(), hydrateSettingsDb(), hydrateChatStorage()]);
            if (!kvGet("online-text-fixture-seeded")) {
                const now = new Date().toISOString();
                saveCharacters(["alice", "bob"].map(id => ({ id, name: id, avatar: null, persona: "Test character", wechatID: id, createdAt: now, updatedAt: now })));
                await kvSetAsync("ai_phone_api_configs_v1", JSON.stringify(["base", "next", "other"].map(id => ({
                    id, name: { base: "原配置", next: "收藏配置", other: "工作配置" }[id], provider: "OpenAI", apiKey: "saved-test-key",
                    baseUrl: "https://example.test/v1", defaultModel: id + "-hidden-model", enableNativeTools: false,
                    enableImageRecognition: false, enableImageGeneration: false,
                }))));
                const preset = { ...createPreset("固定预设"), id: "fixture-preset", prompt_order: [
                    { identifier: "main", enabled: true }, { identifier: "worldInfoBefore", enabled: true }, { identifier: "chatHistory", enabled: true },
                ], prompts: [
                    { identifier: "main", name: "main", role: "system", content: "Reply to {{char}}.", injection_depth: 0, enabled: true },
                    { identifier: "worldInfoBefore", name: "worldInfoBefore", role: "system", content: "", injection_depth: 0, enabled: true, marker: true },
                    { identifier: "chatHistory", name: "chatHistory", role: "system", content: "", injection_depth: 0, enabled: true, marker: true },
                ] };
                await savePresetsAsync([preset]);
                saveWorldBooks([{ ...createWorldBook("固定世界书"), id: "fixture-world", entries: [{ uid: "entry", key: "", comment: "", content: "worldbook-context", use_regex: false, disable: false, constant: true, position: "before_char", insertion_order: 1 }] }]);
                await kvSetAsync("ai_phone_bindings_v1", JSON.stringify({ globalDefaults: { apiConfigId: "base", presetId: "fixture-preset", worldBookIds: ["fixture-world"], voiceConfigId: "fixture-voice" },
                    selectionRequired: true,
                    characterBindings: [{ characterId: "alice", defaults: {}, appOverrides: { chat: { apiConfigId: "base" } }, onlineText: { apiConfigId: "other", selectionRequired: true } }] }));
                await kvSetAsync("ai_phone_config_folders_api_v1", JSON.stringify({ version: 1, folders: [{ id: "favorites", name: "收藏文件夹" }, { id: "work", name: "工作文件夹" }], order: ["__unclassified__", "favorites", "work"], assignments: { next: "favorites", other: "work" } }));
                const alice = createOrGetSession("alice"), bob = createOrGetSession("bob");
                createGroupSession("测试群", ["alice", "bob"]);
                saveChatSessions(loadChatSessions().map(item => ({ ...item, autoReplied: true })));
                for (const item of [alice, bob]) {
                    pushChatMessage({ sessionId: item.id, role: "user", content: "original-user-context" });
                    pushChatMessage({ sessionId: item.id, role: "assistant", content: "original-assistant-context" });
                }
                await kvSetAsync("online-text-fixture-seeded", "1");
            }
            saveChatAppSettings({ ...loadChatAppSettings(), quickActionEnabled: true, floatingDockEnabled: false });
            const loaded = loadChatSessions();
            setSessions(loaded);
            setSession(loaded.find(item => item.contactId === "alice")!);
        })();
    }, []);
    return <div className="chat-app" data-room-active style={{ height: "100dvh", position: "relative" }}>
        <nav style={{ position: "fixed", zIndex: 10000, top: 0, left: 0, background: "white", fontSize: 12 }}>
            {sessions.map(item => <button key={item.id} onClick={() => setSession(item)}>{item.isGroup ? "测试群" : item.contactId}</button>)}
            <button onClick={() => {
                if (stop) { stop(); setStop(null); return; }
                if (!session) return;
                const run = beginOnlineTextGeneration(session.contactId, "next");
                setStop(() => run.finish);
            }}>{stop ? "结束后台生成" : "模拟后台生成"}</button>
            <button onClick={async () => { await saveApiConfigs(JSON.parse(kvGet("ai_phone_api_configs_v1") || "[]").filter((item: { id: string }) => item.id !== "next")); await removeApiConfigReferences("next"); }}>删除收藏配置</button>
            <button onClick={() => { const apis = JSON.parse(kvGet("ai_phone_api_configs_v1") || "[]"); saveApiConfigs([...apis, ...Array.from({ length: 40 }, (_, index) => ({ ...apis[0], id: `extra-${index}`, name: `列表配置 ${index}` }))]); }}>增加列表配置</button>
            <button onClick={() => saveApiConfigs(JSON.parse(kvGet("ai_phone_api_configs_v1") || "[]").filter((item: { id: string }) => !item.id.startsWith("extra-")))}>恢复配置列表</button>
            <button onClick={() => setSnapshot(JSON.stringify({ bindings: loadBindingConfig(), messages: session ? loadChatMessages(session.id) : [], apis: JSON.parse(kvGet("ai_phone_api_configs_v1") || "[]") }))}>读取状态</button>
            <button onClick={() => { if (!session) return; setOfflineResult(""); void generateOfflineChatCompletion({ ...session, offlineSummaryRetry: false }, loadChatMessages(session.id))
                .then(result => setOfflineResult(result.model)).catch(error => setOfflineResult(error.message)); }}>请求线下生成</button>
            <button onClick={() => { if (!session) return; void Promise.all(["text", "offline", "voice", "video"].map(async tag => {
                const result = await buildChatPromptMessages(session, loadChatMessages(session.id), { appTags: ["chat", tag] });
                return { tag, api: result.config.id, preset: result.preset?.id, messages: result.llmMessages };
            })).then(result => setScopes(JSON.stringify(result))); }}>检查范围</button>
        </nav>
        <pre data-testid="snapshot" style={{ display: "none" }}>{snapshot}</pre>
        <pre data-testid="scopes" style={{ display: "none" }}>{scopes}</pre>
        <pre data-testid="offline-result" style={{ display: "none" }}>{offlineResult}</pre>
        {session && <ChatRoom key={session.id} session={session} onBack={() => {}} onDeleted={() => {}} />}
        <QuickActionFloat />
    </div>;
}
