"use client";

import { useEffect, useRef } from "react";
import { ContentDialog, type ContentDialogProps } from "@/components/ui/modal";

/** Keep keyboard focus in the active avatar dialog and return it to its opener. */
export function AvatarDialog(props: ContentDialogProps) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const opener = document.activeElement as HTMLElement | null;
        const dialog = ref.current;
        if (!dialog) return;
        dialog.tabIndex = -1;
        const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, textarea, select, [tabindex="0"]')).filter(x => x.offsetParent !== null);
        if (!dialog.contains(document.activeElement)) (controls()[0] || dialog).focus();
        const trap = (event: KeyboardEvent) => {
            if (event.key !== "Tab") return;
            const items = controls();
            if (!items.length) { event.preventDefault(); dialog.focus(); return; }
            const first = items[0], last = items[items.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        };
        dialog.addEventListener("keydown", trap);
        return () => { dialog.removeEventListener("keydown", trap); if (opener?.isConnected) opener.focus(); };
    }, []);
    return <ContentDialog {...props} dialogRef={ref} />;
}
