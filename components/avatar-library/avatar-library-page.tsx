"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ContentDialog } from "@/components/ui/modal";
import { AVATAR_CATEGORIES, AVATAR_CATEGORY_LABELS, emptyAvatarLibrary, parseAvatarLibrary, type AvatarCategory, type AvatarLibrary, type AvatarLibraryOperation, type LibraryAvatar } from "@/lib/avatar-library";
import { AVATAR_LIBRARY_UPDATED_EVENT, loadAvatarLibrary, updateAvatarLibrary } from "@/lib/avatar-library-storage";
import { shareLibraryAvatar } from "@/lib/avatar-library-share";
import { hydrateChatStorage, loadChatContacts } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";

type Editor = { type: "add" | "create-folder" | "rename-folder" | "edit" | "move" | "share"; id?: string };

export function AvatarLibraryPage() {
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
                : { type: "move", id: editor.id!, category: targetCategory, folderId: targetFolder };
            const result = await mutate(op);
            setNotice(editor.type === "add" ? `已添加 ${result.added} 张，跳过 ${result.skipped} 个重复 URL（含回收站）` : "已保存");
        }
        setEditor(null);
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

    return <div className="avatar-library-page p-4 space-y-4" aria-label="头像库">
        <p className="text-sm opacity-60">用图片 URL 收藏头像，分享给角色，由 TA 决定是否换上。</p>
        <div className="flex gap-2 flex-wrap" role="group" aria-label="头像分类">
            {AVATAR_CATEGORIES.map(x => <button key={x} className={`ui-btn ${category === x ? "ui-btn-primary" : "ui-btn-outline"}`} aria-pressed={category === x} onClick={() => { setCategory(x); setFolderId(null); }}>{AVATAR_CATEGORY_LABELS[x]}</button>)}
            <button className="ui-btn ui-btn-outline" aria-pressed={trash} onClick={() => setTrash(x => !x)}>{trash ? "返回头像库" : "回收站"}</button>
        </div>
        {!trash && <>
            <label className="block text-sm">文件夹
                <select className="ui-input w-full mt-2" aria-label="当前文件夹" value={currentFolder?.id || ""} onChange={e => setFolderId(e.target.value || null)}>
                    <option value="">未分类</option>{folders.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
            </label>
            <div className="flex gap-2 flex-wrap">
                <button className="ui-btn ui-btn-outline" disabled={disabled} onClick={() => { setEditor({ type: "create-folder" }); setText(""); }}>新建文件夹</button>
                {currentFolder && <>
                    <button className="ui-btn ui-btn-outline" disabled={disabled} onClick={() => openEditor({ type: "rename-folder", id: currentFolder.id })}>重命名</button>
                    <button className="ui-btn ui-btn-outline" disabled={disabled} onClick={() => { void run(async () => { await mutate({ type: "delete-folder", id: currentFolder.id }); setFolderId(null); setNotice("文件夹已删除，图片移回未分类"); }); }}>删除文件夹</button>
                </>}
                <button className="ui-btn ui-btn-primary" disabled={disabled} onClick={() => openEditor({ type: "add" })}>添加 URL</button>
            </div>
        </>}
        <div className="flex gap-2 flex-wrap">
            <button className="ui-btn ui-btn-outline" disabled={disabled} onClick={exportJson}>导出 JSON</button>
            <button className="ui-btn ui-btn-outline" disabled={disabled} onClick={() => fileRef.current?.click()}>导入 JSON</button>
            <input ref={fileRef} className="hidden" type="file" accept=".json,application/json" aria-label="导入头像库 JSON" onChange={e => {
                const file = e.target.files?.[0]; e.target.value = "";
                if (file) void run(async () => {
                    const data = parseAvatarLibrary(await file.text());
                    const result = await mutate({ type: "import", data });
                    setNotice(`合并完成：新增 ${result.added} 张，跳过 ${result.skipped} 个重复 URL；已有数据已保留`);
                });
            }} />
        </div>
        {notice && <p role="status" className="text-sm break-words">{notice}</p>}
        {!ready && <button className="ui-btn ui-btn-outline" onClick={() => { void refresh(); }}>重新读取</button>}
        {ready && images.length === 0 && <p className="text-sm opacity-60 py-8 text-center">{trash ? "回收站为空" : "这个文件夹还没有头像"}</p>}
        <div className="grid grid-cols-2 gap-3">
            {images.map(image => <article key={image.id} className="rounded-xl border p-2 space-y-2" style={{ borderColor: "var(--c-card-border)" }}>
                <img src={image.url} alt={image.description || "头像预览"} loading="lazy" referrerPolicy="no-referrer" className="w-full aspect-square object-cover rounded-lg" />
                <p className="text-sm break-words">{image.description || "暂无描述"}</p>
                <a href={image.url} target="_blank" rel="noopener noreferrer" className="text-xs opacity-60 block truncate">查看图片 URL</a>
                {trash ? <button className="ui-btn ui-btn-outline w-full" disabled={disabled} onClick={() => { void run(async () => { await mutate({ type: "restore", id: image.id }); setNotice("图片已恢复到原文件夹"); }); }}>恢复</button>
                    : <div className="flex gap-1 flex-wrap">
                        <button className="ui-btn ui-btn-primary w-full" disabled={disabled} onClick={() => openEditor({ type: "share", id: image.id }, image)}>分享给 TA 换上</button>
                        <button className="ui-btn ui-btn-outline" disabled={disabled} onClick={() => openEditor({ type: "edit", id: image.id }, image)}>描述</button>
                        <button className="ui-btn ui-btn-outline" disabled={disabled} onClick={() => openEditor({ type: "move", id: image.id }, image)}>移动</button>
                        <button className="ui-btn ui-btn-outline" disabled={disabled} onClick={() => { void run(async () => { await mutate({ type: "delete", id: image.id }); setNotice("已移入回收站"); }); }}>删除</button>
                    </div>}
            </article>)}
        </div>
        {editor && <ContentDialog title={titles[editor.type]} dialogLabel={titles[editor.type]} onCancel={() => { if (!busy) setEditor(null); }} onConfirm={submit} confirmLabel={busy ? "处理中…" : editor.type === "share" ? "发送推荐" : "保存"} onKeyDown={e => { if (e.key === "Escape" && !busy) setEditor(null); }}>
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
        </ContentDialog>}
    </div>;
}
