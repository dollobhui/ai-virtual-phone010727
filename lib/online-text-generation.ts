// Ordinary one-to-one text replies share this guard, including background replies.
// No configuration values or chat messages are stored here.
export const ONLINE_TEXT_STATE_UPDATED = "online-text-state-updated";
export const ONLINE_TEXT_API_MISSING_MESSAGE = "当前 API 配置已删除，请重新选择后继续";

export class OnlineTextApiUnavailableError extends Error {
    constructor() {
        super(ONLINE_TEXT_API_MISSING_MESSAGE);
        this.name = "OnlineTextApiUnavailableError";
    }
}

export class OnlineTextBusyError extends Error {
    constructor() {
        super("正在生成回复或保存配置，请稍后再试");
        this.name = "OnlineTextBusyError";
    }
}

type Run = { apiConfigId?: string; controller: AbortController };
const runs = new Map<string, Set<Run>>();
const switches = new Set<string>();

function notify(characterId: string): void {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(ONLINE_TEXT_STATE_UPDATED, { detail: { characterId } }));
    }
}

export function isOrdinaryOnlineTextRequest(isGroup: boolean | undefined, options?: { appId?: string; appTags?: string[] }): boolean {
    const tags = options?.appTags ?? [];
    return !isGroup && (options?.appId ?? "chat") === "chat"
        && tags.includes("chat") && tags.includes("text")
        && !tags.some(tag => ["offline", "voice", "video", "group_chat"].includes(tag));
}

export function isOnlineTextBusy(characterId: string): boolean {
    return switches.has(characterId) || Boolean(runs.get(characterId)?.size);
}

export async function withOnlineTextSwitch<T>(characterId: string, save: () => Promise<T>): Promise<T> {
    if (isOnlineTextBusy(characterId)) throw new OnlineTextBusyError();
    switches.add(characterId);
    notify(characterId);
    try {
        return await save();
    } finally {
        switches.delete(characterId);
        notify(characterId);
    }
}

export function beginOnlineTextGeneration(characterId: string, apiConfigId?: string, externalSignal?: AbortSignal) {
    if (switches.has(characterId)) throw new OnlineTextBusyError();
    const controller = new AbortController();
    const abort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener("abort", abort, { once: true });
    const run = { apiConfigId, controller };
    const active = runs.get(characterId) ?? new Set<Run>();
    active.add(run);
    runs.set(characterId, active);
    notify(characterId);
    return {
        signal: controller.signal,
        finish: () => {
            externalSignal?.removeEventListener("abort", abort);
            active.delete(run);
            if (!active.size) runs.delete(characterId);
            notify(characterId);
        },
    };
}

export function cancelOnlineTextGenerationsForMissingApis(validIds: Set<string>): void {
    for (const active of runs.values()) {
        for (const run of active) {
            if (run.apiConfigId && !validIds.has(run.apiConfigId)) {
                run.controller.abort(new OnlineTextApiUnavailableError());
            }
        }
    }
}
