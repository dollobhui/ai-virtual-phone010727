export const AVATAR_LIBRARY_KEY = "ai_phone_avatar_library_v1";
export const AVATAR_CATEGORIES = ["single", "couple"] as const;
export type AvatarCategory = typeof AVATAR_CATEGORIES[number];
export const AVATAR_CATEGORY_LABELS: Record<AvatarCategory, string> = { single: "单独头像", couple: "情侣头像" };
export type AvatarFolder = { id: string; name: string; category: AvatarCategory };
export type LibraryAvatar = { id: string; url: string; description: string; category: AvatarCategory; folderId: string | null; deletedAt?: string };
export type AvatarLibrary = { schema: "ai_phone_avatar_library"; version: 1; categories: AvatarCategory[]; folders: AvatarFolder[]; images: LibraryAvatar[] };

export const emptyAvatarLibrary = (): AvatarLibrary => ({ schema: "ai_phone_avatar_library", version: 1, categories: [...AVATAR_CATEGORIES], folders: [], images: [] });
export const avatarId = () => `avatar_${globalThis.crypto.randomUUID()}`;
const isCategory = (x: unknown): x is AvatarCategory => AVATAR_CATEGORIES.includes(x as AvatarCategory);
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const validId = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0 && x.length <= 200;

export function normalizeAvatarUrl(value: string): string {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("头像仅支持 HTTP/HTTPS 图片 URL");
    return url.href;
}

export function avatarFolderName(value: string): string {
    const name = value.trim();
    if (!name || [...name].length > 40 || name === "未分类") throw new Error("文件夹名称须为 1–40 个字，且不能为“未分类”");
    return name;
}

/** Validate the entire backup before any mutation; pick fields to discard unknown payloads. */
export function parseAvatarLibrary(value: unknown): AvatarLibrary {
    if (typeof value === "string") value = JSON.parse(value);
    if (!isRecord(value) || value.schema !== "ai_phone_avatar_library" || value.version !== 1
        || !Array.isArray(value.categories) || value.categories.length !== 2 || new Set(value.categories).size !== 2 || !value.categories.every(isCategory)
        || !Array.isArray(value.folders) || !Array.isArray(value.images)) throw new Error("头像库 JSON 格式或版本不正确");
    const folderIds = new Set<string>();
    const folders: AvatarFolder[] = value.folders.map(x => {
        if (!isRecord(x) || !validId(x.id) || folderIds.has(x.id) || typeof x.name !== "string" || !isCategory(x.category)) throw new Error("文件夹格式或 ID 不正确");
        folderIds.add(x.id);
        return { id: x.id, name: avatarFolderName(x.name), category: x.category };
    });
    const byId = new Map(folders.map(x => [x.id, x]));
    const ids = new Set<string>();
    const images: LibraryAvatar[] = value.images.map(x => {
        if (!isRecord(x) || !validId(x.id) || ids.has(x.id) || typeof x.url !== "string" || typeof x.description !== "string" || !isCategory(x.category)
            || !(x.folderId === null || typeof x.folderId === "string")
            || (x.deletedAt !== undefined && (typeof x.deletedAt !== "string" || !Number.isFinite(Date.parse(x.deletedAt))))) throw new Error("图片格式或 ID 不正确");
        if (x.folderId !== null && byId.get(x.folderId)?.category !== x.category) throw new Error("图片引用了不存在或分类不匹配的文件夹");
        ids.add(x.id);
        return { id: x.id, url: normalizeAvatarUrl(x.url), description: x.description, category: x.category, folderId: x.folderId, ...(x.deletedAt ? { deletedAt: x.deletedAt as string } : {}) };
    });
    return { ...emptyAvatarLibrary(), folders, images };
}

export function parseAvatarUrls(text: string): { entries: Array<{ url: string; description: string }>; errors: string[] } {
    const entries: Array<{ url: string; description: string }> = [];
    const errors: string[] = [];
    text.split(/\r?\n/).forEach((line, index) => {
        const input = line.trim();
        if (!input) return;
        const match = input.match(/^(?:(.*?)\s*[：:]\s*)?(https?:\/\/\S+)$/i);
        try {
            if (/^(?:data|blob|javascript|file):/i.test(input)) throw new Error("不支持的 URL");
            if (!match) throw new Error("格式错误");
            entries.push({ description: (match[1] || "").trim(), url: normalizeAvatarUrl(match[2]) });
        } catch { errors.push(`第 ${index + 1} 行不是有效的 HTTP/HTTPS URL`); }
    });
    return { entries, errors };
}

