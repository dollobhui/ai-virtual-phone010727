import { hydrateKvDb, isKvHydrated, kvGet, kvUpdateCommitted } from "./kv-db";
import {
    CONFIG_FOLDER_CATEGORIES, CONFIG_FOLDER_KEYS, applyConfigFolderOperation, parseConfigFolders,
    emptyConfigFolders, type ConfigFolderCategory, type ConfigFolderMetadata, type ConfigFolderOperation,
} from "./config-folder-types";

export const CONFIG_FOLDERS_UPDATED_EVENT = "config-folders-updated";
const queues = new Map<ConfigFolderCategory, Promise<unknown>>();

function enqueue<T>(category: ConfigFolderCategory, operation: () => Promise<T>): Promise<T> {
    const task = (queues.get(category) ?? Promise.resolve()).then(operation);
    queues.set(category, task.catch(() => undefined));
    return task;
}

function notify(category: ConfigFolderCategory) {
    window.dispatchEvent(new CustomEvent(CONFIG_FOLDERS_UPDATED_EVENT, { detail: category }));
}

export async function loadConfigFolders(category: ConfigFolderCategory): Promise<ConfigFolderMetadata> {
    await hydrateKvDb();
    if (!isKvHydrated()) throw new Error("文件夹存储读取失败，已保留原数据，请重试");
    return parseConfigFolders(kvGet(CONFIG_FOLDER_KEYS[category]));
}

export function updateConfigFolders(category: ConfigFolderCategory, operation: ConfigFolderOperation): Promise<ConfigFolderMetadata> {
    return enqueue(category, async () => {
        await loadConfigFolders(category);
        const raw = await kvUpdateCommitted(CONFIG_FOLDER_KEYS[category], value =>
            JSON.stringify(applyConfigFolderOperation(parseConfigFolders(value), operation)));
        notify(category);
        return parseConfigFolders(raw);
    });
}

export function configFolderCategoryForKey(key: string): ConfigFolderCategory | undefined {
    return CONFIG_FOLDER_CATEGORIES.find(category => CONFIG_FOLDER_KEYS[category] === key);
}

/** No implicit merging of two independent folder ID/order spaces. */
export function restoreConfigFolders(category: ConfigFolderCategory, raw: string | null, overwrite: boolean): Promise<void> {
    return enqueue(category, async () => {
        const incoming = parseConfigFolders(raw);
        if (!overwrite) throw new Error("非覆盖恢复不合并文件夹分类；现有分类已保留，请使用覆盖恢复还原分类");
        await hydrateKvDb();
        await kvUpdateCommitted(CONFIG_FOLDER_KEYS[category], () => JSON.stringify(incoming));
        notify(category);
    });
}

/** Called only after a successful overwrite of the settings module. Old backups
 * lack these keys: reset metadata, including old ID collisions, to unclassified. */
export async function finishConfigFolderRestore(seenKeys: Set<string>): Promise<string[]> {
    const errors: string[] = [];
    for (const category of CONFIG_FOLDER_CATEGORIES) {
        if (seenKeys.has(CONFIG_FOLDER_KEYS[category])) continue;
        try { await restoreConfigFolders(category, JSON.stringify(emptyConfigFolders()), true); }
        catch { errors.push(`旧备份的 ${category} 分类重置失败，原分类已保留`); }
    }
    return errors;
}
