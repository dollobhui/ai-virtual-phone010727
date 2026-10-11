"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AvatarDialog } from "./avatar-dialog";
import { AVATAR_CATEGORIES, AVATAR_CATEGORY_LABELS, emptyAvatarLibrary, parseAvatarLibrary, type AvatarCategory, type AvatarLibrary, type AvatarLibraryOperation, type LibraryAvatar } from "@/lib/avatar-library";
import { AVATAR_LIBRARY_UPDATED_EVENT, loadAvatarLibrary, updateAvatarLibrary } from "@/lib/avatar-library-storage";
import { shareLibraryAvatar } from "@/lib/avatar-library-share";
import { hydrateChatStorage, loadChatContacts } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { MoreHorizontal, X, Check } from "lucide-react";
import styles from "./avatar-library.module.css";
import { AvatarTicket } from "./avatar-ticket";

type Editor = { type: "add" | "create-folder" | "rename-folder" | "edit" | "move" | "share"; id?: string; ids?: string[] };

export function AvatarLibraryPage({ menuOpen = false, onMenuClose = () => {} }: { menuOpen?: boolean; onMenuClose?: () => void }) {
    const [library, setLibrary] = useState<AvatarLibrary>(emptyAvatarLibrary);
    const [category, setCategory] = useState<AvatarCategory>("single");
    const [folderId, setFolderId] = useState<string | null>(null);
    const [trash, setTrash] = useState(false);
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const [notice, setNotice] = useState("");
    const [editor, setEditor] = useState<Editor | null>(null);
    const [text, setText] = useState("");
    const [targetCategory, setTargetCategory] = useState<AvatarCategory>("single");
    const [targetFolder, setTargetFolder] = useState<string | null>(null);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [characterId, setCharacterId] = useState("");
    const fileRef = useRef<HTMLInputElement>(null);
    const [folderOpen, setFolderOpen] = useState(false);
    const [folderMenu, setFolderMenu] = useState(false);
    const [selected, setSelected] = useState<string[]>([]);
    const [selecting, setSelecting] = useState(false);
    const [detailId, setDetailId] = useState<string | null>(null);
    const [deleteFolder, setDeleteFolder] = useState(false);

    useEffect(() => {
        if (!menuOpen) return;
        const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") onMenuClose(); };
        window.addEventListener("keydown", dismiss);
        return () => window.removeEventListener("keydown", dismiss);
    }, [menuOpen, onMenuClose]);

    const refresh = useCallback(async () => {
        try { setLibrary(await loadAvatarLibrary()); setReady(true); }
        catch (error) { setNotice(error instanceof Error ? error.message : "读取失败"); setReady(false); }
    }, []);
    useEffect(() => {
        void refresh();
        const handler = () => { void refresh(); };
        window.addEventListener(AVATAR_LIBRARY_UPDATED_EVENT, handler);
        return () => window.removeEventListener(AVATAR_LIBRARY_UPDATED_EVENT, handler);
    }, [refresh]);

    const run = async (work: () => Promise<void>) => {
        if (busyRef.current) return;
        busyRef.current = true; setBusy(true); setNotice("");
        try { await work(); }
        catch (error) { setNotice(error instanceof Error ? error.message : "操作失败，请重试"); }
        finally { busyRef.current = false; setBusy(false); }
    };
    const mutate = async (op: AvatarLibraryOperation) => {
        const result = await updateAvatarLibrary(op);
        setLibrary(result.library);
        return result;
    };
    const openEditor = (next: Editor, image?: LibraryAvatar) => {
        setText(next.type === "rename-folder" ? library.folders.find(x => x.id === next.id)?.name || "" : image?.description || "");
        if (next.type === "add") setText("");
        setTargetCategory(image?.category || category); setTargetFolder(image?.folderId || null);
        setEditor(next);
        if (next.type === "share") {
            setCharacters([]); setCharacterId("");
            void run(async () => {
                await hydrateChatStorage();
                const contacts = new Set(loadChatContacts().map(x => x.characterId));
                const candidates = loadCharacters().filter(x => contacts.has(x.id));
                setCharacters(candidates); setCharacterId(candidates[0]?.id || "");
            });
        }
    };
    const submit = () => { void run(async () => {
        if (!editor) return;
        if (editor.type === "share") {
            if (!characterId) throw new Error("请先在聊天中添加角色为联系人");
            await shareLibraryAvatar(editor.id!, characterId);
        } else {
            const op: AvatarLibraryOperation = editor.type === "add" ? { type: "add", text, category, folderId }
                : editor.type === "create-folder" ? { type: "create-folder", category, name: text }
                : editor.type === "rename-folder" ? { type: "rename-folder", id: editor.id!, name: text }
                : editor.type === "edit" ? { type: "edit", id: editor.id!, description: text }
                : { type: "batch", operations: (editor.ids || [editor.id!]).map(id => ({ type: "move" as const, id, category: targetCategory, folderId: targetFolder })) };
            const result = await mutate(op);
            setNotice(editor.type === "add" ? `已添加 ${result.added} 张，跳过 ${result.skipped} 个重复 URL（含回收站）` : "");
        }
        setEditor(null);
        if (editor?.type === "move") setDetailId(null);
        setSelected([]); setSelecting(false);
    }); };
    const exportJson = () => { void run(async () => {
        const data = await loadAvatarLibrary();
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = "avatar-library.json"; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice("已导出 JSON 备份，包含回收站记录");
    }); };
    const folders = library.folders.filter(x => x.category === category);
    const currentFolder = folders.find(x => x.id === folderId);
    const images = library.images.filter(x => x.category === category && (trash ? Boolean(x.deletedAt) : !x.deletedAt && x.folderId === (currentFolder?.id || null)));
    const disabled = busy || !ready;
    const titles = { add: "添加 / 批量导入 URL", "create-folder": "新建文件夹", "rename-folder": "重命名文件夹", edit: "编辑图片描述", move: "移动图片", share: "分享给 TA 换上" };

    const detail = library.images.find(x => x.id === detailId && !x.deletedAt);
    const folderCards = [{ id: null, name: "未分类" }, ...folders];
    const closeFolder = () => { if (!busy) { setFolderOpen(false); setTrash(false); setFolderMenu(false); setDetailId(null); setSelected([]); setSelecting(false); } };
    const chooseFolder = (id: string | null) => { setFolderId(id); setFolderOpen(true); setFolderMenu(false); setSelected([]); setSelecting(false); };
    const batchAction = (type: "delete" | "restore", ids: string[]) => { void run(async () => {
        await mutate({ type: "batch", operations: ids.map(id => ({ type, id })) });
        setSelected([]); setSelecting(false); setDetailId(null); setFolderMenu(false);
        setNotice(type === "delete" ? "已移入回收站" : "图片已恢复到原文件夹");
    }); };
    const moreButton = <button className={styles.iconButton} aria-label="文件夹更多" aria-expanded={folderMenu} disabled={disabled} onClick={() => setFolderMenu(x => !x)}><MoreHorizontal size={20} /></button>;
    const thumbnailGrid = <div className={styles.imageGrid}>
        {images.map(image => <button key={image.id} className={`${styles.thumbnail} ${selected.includes(image.id) ? styles.selected : ""}`} aria-label={`查看头像：${image.description || "暂无描述"}`} aria-pressed={selecting ? selected.includes(image.id) : undefined} disabled={disabled} onClick={() => {
            if (trash) batchAction("restore", [image.id]);
            else if (selecting) setSelected(ids => ids.includes(image.id) ? ids.filter(id => id !== image.id) : [...ids, image.id]);
            else setDetailId(image.id);
        }}>
            <img src={image.url} alt={image.description || "头像预览"} loading="lazy" referrerPolicy="no-referrer" />
            {selecting && <span className={styles.check}>{selected.includes(image.id) && <Check size={13} />}</span>}
            {trash && <span className={styles.restore}>恢复</span>}
        </button>)}
    </div>;

    return <div className={`avatar-library-page ${styles.page}`} aria-label="头像库">
        {menuOpen && <><button className={styles.menuBackdrop} aria-label="关闭头像库菜单" onClick={onMenuClose} />
            <div className={styles.pageMenu} role="group" aria-label="头像库操作" onKeyDown={e => { if (e.key === "Escape") onMenuClose(); }}>
                <button disabled={disabled} onClick={() => { onMenuClose(); openEditor({ type: "create-folder" }); setText(""); }}>新建文件夹</button>
                <button disabled={disabled} onClick={() => { onMenuClose(); fileRef.current?.click(); }}>导入数据</button>
                <button disabled={disabled} onClick={() => { onMenuClose(); exportJson(); }}>导出数据</button>
                <button disabled={disabled} onClick={() => { onMenuClose(); setTrash(true); setFolderOpen(true); setSelected([]); setSelecting(false); }}>回收站</button>
            </div>
        </>}
        <div className={styles.categories} role="group" aria-label="头像分类">
            {AVATAR_CATEGORIES.map(x => <button key={x} aria-pressed={category === x} onClick={() => { setCategory(x); setFolderId(null); }}>{AVATAR_CATEGORY_LABELS[x]}</button>)}
        </div>
        <input ref={fileRef} className="hidden" type="file" accept=".json,application/json" aria-label="导入头像库 JSON" onChange={e => {
            const file = e.target.files?.[0]; e.target.value = "";
            if (file) void run(async () => {
                const result = await mutate({ type: "import", data: parseAvatarLibrary(await file.text()) });
                setNotice(`合并完成：新增 ${result.added} 张，跳过 ${result.skipped} 个重复 URL；已有数据已保留`);
            });
        }} />
        {notice && <p role="status" className={styles.notice}>{notice}</p>}
        {!ready && <button className="ui-btn ui-btn-outline" onClick={() => { void refresh(); }}>重新读取</button>}
        <div className={styles.folderGrid}>
            {folderCards.map(folder => {
                const contents = library.images.filter(x => x.category === category && !x.deletedAt && x.folderId === folder.id);
                return <button key={folder.id || "default"} className={styles.folderCard} aria-label={`打开文件夹：${folder.name}，${contents.length}张`} disabled={disabled} onClick={() => chooseFolder(folder.id)}>
                    <AvatarTicket url={contents[0]?.url} />
                    <span className={styles.folderCaption}><span>{folder.name}</span></span>
                </button>;
            })}
        </div>
        {folderOpen && !editor && !detail && !deleteFolder && <AvatarDialog title={trash ? "回收站" : currentFolder?.name || "未分类"} dialogLabel={trash ? "回收站" : "文件夹内容"} dialogClassName={styles.folderDialog} onCancel={closeFolder} onConfirm={() => {}} confirmLabel="" cancelLabel="" onKeyDown={e => { if (e.key === "Escape") { if (folderMenu) setFolderMenu(false); else closeFolder(); } }} headerAction={<div className={styles.dialogActions}>{!trash && moreButton}<button className={styles.iconButton} aria-label="关闭文件夹" disabled={busy} onClick={closeFolder}><X size={18} /></button></div>}>
            <div className={styles.folderToolbar}><span>{selecting ? `已选 ${selected.length} 个` : `共 ${images.length} 张`}</span>
                {selecting && <><button disabled={disabled} onClick={() => setSelected(images.map(x => x.id))}>全选</button><button disabled={disabled} onClick={() => { setSelected([]); setSelecting(false); }}>取消</button></>}
            </div>
            {folderMenu && <><button className={styles.folderMenuBackdrop} aria-label="关闭文件夹菜单" onClick={() => setFolderMenu(false)} /><div className={styles.folderMenu} role="group" aria-label="文件夹操作">
                {currentFolder && <button onClick={() => { setFolderMenu(false); openEditor({ type: "rename-folder", id: currentFolder.id }); }}>重命名</button>}
                <button onClick={() => { setFolderMenu(false); openEditor({ type: "add" }); }}>添加头像</button>
                <button onClick={() => { setFolderMenu(false); setSelecting(true); }}>多选</button>
                <button disabled={!selected.length} onClick={() => { setFolderMenu(false); openEditor({ type: "move", ids: selected }); }}>移动所选</button>
                <button className={styles.danger} disabled={!selected.length} onClick={() => batchAction("delete", selected)}>删除所选</button>
                {currentFolder && <button className={styles.danger} onClick={() => { setFolderMenu(false); setDeleteFolder(true); }}>删除文件夹</button>}
            </div></>}
            {images.length ? thumbnailGrid : <p className={styles.empty}>{trash ? "回收站为空" : "这个文件夹还没有头像"}</p>}
            {notice && <p role="status" className={styles.notice}>{notice}</p>}
        </AvatarDialog>}
        {detail && !editor && <AvatarDialog title="头像详情" dialogLabel="头像详情" dialogClassName={styles.detailDialog} onCancel={() => setDetailId(null)} onConfirm={() => {}} confirmLabel="" cancelLabel="" onKeyDown={e => { if (e.key === "Escape") setDetailId(null); }} headerAction={<button className={styles.iconButton} aria-label="关闭头像详情" onClick={() => setDetailId(null)}><X size={18} /></button>}>
            <img className={styles.detailImage} src={detail.url} alt={detail.description || "头像预览"} referrerPolicy="no-referrer" />
            <p className={styles.description}>{detail.description || "暂无描述"}</p>
            <a className={styles.url} href={detail.url} target="_blank" rel="noopener noreferrer">查看图片 URL</a>
            <button className={styles.shareButton} disabled={disabled} onClick={() => openEditor({ type: "share", id: detail.id }, detail)}>分享给 TA 换上</button>
            <div className={styles.detailActions}><button disabled={disabled} onClick={() => openEditor({ type: "edit", id: detail.id }, detail)}>编辑描述</button><button disabled={disabled} onClick={() => openEditor({ type: "move", id: detail.id }, detail)}>移动</button><button className={styles.danger} disabled={disabled} onClick={() => batchAction("delete", [detail.id])}>删除</button></div>
        </AvatarDialog>}
        {deleteFolder && currentFolder && <AvatarDialog title="删除文件夹" dialogLabel="删除文件夹" onCancel={() => setDeleteFolder(false)} onConfirm={() => { void run(async () => { await mutate({ type: "delete-folder", id: currentFolder.id }); setDeleteFolder(false); setFolderId(null); setFolderOpen(false); setNotice("文件夹已删除，头像已移回未分类"); }); }} confirmLabel={busy ? "处理中…" : "删除文件夹"}>
            <p>删除「{currentFolder.name}」后，里面的头像会移回未分类。</p>
            {notice && <p role="status">{notice}</p>}
        </AvatarDialog>}
        {editor && <AvatarDialog title={titles[editor.type]} dialogLabel={titles[editor.type]} onCancel={() => { if (!busy) setEditor(null); }} onConfirm={submit} confirmLabel={busy ? "处理中…" : editor.type === "share" ? "发送推荐" : "保存"} onKeyDown={e => { if (e.key === "Escape" && !busy) setEditor(null); }}>
            {editor.type === "move" ? <div className="space-y-3">
                <label className="block">目标分类<select className="ui-input w-full" value={targetCategory} onChange={e => { setTargetCategory(e.target.value as AvatarCategory); setTargetFolder(null); }}>{AVATAR_CATEGORIES.map(x => <option key={x} value={x}>{AVATAR_CATEGORY_LABELS[x]}</option>)}</select></label>
                <label className="block">目标文件夹<select className="ui-input w-full" value={targetFolder || ""} onChange={e => setTargetFolder(e.target.value || null)}><option value="">未分类</option>{library.folders.filter(x => x.category === targetCategory).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
            </div> : editor.type === "share" ? <>
                <p className="text-sm mb-3">选择已添加的角色，发送后进入对应聊天室。TA 会在正常回复中决定接受或拒绝。</p>
                <label className="block">角色<select className="ui-input w-full" value={characterId} onChange={e => setCharacterId(e.target.value)}>{characters.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
                {!characters.length && <p>请先在聊天中添加角色为联系人。</p>}
            </> : <label className="block">{editor.type === "add" ? "每行一个 URL，或 描述：URL" : editor.type === "edit" ? "图片描述" : "文件夹名称"}
                <textarea className="ui-input w-full mt-2" autoFocus rows={editor.type === "add" ? 6 : 3} value={text} onChange={e => setText(e.target.value)} placeholder={editor.type === "add" ? "https://example.com/a.png\n黑色西装头像：https://example.com/b.png" : ""} />
            </label>}
            {notice && <p role="status" className="text-sm mt-3 break-words">{notice}</p>}
        </AvatarDialog>}
    </div>;
}
