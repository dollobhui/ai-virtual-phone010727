"use client";
// Temporary test route only. Uses production resources and chat components.
import { useEffect, useState } from "react";
import { PhoneResourcesApp } from "@/components/phone-resources-app";
import { PhoneChatApp } from "@/components/chat/phone-chat-app";
import { MusicProvider } from "@/lib/music-context";
import { hydrateKvDb } from "@/lib/kv-db";
import { hydrateSettingsDb } from "@/lib/settings-db";
import { hydrateChatStorage, addChatContact, createOrGetSession, pushChatMessage, loadChatSessions, saveChatSessions } from "@/lib/chat-storage";
import { loadCharacters, saveCharacters } from "@/lib/character-storage";
import { loadApiConfigs, saveApiConfigs, saveBindingConfig } from "@/lib/settings-storage";

export default function AvatarFixture() {
    const [ready, setReady] = useState(false);
    const [app, setApp] = useState("resources");
    const [sessionId, setSessionId] = useState<string | null>(null);
    useEffect(() => {
        const navigate = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            setSessionId(detail.sessionId || null); setApp(detail.appId);
        };
        window.addEventListener("open-app", navigate);
        void (async () => {
            await hydrateKvDb(); await hydrateSettingsDb(); await hydrateChatStorage();
            if (!loadCharacters().length) {
                saveCharacters(["alice", "bob"].map(id => ({ id, name: id === "alice" ? "小爱" : "小白", avatar: "https://avatars.test/old.png", wechatID: id, persona: "友好地聊天，由自己决定是否换头像", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })));
                addChatContact("alice"); addChatContact("bob");
                const session = createOrGetSession("alice");
                pushChatMessage({ sessionId: session.id, role: "assistant", content: "历史消息，用于验证头像同步" });
            }
            if (!loadApiConfigs().length) {
                await saveApiConfigs([{ id: "avatar-fixture-api", name: "Mock API", provider: "OpenAI", defaultModel: "avatar-fixture", apiKey: "fixture-only", baseUrl: "https://llm.avatar.test/v1", enableNativeTools: false, enableImageRecognition: false, enableImageGeneration: false }]);
                await saveBindingConfig({ globalDefaults: { apiConfigId: "avatar-fixture-api" }, characterBindings: [] });
            }
            setReady(true);
        })();
        return () => window.removeEventListener("open-app", navigate);
    }, []);
    return <MusicProvider><div className="phone-shell" style={{ maxWidth: 440, height: "100dvh", margin: "auto", background: "var(--c-page-body-bg)" }}>
        <nav><button onClick={() => setApp("resources")}>测试：资源库</button><button onClick={() => { setSessionId(null); setApp("chat"); }}>测试：聊天列表</button>
            <button onClick={() => {
                if (!sessionId) return;
                pushChatMessage({ sessionId, role: "user", content: "", mediaType: "image", mediaUrl: "https://avatars.test/ordinary.png", mediaData: { label: "普通图片" } });
                window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId } }));
            }}>测试：普通图片</button>
            <button onClick={() => { saveChatSessions(loadChatSessions().map(x => ({ ...x, streamOnline: true }))); setApp("resources"); }}>测试：下次流式回复</button>
        </nav>
        <section className="phone-app-pane" style={{ height: "calc(100dvh - 28px)" }}>
            {ready && (app === "resources" ? <PhoneResourcesApp onClose={() => {}} initialPage="avatars" /> : <PhoneChatApp onClose={() => setApp("resources")} initialSessionId={sessionId} />)}
        </section>
    </div></MusicProvider>;
}
