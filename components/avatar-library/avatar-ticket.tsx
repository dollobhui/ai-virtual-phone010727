"use client";

import styles from "./avatar-library.module.css";

const TICKET_FRAME_URL = "https://cdn.jsdelivr.net/gh/dollobhui/phone-assets@main/frames/ticket-frame.png";

export function AvatarTicket({ url }: { url?: string }) {
    return <span className={styles.ticketStack} aria-hidden="true">
        <span className={styles.ticketArt}>
            {/* Measured against the original 2000 × 2000 PNG. The photo stays upright;
                the slightly oversized window mask sits beneath its opaque paper rim. */}
            <span className={styles.ticketWindow}>
                {url ? <img className={styles.ticketPhoto} src={url} alt="" /> : <span className={styles.ticketEmpty}>空文件夹</span>}
            </span>
            <img className={styles.ticketFrame} src={TICKET_FRAME_URL} alt="" draggable={false} />
        </span>
    </span>;
}
