"use client";

import { useState } from "react";
import { BellRing } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { Toggle } from "@/components/ui/form";
import { getActiveChatSessionId, loadChatAppSettings, loadChatSessions, saveChatAppSettings, type ChatSoundConfig, type ChatSoundKind, type ChatSoundsConfig } from "@/lib/chat-storage";
import { dispatchChatMessageNotice } from "@/lib/chat-notification-events";
import { previewChatSound } from "@/lib/chat-sound";
import { ChatSoundSourceEditor, SOUND_ITEMS } from "./chat-sound-editor";

function ChatSoundsSection() {
    const [sounds, setSounds] = useState<ChatSoundsConfig>(() => loadChatAppSettings().globalChatSounds || {});

    const changeSound = (kind: ChatSoundKind, patch: Partial<ChatSoundConfig>) => {
        const settings = loadChatAppSettings();
        const current = settings.globalChatSounds || {};
        const next = { ...current, [kind]: { ...current[kind], ...patch } };
        saveChatAppSettings({ ...settings, globalChatSounds: next });
        setSounds(next);
    };

    // 新消息音效“测试弹窗”：模拟一条真实新消息——播提示音 + 弹桌面通知横幅。
    // 横幅挑最近活跃的会话来演（优先避开正打开的那个），点击横幅会跳进那个聊天。
    const testNewMessageNotice = () => {
        void previewChatSound("newMessage");
        const sessions = loadChatSessions()
            .slice()
            .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
        const activeId = getActiveChatSessionId();
        const target = sessions.find(s => s.id !== activeId) || sessions[0];
        if (!target) { alert("还没有聊天会话，先和角色聊一句再测试弹窗"); return; }
        dispatchChatMessageNotice({
            sessionId: target.id,
            body: "【提示音测试】模拟收到一条新消息",
            isTest: true,
        });
    };

    return (
        <div className="menu-group">
            {SOUND_ITEMS.map(({ kind, icon: Icon, label, desc }) => {
                const config: ChatSoundConfig = sounds[kind] || {};
                const enabled = config.enabled === true;
                return (
                    <div key={kind} className="chat-sound-block">
                        <div className="menu-item">
                            <Icon size={20} className="text-[var(--c-icon)]" />
                            <div className="menu-label-group"><span className="menu-label">{label}</span><span className="menu-desc">{desc}</span></div>
                            <div className="menu-right">
                                <Toggle checked={enabled} onChange={checked => changeSound(kind, { enabled: checked })} />
                            </div>
                        </div>
                        {enabled ? (
                            <div className="chat-sound-editor">
                                <ChatSoundSourceEditor
                                    config={config}
                                    onPatch={patch => changeSound(kind, patch)}
                                    onPreview={() => void previewChatSound(kind)}
                                />
                                {kind === "newMessage" ? (
                                    <>
                                        <div className="chat-sound-subtoggles">
                                            <div className="chat-sound-subtoggle">
                                                <div className="menu-label-group"><span className="menu-label">实时聊天不通知</span><span className="menu-desc">正打开该聊天时，角色新消息不播放音效</span></div>
                                                <Toggle checked={config.muteActiveChat === true} onChange={checked => changeSound(kind, { muteActiveChat: checked })} />
                                            </div>
                                            <div className="chat-sound-subtoggle">
                                                <div className="menu-label-group"><span className="menu-label">多条消息只通知1次</span><span className="menu-desc">同一角色连续多条消息只在第一条时播放</span></div>
                                                <Toggle checked={config.notifyOncePerBurst === true} onChange={checked => changeSound(kind, { notifyOncePerBurst: checked })} />
                                            </div>
                                        </div>
                                        {config.value ? (
                                            <div className="chat-sound-editor-row chat-sound-test-row">
                                                <button className="ui-btn ui-btn-outline chat-sound-file-btn" onClick={testNewMessageNotice}>
                                                    <BellRing size={14} /> 测试弹窗
                                                </button>
                                                <span className="chat-sound-source">模拟一条新消息：弹通知横幅并播放音效</span>
                                            </div>
                                        ) : null}
                                    </>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

export function GlobalChatSoundsSettings({ onBack }: { onBack: () => void }) {
    return (
        <PageShell title="全局提示音" onBack={onBack}>
            <div className="p-4 pb-8"><ChatSoundsSection /></div>
        </PageShell>
    );
}