const imageKey = (x: Pick<LibraryAvatar, "category" | "url">) => `${x.category}\u0000${x.url}`;

export function mergeAvatarLibrary(existing: AvatarLibrary, incoming: AvatarLibrary): { library: AvatarLibrary; added: number; skipped: number } {
    const library = structuredClone(existing);
    const folderMap = new Map<string, string>();
    const usedFolderIds = new Set(library.folders.map(x => x.id));
    for (const folder of incoming.folders) {
        const same = library.folders.find(x => x.category === folder.category && x.name === folder.name);
        const id = same?.id || (usedFolderIds.has(folder.id) ? avatarId() : folder.id);
        folderMap.set(folder.id, id);
        if (!same) { library.folders.push({ ...folder, id }); usedFolderIds.add(id); }
    }
    const keys = new Set(library.images.map(imageKey));
    const ids = new Set(library.images.map(x => x.id));
    let added = 0;
    let skipped = 0;
    for (const image of incoming.images) {
        if (keys.has(imageKey(image))) { skipped++; continue; }
        const id = ids.has(image.id) ? avatarId() : image.id;
        library.images.push({ ...image, id, folderId: image.folderId === null ? null : folderMap.get(image.folderId)! });
        ids.add(id); keys.add(imageKey(image)); added++;
    }
    return { library, added, skipped };
}

export type AvatarLibraryOperation =
    | { type: "add"; text: string; category: AvatarCategory; folderId: string | null }
    | { type: "create-folder"; name: string; category: AvatarCategory }
    | { type: "rename-folder"; id: string; name: string }
    | { type: "delete-folder"; id: string }
    | { type: "edit"; id: string; description: string }
    | { type: "move"; id: string; category: AvatarCategory; folderId: string | null }
    | { type: "delete" | "restore"; id: string }
    | { type: "import"; data: AvatarLibrary };

export function applyAvatarLibraryOperation(state: AvatarLibrary, op: AvatarLibraryOperation): { library: AvatarLibrary; added: number; skipped: number } {
    const library = structuredClone(state);
    const result = { library, added: 0, skipped: 0 };
    if (op.type === "import") return mergeAvatarLibrary(library, parseAvatarLibrary(op.data));
    if (op.type === "add" || op.type === "move") {
        if (!isCategory(op.category) || (op.folderId !== null && !library.folders.some(x => x.id === op.folderId && x.category === op.category))) throw new Error("目标文件夹不存在或分类不匹配");
    }
    if (op.type === "add") {
        const { entries, errors } = parseAvatarUrls(op.text);
        if (errors.length) throw new Error(errors.join("；"));
        if (!entries.length) throw new Error("请输入图片 URL");
        const incoming = emptyAvatarLibrary();
        incoming.folders = library.folders;
        incoming.images = entries.map(x => ({ ...x, id: avatarId(), category: op.category, folderId: op.folderId }));
        return mergeAvatarLibrary(library, incoming);
    }
    if (op.type === "create-folder") {
        if (!isCategory(op.category)) throw new Error("分类不正确");
        const name = avatarFolderName(op.name);
        if (library.folders.some(x => x.category === op.category && x.name === name)) throw new Error("该分类已有同名文件夹");
        library.folders.push({ id: avatarId(), name, category: op.category });
    } else if (op.type === "rename-folder" || op.type === "delete-folder") {
        const folder = library.folders.find(x => x.id === op.id);
        if (!folder) throw new Error("文件夹不存在");
        if (op.type === "rename-folder") {
            const name = avatarFolderName(op.name);
            if (library.folders.some(x => x.id !== op.id && x.category === folder.category && x.name === name)) throw new Error("该分类已有同名文件夹");
            folder.name = name;
        } else {
            library.folders = library.folders.filter(x => x.id !== op.id);
            library.images.forEach(x => { if (x.folderId === op.id) x.folderId = null; });
        }
    } else {
        const image = library.images.find(x => x.id === op.id);
        if (!image) throw new Error("图片不存在");
        if (op.type === "edit") image.description = op.description.trim();
        if (op.type === "move") {
            if (library.images.some(x => x.id !== image.id && x.category === op.category && x.url === image.url)) throw new Error("目标分类已有相同 URL（含回收站）");
            image.category = op.category; image.folderId = op.folderId;
        }
        if (op.type === "delete") image.deletedAt = new Date().toISOString();
        if (op.type === "restore") delete image.deletedAt;
    }
    return result;
}
