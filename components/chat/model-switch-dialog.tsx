"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";
import { loadApiConfigs, loadBindingConfig, resolveOnlineTextBinding, saveOnlineTextApiConfig } from "@/lib/settings-storage";
import { ONLINE_TEXT_STATE_UPDATED, isOnlineTextBusy, ONLINE_TEXT_API_MISSING_MESSAGE } from "@/lib/online-text-generation";

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
    const selectedId = resolveOnlineTextBinding(loadBindingConfig(), characterId).apiConfigId;
    const missing = Boolean(selectedId && !configs.some(config => config.id === selectedId));
    const blocked = generating || saving || isOnlineTextBusy(characterId);

    const select = async (apiConfigId: string) => {
        if (submitRef.current || blocked || !canSwitch()) return;
        submitRef.current = true;
        setSaving(true);
        setError("");
        try {
            await saveOnlineTextApiConfig(characterId, apiConfigId);
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
        <div className="modal-overlay" data-ui="modal" onClick={() => { if (!saving) onClose(); }}
            onKeyDown={event => {
                if (event.key === "Escape" && !saving) { event.stopPropagation(); onClose(); }
                if (event.key === "Tab") {
                    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
                    const first = buttons[0], last = buttons[buttons.length - 1];
                    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
                }
            }}>
            <div className="modal-dialog chat-model-switch-dialog" role="dialog" aria-modal="true"
                aria-labelledby="chat-model-switch-title" onClick={event => event.stopPropagation()}>
                <div className="modal-header">
                    <h3 className="modal-title" id="chat-model-switch-title">切换模型</h3>
                    <button ref={closeRef} className="ui-bare-btn" aria-label="关闭切换模型" disabled={saving} onClick={onClose}><X size={20} /></button>
                </div>
                <div className="modal-body">
                    <p className="chat-model-switch-hint">仅用于当前角色的线上文字聊天</p>
                    {missing && <p role="alert" className="chat-model-switch-error">{ONLINE_TEXT_API_MISSING_MESSAGE}</p>}
                    {error && <p role="alert" className="chat-model-switch-error">{error}</p>}
                    {blocked && <p role="status" className="chat-model-switch-hint">{saving ? "正在保存配置…" : "正在生成回复，请稍后切换"}</p>}
                    {!configs.length && <p className="chat-model-switch-hint">暂无已保存的 API 配置，请先在设置中添加。</p>}
                    <div className="chat-model-switch-list">
                        {configs.map((config, index) => <button key={config.id} type="button"
                            className="chat-model-switch-option" disabled={blocked}
                            aria-pressed={selectedId === config.id} onClick={() => void select(config.id)}>
                            <span>{config.name?.trim() || `API 配置 ${index + 1}`}</span>
                            {selectedId === config.id && <Check size={18} aria-hidden="true" />}
                        </button>)}
                    </div>
                </div>
            </div>
        </div>, document.body,
    );
}
