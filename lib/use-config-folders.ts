"use client";

import { useCallback, useEffect, useState } from "react";
import { CONFIG_FOLDERS_UPDATED_EVENT, loadConfigFolders, updateConfigFolders } from "./config-folder-storage";
import { configFolderFor, emptyConfigFolders, UNCLASSIFIED_FOLDER_ID, type ConfigFolderCategory, type ConfigFolderOperation } from "./config-folder-types";

export function useConfigFolders(category: ConfigFolderCategory) {
    const [metadata, setMetadata] = useState(emptyConfigFolders);
    const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const reload = useCallback(async () => {
        try {
            setMetadata(await loadConfigFolders(category));
            setReady(true);
            setError("");
        } catch (error) {
            setReady(false);
            setError(error instanceof Error ? error.message : "文件夹读取失败，原数据已保留");
        }
    }, [category]);
    useEffect(() => {
        void reload();
        const refresh = (event: Event) => {
            if ((event as CustomEvent<string>).detail === category) void reload();
        };
        window.addEventListener(CONFIG_FOLDERS_UPDATED_EVENT, refresh);
        return () => window.removeEventListener(CONFIG_FOLDERS_UPDATED_EVENT, refresh);
    }, [category, reload]);
    useEffect(() => {
        if (ready && currentFolderId && currentFolderId !== UNCLASSIFIED_FOLDER_ID
            && !metadata.folders.some(folder => folder.id === currentFolderId)) setCurrentFolderId(UNCLASSIFIED_FOLDER_ID);
    }, [ready, currentFolderId, metadata.folders]);
    const run = useCallback(async (operation: ConfigFolderOperation): Promise<boolean> => {
        setBusy(true);
        try {
            setMetadata(await updateConfigFolders(category, operation));
            setError("");
            return true;
        } catch (error) {
            setError(error instanceof Error ? error.message : "文件夹保存失败，请重试；原数据已保留");
            return false;
        } finally { setBusy(false); }
    }, [category]);
    const assign = useCallback((id: string, folderId: string | null) => run({
        type: "move", configIds: [id], folderId: folderId ?? UNCLASSIFIED_FOLDER_ID, fallbackToUnclassified: true,
    }), [run]);
    const removeAssociation = useCallback((configId: string) => run({ type: "remove-config", configId }), [run]);
    return { metadata, currentFolderId, setCurrentFolderId, error, ready, busy, reload, run, assign,
        removeAssociation, folderFor: (id: string) => configFolderFor(metadata, id) };
}

export type ConfigFolderController = ReturnType<typeof useConfigFolders>;
