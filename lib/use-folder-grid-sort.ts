"use client";

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { moveFolderInOrder } from "@/lib/config-folder-types";

const DURATION = 200;
const EASING = "cubic-bezier(.2,.8,.2,1)";
type Drag = {
    id: string; pointerId: number; x: number; y: number; startX: number; startY: number;
    rect: DOMRect; overlay: HTMLElement; frame: number; dropping: boolean;
};

/** Layout slots stay untransformed: animated card rectangles must not drive hit-testing. */
export function useFolderGridSort(order: string[] | null, onOrder: (order: string[]) => void) {
    const gridRef = useRef<HTMLDivElement>(null);
    const orderRef = useRef(order);
    const onOrderRef = useRef(onOrder);
    const drag = useRef<Drag | null>(null);
    const animations = useRef(new Map<HTMLElement, Animation>());
    const before = useRef(new Map<string, DOMRect>());
    const reduced = useRef(false);
    const [dragId, setDragId] = useState<string | null>(null);
    useLayoutEffect(() => { orderRef.current = order; onOrderRef.current = onOrder; });

    const slots = () => [...(gridRef.current?.querySelectorAll<HTMLElement>("[data-folder-slot]") ?? [])];
    const clear = () => {
        const current = drag.current;
        drag.current = null;
        if (current) {
            cancelAnimationFrame(current.frame);
            current.overlay.remove();
            if (gridRef.current?.hasPointerCapture(current.pointerId)) gridRef.current.releasePointerCapture(current.pointerId);
        }
        animations.current.forEach(animation => animation.cancel());
        animations.current.clear();
        before.current.clear();
    };
    useEffect(() => {
        const media = matchMedia("(prefers-reduced-motion: reduce)");
        const update = () => { reduced.current = media.matches; };
        update();
        media.addEventListener("change", update);
        return () => { media.removeEventListener("change", update); clear(); };
    }, []);
    useEffect(() => {
        if (!order) { clear(); setDragId(null); }
    }, [order]);

    const move = (id: string, index: number) => {
        const current = orderRef.current;
        if (!current || drag.current?.dropping || index < 0 || index >= current.length || current.indexOf(id) === index) return;
        // Sample visual positions before interrupting an in-flight animation.
        before.current = new Map(slots().map(slot => [slot.dataset.folderSlot!, slot.firstElementChild!.getBoundingClientRect()]));
        const next = moveFolderInOrder(current, current.indexOf(id), index);
        orderRef.current = next;
        onOrderRef.current(next);
    };
    useLayoutEffect(() => {
        for (const slot of slots()) {
            const card = slot.firstElementChild as HTMLElement;
            const old = before.current.get(slot.dataset.folderSlot!);
            const rect = slot.getBoundingClientRect();
            animations.current.get(card)?.cancel();
            animations.current.delete(card);
            if (!old || reduced.current || drag.current?.id === slot.dataset.folderSlot) continue;
            const x = old.left - rect.left, y = old.top - rect.top;
            if (!x && !y) continue;
            const animation = card.animate([
                { transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" },
            ], { duration: DURATION, easing: EASING });
            animations.current.set(card, animation);
            animation.onfinish = () => { if (animations.current.get(card) === animation) animations.current.delete(card); };
        }
        before.current.clear();
    }, [order]);

    const tick = () => {
        const current = drag.current;
        if (!current || current.dropping) return;
        const dx = current.x - current.startX, dy = current.y - current.startY;
        current.overlay.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${reduced.current ? 1 : 1.035})`;
        const scroller = gridRef.current?.closest<HTMLElement>(".page-body");
        if (scroller) {
            const rect = scroller.getBoundingClientRect();
            const step = current.y < rect.top + 48 ? -8 : current.y > rect.bottom - 48 ? 8 : 0;
            if (step) scroller.scrollTop += step;
        }
        const centerX = current.rect.left + current.rect.width / 2 + dx;
        const centerY = current.rect.top + current.rect.height / 2 + dy;
        let nearest = -1, distance = Infinity;
        slots().forEach((slot, index) => {
            const rect = slot.getBoundingClientRect();
            const delta = Math.hypot(centerX - rect.left - rect.width / 2, centerY - rect.top - rect.height / 2);
            if (delta < distance) { nearest = index; distance = delta; }
        });
        move(current.id, nearest);
        current.frame = requestAnimationFrame(tick);
    };
    const start = (id: string, event: PointerEvent<HTMLElement>) => {
        if (!orderRef.current || drag.current || !gridRef.current) return;
        const card = event.currentTarget;
        const rect = card.parentElement!.getBoundingClientRect();
        const overlay = card.cloneNode(true) as HTMLElement;
        overlay.removeAttribute("data-folder-id");
        overlay.removeAttribute("role");
        overlay.removeAttribute("tabindex");
        overlay.setAttribute("aria-hidden", "true");
        overlay.dataset.folderDragOverlay = id;
        Object.assign(overlay.style, {
            position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
            margin: "0", zIndex: "1000", pointerEvents: "none", opacity: "1", willChange: "transform",
            boxShadow: "0 12px 32px rgba(0,0,0,.14)", transition: "none",
        });
        document.body.appendChild(overlay);
        gridRef.current.setPointerCapture(event.pointerId);
        event.preventDefault();
        drag.current = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, rect, overlay, frame: 0, dropping: false };
        setDragId(id);
        tick();
    };
    const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId || current.dropping) return;
        current.x = event.clientX; current.y = event.clientY;
        event.preventDefault();
        cancelAnimationFrame(current.frame);
        tick();
    };
    const drop = (event: PointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId || current.dropping) return;
        current.dropping = true;
        cancelAnimationFrame(current.frame);
        if (gridRef.current?.hasPointerCapture(current.pointerId)) gridRef.current.releasePointerCapture(current.pointerId);
        const target = slots().find(slot => slot.dataset.folderSlot === current.id)?.getBoundingClientRect();
        const finish = () => {
            if (drag.current !== current) return;
            current.overlay.remove(); drag.current = null; setDragId(null);
        };
        if (!target || reduced.current) { finish(); return; }
        const animation = current.overlay.animate([
            { transform: current.overlay.style.transform },
            { transform: `translate3d(${target.left - current.rect.left}px, ${target.top - current.rect.top}px, 0) scale(1)`, boxShadow: "0 0 0 rgba(0,0,0,0)" },
        ], { duration: DURATION, easing: EASING, fill: "forwards" });
        animation.onfinish = finish;
        animation.oncancel = finish;
    };
    return {
        gridRef, dragId, start,
        gridEvents: { onPointerMove: pointerMove, onPointerUp: drop, onPointerCancel: drop, onLostPointerCapture: drop },
        keyboardMove: (id: string, offset: number) => {
            if (!drag.current && orderRef.current) move(id, orderRef.current.indexOf(id) + offset);
        },
    };
}
