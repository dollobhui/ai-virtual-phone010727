import { hydrateKvDb, isKvHydrated, kvGet, kvUpdateCommitted } from "./kv-db";
import { AVATAR_LIBRARY_KEY, emptyAvatarLibrary, parseAvatarLibrary, applyAvatarLibraryOperation, type AvatarLibraryOperation } from "./avatar-library";

export const AVATAR_LIBRARY_UPDATED_EVENT = "avatar-library-updated";
function readLibrary(raw: string | null) {
    if (raw === null) return emptyAvatarLibrary();
    try { return parseAvatarLibrary(raw); }
    catch { throw new Error("头像库数据读取失败，原数据已保留"); }
}
export async function loadAvatarLibrary() {
    await hydrateKvDb();
    if (!isKvHydrated()) throw new Error("头像库存储读取失败，请重试");
    return readLibrary(kvGet(AVATAR_LIBRARY_KEY));
}
export async function updateAvatarLibrary(operation: AvatarLibraryOperation) {
    await loadAvatarLibrary();
    let added = 0;
    let skipped = 0;
    const raw = await kvUpdateCommitted(AVATAR_LIBRARY_KEY, value => {
        const result = applyAvatarLibraryOperation(readLibrary(value), operation);
        added = result.added; skipped = result.skipped;
        return JSON.stringify(result.library);
    });
    window.dispatchEvent(new Event(AVATAR_LIBRARY_UPDATED_EVENT));
    return { library: readLibrary(raw), added, skipped };
}
