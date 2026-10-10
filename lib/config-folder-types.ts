/** Organization only: never store configuration values or change their order here. */
export const CONFIG_FOLDER_CATEGORIES = ["api", "voice", "preset", "worldbook"] as const;
export type ConfigFolderCategory = typeof CONFIG_FOLDER_CATEGORIES[number];
export const UNCLASSIFIED_FOLDER_ID = "__unclassified__";
export const UNCLASSIFIED_FOLDER_NAME = "未分类";
export const CONFIG_FOLDER_KEYS: Record<ConfigFolderCategory, string> = {
    api: "ai_phone_config_folders_api_v1",
    voice: "ai_phone_config_folders_voice_v1",
    preset: "ai_phone_config_folders_preset_v1",
    worldbook: "ai_phone_config_folders_worldbook_v1",
};
export type ConfigFolder = { id: string; name: string };
export type ConfigFolderMetadata = {
    version: 1;
    folders: ConfigFolder[];
    order: string[];
    assignments: Record<string, string>;
};

export function emptyConfigFolders(): ConfigFolderMetadata {
    return { version: 1, folders: [], order: [UNCLASSIFIED_FOLDER_ID], assignments: {} };
}

export function validateFolderName(value: string): string {
    const name = value.trim();
    if (!name) throw new Error("文件夹名称不能为空");
    if (Array.from(name).length > 30) throw new Error("文件夹名称最长 30 个字符");
    if (name === UNCLASSIFIED_FOLDER_NAME) throw new Error("「未分类」是保留名称");
    return name;
}

export function parseConfigFolders(raw: string | null): ConfigFolderMetadata {
    if (raw === null) return emptyConfigFolders();
    try {
        const data: unknown = JSON.parse(raw);
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
        const value = data as ConfigFolderMetadata;
        if (value.version !== 1 || !Array.isArray(value.folders) || !Array.isArray(value.order)
            || !value.assignments || typeof value.assignments !== "object" || Array.isArray(value.assignments)) throw new Error();
        const ids = new Set([UNCLASSIFIED_FOLDER_ID]);
        const folders = value.folders.map(folder => {
            if (!folder || typeof folder.id !== "string" || !folder.id || ids.has(folder.id)
                || typeof folder.name !== "string" || validateFolderName(folder.name) !== folder.name) throw new Error();
            ids.add(folder.id);
            return { id: folder.id, name: folder.name };
        });
        if (value.order.length !== ids.size || new Set(value.order).size !== ids.size
            || value.order.some(id => !ids.has(id))) throw new Error();
        const assignments: Record<string, string> = Object.create(null);
        for (const [id, folderId] of Object.entries(value.assignments)) {
            if (!id || typeof folderId !== "string" || !folderId) throw new Error();
            assignments[id] = folderId;
        }
        return { version: 1, folders, order: [...value.order], assignments };
    } catch {
        throw new Error("文件夹数据损坏，已保留原数据；分类操作已暂停。请从有效备份恢复。");
    }
}

export function configFolderFor(metadata: ConfigFolderMetadata, configId: string): string {
    const id = Object.hasOwn(metadata.assignments, configId) ? metadata.assignments[configId] : undefined;
    return metadata.folders.some(folder => folder.id === id) ? id! : UNCLASSIFIED_FOLDER_ID;
}

export type ConfigFolderOperation =
    | { type: "create"; id: string; name: string }
    | { type: "rename"; id: string; name: string }
    | { type: "delete"; id: string }
    | { type: "reorder"; order: string[] }
    | { type: "move"; configIds: string[]; folderId: string; fallbackToUnclassified?: boolean }
    | { type: "remove-config"; configId: string };

export function applyConfigFolderOperation(current: ConfigFolderMetadata, operation: ConfigFolderOperation): ConfigFolderMetadata {
    const next: ConfigFolderMetadata = {
        version: 1, folders: current.folders.map(folder => ({ ...folder })),
        order: [...current.order], assignments: Object.assign(Object.create(null), current.assignments),
    };
    switch (operation.type) {
        case "create":
            if (!operation.id || next.order.includes(operation.id)) throw new Error("文件夹 ID 已存在");
            next.folders.push({ id: operation.id, name: validateFolderName(operation.name) });
            next.order.push(operation.id);
            break;
        case "rename": {
            const folder = next.folders.find(item => item.id === operation.id);
            if (!folder) throw new Error("文件夹已不存在");
            folder.name = validateFolderName(operation.name);
            break;
        }
        case "delete":
            if (!next.folders.some(folder => folder.id === operation.id)) throw new Error("文件夹已不存在");
            next.folders = next.folders.filter(folder => folder.id !== operation.id);
            next.order = next.order.filter(id => id !== operation.id);
            for (const [id, folderId] of Object.entries(next.assignments)) {
                if (folderId === operation.id) delete next.assignments[id];
            }
            break;
        case "reorder":
            if (operation.order.length !== next.order.length || new Set(operation.order).size !== next.order.length
                || operation.order.some(id => !next.order.includes(id))) throw new Error("文件夹已发生变化，请重新排序");
            next.order = [...operation.order];
            break;
        case "move": {
            let target = operation.folderId;
            if (target !== UNCLASSIFIED_FOLDER_ID && !next.folders.some(folder => folder.id === target)) {
                if (!operation.fallbackToUnclassified) throw new Error("目标文件夹已不存在，请重新选择");
                target = UNCLASSIFIED_FOLDER_ID;
            }
            for (const id of operation.configIds) {
                if (!id) throw new Error("配置 ID 不能为空");
                if (target === UNCLASSIFIED_FOLDER_ID) delete next.assignments[id];
                else next.assignments[id] = target;
            }
            break;
        }
        case "remove-config": delete next.assignments[operation.configId]; break;
    }
    return next;
}

/** Row-major grid positions, shared by pointer and keyboard sorting. */
export function moveFolderInOrder(order: string[], from: number, to: number): string[] {
    const next = [...order];
    if (from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
    next.splice(to, 0, next.splice(from, 1)[0]);
    return next;
}
