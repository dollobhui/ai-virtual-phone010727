"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent } from "react";
import { Folder, Plus, MoreHorizontal, ChevronLeft, ChevronRight, GripVertical } from "lucide-react";
import { BottomSheet, ConfirmDialog, ContentDialog } from "@/components/ui/modal";
import { configFolderFor, UNCLASSIFIED_FOLDER_ID, type ConfigFolder } from "@/lib/config-folder-types";
import { useFolderGridSort } from "@/lib/use-folder-grid-sort";
import type { ConfigFolderController } from "@/lib/use-config-folders";

const UNCLASSIFIED: ConfigFolder = { id: UNCLASSIFIED_FOLDER_ID, name: "未分类" };

export function ConfigFolderPicker({ controller, title, onSelect, onCancel }: {
    controller: ConfigFolderController; title: string; onSelect: (id: string) => void; onCancel: () => void;
}) {
    const [target, setTarget] = useState(controller.currentFolderId ?? UNCLASSIFIED_FOLDER_ID);
    const folders = [UNCLASSIFIED, ...controller.metadata.folders];
    return <ContentDialog title={title} confirmLabel="确定" onCancel={onCancel} onConfirm={() => {
        if (folders.some(folder => folder.id === target)) onSelect(target);
        else setTarget(UNCLASSIFIED_FOLDER_ID);
    }}>
        <label className="menu-desc" htmlFor="config-folder-target">目标文件夹</label>
        <select id="config-folder-target" className="ui-select mt-2" value={target} onChange={event => setTarget(event.target.value)}>
            {controller.metadata.order.map(id => {
                const folder = folders.find(folder => folder.id === id);
                return folder ? <option key={id} value={id}>{folder.name}</option> : null;
            })}
        </select>
        {!folders.some(folder => folder.id === target) && <p role="alert" className="menu-desc">目标文件夹已删除，请重新选择。</p>}
        {controller.error && <p role="alert" className="menu-desc">{controller.error}</p>}
    </ContentDialog>;
}

