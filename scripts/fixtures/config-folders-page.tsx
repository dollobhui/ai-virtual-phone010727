"use client";
// Copied into a temporary route by test-config-folders-ui.cjs; never shipped as a page.
import { useEffect, useState, useCallback, type ReactNode } from "react";
import { SettingsContext } from "@/components/phone-settings-app";
import { ApiSettings } from "@/components/settings/api-settings";
import { VoiceSettings } from "@/components/settings/voice-settings";
import { WorldBookManager } from "@/components/settings/worldbook-manager";
import { PresetManager } from "@/components/settings/preset-manager";
import { hydrateKvDb } from "@/lib/kv-db";
import { hydrateSettingsDb } from "@/lib/settings-db";
import { loadApiConfigs, saveApiConfigs, loadVoiceConfigs, saveVoiceConfigs, loadWorldBooks, saveWorldBooks, createWorldBook } from "@/lib/settings-storage";

export default function Fixture() {
    const [loaded, setLoaded] = useState(false);
    const [tab, setTab] = useState("api");
    const [title, setTitle] = useState<string | null>(null);
    const [back, setBack] = useState<(() => void) | null>(null);
    const [actions, setActions] = useState<Record<string, ReactNode>>({});
    const setRight = useCallback((page: string, action: ReactNode | null) => setActions(previous => ({ ...previous, [page]: action })), []);
    useEffect(() => {
        (async () => {
            await hydrateKvDb(); await hydrateSettingsDb();
            if (!loadApiConfigs().length) await saveApiConfigs([{ id: "fixture-api", name: "Alpha API", provider: "OpenAI", defaultModel: "test-model", apiKey: "fixture-secret", baseUrl: "https://example.test/v1", enableNativeTools: true, enableImageRecognition: false, enableImageGeneration: false }]);
            if (!loadVoiceConfigs().length) saveVoiceConfigs([{ id: "fixture-voice", name: "Alpha Voice", provider: "OpenAI", model: "tts-1", apiKey: "fixture-secret", defaultVoice: "alloy", enableTTS: true, enableSTT: true }]);
            if (!loadWorldBooks().length) saveWorldBooks([{ ...createWorldBook("Alpha Worldbook"), id: "fixture-book", description: "basic description", entries: [{ uid: "fixture-entry", key: "trigger", comment: "inside-only", content: "secret-body-not-searchable", use_regex: false, disable: false, constant: false, position: 4, insertion_order: 50 }] }]);
            setLoaded(true);
        })();
    }, []);
    return <SettingsContext.Provider value={{setSubpageTitle: setTitle, setOverrideBack: setBack, setSubpageRightAction: setRight}}>
        <div className="page-body" style={{ maxWidth: 440, height: "100dvh", overflowY: "auto", background: "#f0f1f5", padding: 16, margin: "auto" }}>
            <nav className="flex gap-2 mb-4">{["api","voice","worldbook","presets"].map(page => <button key={page} onClick={() => { setTab(page); setBack(null); }} data-tab={page}>{page}</button>)}</nav>
            <header className="flex justify-between gap-2 mb-4"><button aria-label="页面返回" onClick={() => back?.()}>返回</button><span>{title}</span>{actions[tab]}</header>
            {loaded && (tab === "api" ? <ApiSettings /> : tab === "voice" ? <VoiceSettings /> : tab === "worldbook" ? <WorldBookManager /> : <PresetManager />)}
        </div>
    </SettingsContext.Provider>;
}
