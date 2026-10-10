"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";
import { loadApiConfigs, loadBindingConfig, getCharacterChatApiSelection, saveCharacterApiConfig } from "@/lib/settings-storage";
import { ONLINE_TEXT_STATE_UPDATED, isOnlineTextBusy, ONLINE_TEXT_API_MISSING_MESSAGE } from "@/lib/online-text-generation";
import { ContentDialog } from "@/components/ui/modal";

export function ModelSwitchDialog({ characterId, generating, canSwitch, onClose }: {
    characterId: string;
    generating: boolean;
    canSwitch: () => boolean;
    onClose: () => void;
}) {
    const [, setRevision] = useState(0);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const submitRef = useRef(false);
    const closeRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const previousFocus = document.activeElement as HTMLElement | null;
        closeRef.current?.focus();
        return () => previousFocus?.focus();
    }, []);
    useEffect(() => {
        const refresh = () => setRevision(value => value + 1);
        window.addEventListener("settings-api-configs-updated", refresh);
        window.addEventListener("settings-bindings-updated", refresh);
        window.addEventListener(ONLINE_TEXT_STATE_UPDATED, refresh);
        window.addEventListener("focus", refresh);
        return () => {
            window.removeEventListener("settings-api-configs-updated", refresh);
            window.removeEventListener("settings-bindings-updated", refresh);
            window.removeEventListener(ONLINE_TEXT_STATE_UPDATED, refresh);
            window.removeEventListener("focus", refresh);
        };
    }, []);
    // Read the full array; folder metadata never participates in this picker.
    const configs = loadApiConfigs();
    const selection = getCharacterChatApiSelection(loadBindingConfig(), characterId);
    const selectedId = selection.apiConfigId;
    const missing = Boolean(selectedId && !configs.some(config => config.id === selectedId));
    const blocked = generating || saving || isOnlineTextBusy(characterId);

    const select = async (apiConfigId?: string) => {
        if (submitRef.current || blocked || !canSwitch()) return;
        submitRef.current = true;
        setSaving(true);
        setError("");
        try {
            await saveCharacterApiConfig(characterId, apiConfigId);
            onClose();
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : "配置保存失败，请重试");
        } finally {
            submitRef.current = false;
            setSaving(false);
        }
    };

    if (typeof document === "undefined") return null;
    return createPortal(
        <ContentDialog title="切换模型" dialogLabel="切换模型" confirmLabel="" cancelLabel=""
            onConfirm={() => {}} onCancel={() => { if (!saving) onClose(); }}
            overlayClassName="chat-model-switch-overlay" dialogClassName="chat-model-switch-dialog" dialogRef={dialogRef}
            headerAction={<button ref={closeRef} className="ui-bare-btn chat-model-switch-close" aria-label="关闭切换模型" disabled={saving} onClick={onClose}><X size={20} /></button>}
            onKeyDown={event => {
                if (event.key === "Escape" && !saving) { event.stopPropagation(); onClose(); }
                if (event.key === "Tab") {
                    const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
                    const first = buttons[0], last = buttons[buttons.length - 1];
                    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
                }
            }}>
                    <p className="chat-model-switch-hint">与快捷操作共用当前角色的 API 绑定</p>
                    {missing && <p role="alert" className="chat-model-switch-error">{ONLINE_TEXT_API_MISSING_MESSAGE}</p>}
                    {error && <p role="alert" className="chat-model-switch-error">{error}</p>}
                    {blocked && <p role="status" className="chat-model-switch-hint">{saving ? "正在保存配置…" : "正在生成回复，请稍后切换"}</p>}
                    {!configs.length && <p className="chat-model-switch-hint">暂无已保存的 API 配置，请先在设置中添加。</p>}
                    <div className="chat-model-switch-list">
                        <button type="button" className="chat-model-switch-option" disabled={blocked}
                            data-inherited={selection.inherits} onClick={() => void select()}>
                            <span>继承默认 API</span>{selection.inherits && <Check size={18} aria-hidden="true" />}
                        </button>
                        {configs.map((config, index) => <button key={config.id} type="button"
                            className="chat-model-switch-option" disabled={blocked}
                            aria-pressed={selectedId === config.id} onClick={() => void select(config.id)}>
                            <span>{config.name?.trim() || `API 配置 ${index + 1}`}</span>
                            {selectedId === config.id && <Check size={18} aria-hidden="true" />}
                        </button>)}
                    </div>
        </ContentDialog>, document.body,
    );
}