function FolderCard({ folder, count, sorting, dragging, onOpen, onMenu, onDragStart, onKeyboardMove }: {
    folder: ConfigFolder; count: number; sorting: boolean; dragging: boolean;
    onOpen: () => void; onMenu: () => void; onDragStart: (event: PointerEvent<HTMLDivElement>) => void;
    onKeyboardMove: (offset: number) => void;
}) {
    const press = useRef<{ x: number; y: number; timer?: ReturnType<typeof setTimeout>; long: boolean } | null>(null);
    const suppressClick = useRef(false);
    const longClickCleanup = useRef<(() => void) | null>(null);
    const clearPress = () => {
        if (press.current?.timer) clearTimeout(press.current.timer);
        press.current = null;
    };
    useEffect(() => () => {
        if (press.current?.timer) clearTimeout(press.current.timer);
        longClickCleanup.current?.();
    }, []);
    const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
        clearPress();
        suppressClick.current = false;
        press.current = { x: event.clientX, y: event.clientY, long: false };
        if (sorting) {
            onDragStart(event);
        } else {
            const pointerId = event.pointerId;
            press.current.timer = setTimeout(() => {
                if (press.current) press.current.long = true;
                suppressClick.current = true;
                // The menu overlay may receive the release-click instead of this
                // card. Suppress only this pointer's click, before React sees it.
                longClickCleanup.current?.();
                const ignoreReleaseClick = (click: Event) => {
                    if ((click as globalThis.PointerEvent).pointerId !== pointerId) return;
                    click.preventDefault();
                    click.stopImmediatePropagation();
                    cleanup();
                };
                const timeout = setTimeout(() => cleanup(), 1500);
                const cleanup = () => {
                    clearTimeout(timeout);
                    window.removeEventListener("click", ignoreReleaseClick, true);
                    longClickCleanup.current = null;
                };
                longClickCleanup.current = cleanup;
                window.addEventListener("click", ignoreReleaseClick, true);
                onMenu();
            }, 500);
        }
    };
    return <div data-folder-id={folder.id} className="ui-config-card min-w-0 cursor-pointer relative"
        style={{ aspectRatio: "3 / 2", padding: "16px", justifyContent: "space-between", touchAction: sorting ? "none" : "pan-y", opacity: dragging ? 0 : 1, userSelect: sorting ? "none" : undefined, WebkitUserSelect: sorting ? "none" : undefined, WebkitTouchCallout: "none" }}
        role="button" tabIndex={0} aria-label={`${folder.name}，${count} 个配置${sorting ? "，用方向键排序" : ""}`}
        onClick={() => { if (!sorting && !suppressClick.current) onOpen(); suppressClick.current = false; }}
        onContextMenu={event => { event.preventDefault(); if (!sorting) onMenu(); }}
        onPointerDown={pointerDown}
        onPointerMove={event => {
            if (!press.current) return;
            if (!sorting && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8) {
                suppressClick.current = true;
                clearPress();
            }
        }}
        onPointerUp={clearPress}
        onPointerCancel={clearPress}
        onKeyDown={event => {
            if (event.target !== event.currentTarget) return;
            const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2 };
            if (sorting && offsets[event.key]) { event.preventDefault(); onKeyboardMove(offsets[event.key]); }
            else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!sorting) onOpen(); }
            else if (!sorting && event.key === "F10" && event.shiftKey) { event.preventDefault(); onMenu(); }
        }}>
        <div className="min-w-0 flex flex-col gap-1.5 pr-5">
            <div className="flex items-center gap-1.5 min-w-0"><Folder size={16} className="shrink-0" />
                <span className="truncate text-[calc(14.4px*var(--app-text-scale,1))] font-bold text-[var(--c-text-title)]">{folder.name}</span></div>
            <span className="menu-desc">{count} 个配置</span>
        </div>
        {!sorting && <button type="button" aria-label={`管理文件夹 ${folder.name}`} className="ui-link-btn absolute"
            style={{ top: 0, right: 2, width: 44, height: 44, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={event => { event.stopPropagation(); onMenu(); }}><MoreHorizontal size={18} /></button>}
        <div className="flex items-center justify-between gap-2"><span className="menu-desc ts-12">配置 {count}</span>
            {sorting ? <GripVertical size={16} className="opacity-40" /> : <ChevronRight data-folder-arrow size={16} className="opacity-40 shrink-0" />}</div>
    </div>;
}

export function ConfigFolderBrowser<T extends { id: string }>({ controller, items, searchText, children, columns = 2, active = true }: {
    controller: ConfigFolderController; items: T[]; searchText: (item: T) => string;
    children: (item: T) => ReactNode; columns?: 1 | 2; active?: boolean;
}) {
    const { metadata, currentFolderId, setCurrentFolderId, error, ready, busy, run } = controller;
    const [query, setQuery] = useState("");
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [moveOpen, setMoveOpen] = useState(false);
    const [menuId, setMenuId] = useState<string | null>(null);
    const [nameDialog, setNameDialog] = useState<{ id?: string; name: string } | null>(null);
    const [deleteId, setDeleteId] = useState<string | null>(null);
    const [draftOrder, setDraftOrder] = useState<string[] | null>(null);
    const { gridRef, dragId, start, gridEvents, keyboardMove } = useFolderGridSort(draftOrder, setDraftOrder);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const folders = useMemo(() => new Map([UNCLASSIFIED, ...metadata.folders].map(folder => [folder.id, folder])), [metadata.folders]);
    const counts = useMemo(() => {
        const result = new Map<string, number>();
        for (const item of items) {
            const id = configFolderFor(metadata, item.id);
            result.set(id, (result.get(id) ?? 0) + 1);
        }
        return result;
    }, [metadata, items]);
    const visible = items.filter(item => normalizedQuery
        ? searchText(item).toLocaleLowerCase().includes(normalizedQuery)
        : configFolderFor(metadata, item.id) === currentFolderId);
    const clearSelection = () => { setSelected(new Set()); setSelecting(false); setMoveOpen(false); };
    useEffect(() => { setSelected(new Set()); setSelecting(false); setMoveOpen(false); }, [currentFolderId, query, active]);
    useEffect(() => {
        setSelected(previous => new Set([...previous].filter(id => items.some(item => item.id === id))));
    }, [items]);
    const showList = currentFolderId !== null || !!normalizedQuery;
    const toggle = (id: string) => setSelected(previous => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });
    if (!active) return error ? <p role="alert" className="menu-desc">{error}</p> : null;
    return <div className="flex flex-col gap-3">
        {error && <div role="alert" className="ui-config-card"><p className="menu-desc">{error}</p><button className="ui-btn ui-btn-outline" onClick={() => void controller.reload()}>重新读取</button></div>}
        {!ready ? <p className="menu-desc">{error ? "分类操作暂不可用" : "正在读取文件夹…"}</p> : <>
            {draftOrder ? <div className="flex flex-wrap items-center gap-2">
                <span className="menu-desc flex-1" aria-live="polite">拖动文件夹排序，也可使用方向键</span>
                <button className="ui-btn ui-btn-outline" disabled={busy} onClick={() => { setDraftOrder(null); }}>取消</button>
                <button className="ui-btn ui-btn-primary" disabled={busy || dragId !== null} onClick={async () => {
                    if (await run({ type: "reorder", order: draftOrder })) setDraftOrder(null);
                }}>保存排序</button>
            </div> : <>
                <div className="flex gap-2 items-center">
                    <div className="flex-1 min-w-0">
                        <input aria-label="搜索当前类别的全部配置" className="ui-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索全部文件夹中的配置" /></div>
                    <button aria-label="新建文件夹" className="ui-btn ui-btn-outline shrink-0" disabled={busy} onClick={() => setNameDialog({ name: "" })}><Plus size={15} />文件夹</button>
                </div>
                {showList && <div className="flex flex-wrap items-center gap-2">
                    <button aria-label="返回文件夹主页" className="ui-link-btn" onClick={() => { setCurrentFolderId(null); setQuery(""); clearSelection(); }}><ChevronLeft size={16} />文件夹</button>
                    <span className="menu-label font-semibold min-w-0 flex-1 truncate">{normalizedQuery ? `搜索结果 (${visible.length})` : folders.get(currentFolderId!)?.name}</span>
                    <button className="ui-btn ui-btn-outline" disabled={busy} onClick={() => { clearSelection(); setSelecting(!selecting); }}>{selecting ? "取消选择" : "批量选择"}</button>
                </div>}
                {selecting && <div className="flex flex-wrap items-center gap-2">
                    <span className="menu-desc flex-1" aria-live="polite">已选 {selected.size} 个配置</span>
                    <button className="ui-btn ui-btn-outline" onClick={() => setSelected(new Set(visible.map(item => item.id)))}>全选</button>
                    <button className="ui-btn ui-btn-primary" disabled={busy || !selected.size} onClick={() => setMoveOpen(true)}>移动到</button>
                </div>}
            </>}
            {!showList || draftOrder ? <div ref={gridRef} {...gridEvents} className="grid grid-cols-2 gap-3">
                {(draftOrder ?? metadata.order).map(id => {
                    const folder = folders.get(id);
                    return folder ? <div key={id} data-folder-slot={id} className="min-w-0"><FolderCard folder={folder} count={counts.get(id) ?? 0} sorting={draftOrder !== null} dragging={dragId === id}
                        onOpen={() => setCurrentFolderId(id)} onMenu={() => setMenuId(id)} onDragStart={event => start(id, event)}
                        onKeyboardMove={offset => keyboardMove(id, offset)} /></div> : null;
                })}
            </div> : visible.length ? <div className={columns === 2 ? "grid grid-cols-2 gap-3" : "flex flex-col gap-3"}>
                {visible.map(item => <div key={item.id} className="relative min-w-0" onClickCapture={event => {
                    if (selecting && !(event.target as HTMLElement).closest("input")) { event.preventDefault(); event.stopPropagation(); toggle(item.id); }
                }} onKeyDownCapture={event => {
                    if (selecting && !(event.target as HTMLElement).closest("input") && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault(); event.stopPropagation(); toggle(item.id);
                    }
                }}>
                    {selecting && <input type="checkbox" className="absolute top-2 right-2 z-10 w-5 h-5 accent-black" aria-label={`选择配置 ${searchText(item)}`} checked={selected.has(item.id)} onChange={() => toggle(item.id)} />}
                    {children(item)}
                </div>)}
            </div> : <div className="ui-empty"><span className="menu-desc">{normalizedQuery ? "没有匹配的配置" : "此文件夹暂无配置，可使用页面上方的新建按钮"}</span></div>}
        </>}
        {menuId && <BottomSheet title={folders.get(menuId)?.name ?? "文件夹"} onClose={() => setMenuId(null)}>
            <div className="flex flex-col gap-3">
                {menuId !== UNCLASSIFIED_FOLDER_ID && <>
                    <button className="ui-btn ui-btn-outline" onClick={() => { setNameDialog({ id: menuId, name: folders.get(menuId)?.name ?? "" }); setMenuId(null); }}>重命名</button>
                    <button className="ui-btn ui-btn-outline" onClick={() => { setDeleteId(menuId); setMenuId(null); }}>删除文件夹</button>
                </>}
                <button className="ui-btn ui-btn-primary" onClick={() => { setDraftOrder([...metadata.order]); setMenuId(null); clearSelection(); }}>排序</button>
            </div>
        </BottomSheet>}
        {nameDialog && <ContentDialog title={nameDialog.id ? "重命名文件夹" : "创建文件夹"} onCancel={() => { if (!busy) setNameDialog(null); }} onConfirm={async () => {
            if (busy) return;
            const id = nameDialog.id ?? `folder_${crypto.randomUUID()}`;
            if (await run({ type: nameDialog.id ? "rename" : "create", id, name: nameDialog.name })) setNameDialog(null);
        }}><input aria-label="文件夹名称" className="ui-input" value={nameDialog.name} onChange={event => setNameDialog({ ...nameDialog, name: event.target.value })} placeholder="最多 30 个字符" autoFocus />
            {error && <p role="alert" className="menu-desc">{error}</p>}
        </ContentDialog>}
        {deleteId && <ConfirmDialog title="删除文件夹？" message={`「${folders.get(deleteId)?.name ?? ""}」包含 ${counts.get(deleteId) ?? 0} 个配置。删除后配置将移入未分类，配置本身不会删除。${error ? ` ${error}` : ""}`}
            variant="danger" onCancel={() => { if (!busy) setDeleteId(null); }} onConfirm={async () => {
                if (!busy && await run({ type: "delete", id: deleteId })) setDeleteId(null);
            }} />}
        {moveOpen && <ConfigFolderPicker controller={controller} title="批量移动配置" onCancel={() => setMoveOpen(false)} onSelect={async folderId => {
            if (busy) return;
            const configIds = [...selected].filter(id => items.some(item => item.id === id));
            if (await run({ type: "move", configIds, folderId })) clearSelection();
        }} />}
    </div>;
}
