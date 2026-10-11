"use client";

import { useId } from "react";
import styles from "./avatar-library.module.css";

// Draw each ticket at its own proportions so the scalloped edges stay round.
const edge = Array.from({ length: 6 }, (_, i) => 35 + i * 28);
const outline = `M18 8 H202 Q202 18 212 18 ${edge.map(y => `V${y} C204 ${y} 204 ${y + 12} 212 ${y + 12}`).join(" ")} V212 Q202 212 202 222 H18 Q18 212 8 212 ${[...edge].reverse().map(y => `V${y + 12} C16 ${y + 12} 16 ${y} 8 ${y}`).join(" ")} V18 Q18 18 18 8 Z`;

export function AvatarTicket({ url }: { url?: string }) {
    const clip = `avatar-ticket-${useId().replace(/:/g, "")}`;
    return <span className={styles.ticketStack} aria-hidden="true">
        {[0, 1, 2].map(layer => <svg key={layer} className={styles.ticketSheet} data-layer={layer} viewBox="0 0 220 230" fill="none">
            <g transform={layer === 2 ? undefined : "translate(13.2 0) scale(.88 1)"}>
            <path d={outline} fill="white" stroke={layer === 2 ? "#bfc0c2" : "#d7d7d8"} strokeWidth=".8" />
            <path d="M38 25 H99 M121 25 H182 M38 205 H99 M121 205 H182" stroke="#b2b3b5" strokeWidth=".8" strokeDasharray="3 3" />
            <path d="M110 20 Q111 24 115 25 Q111 26 110 30 Q109 26 105 25 Q109 24 110 20Z M110 200 Q111 204 115 205 Q111 206 110 210 Q109 206 105 205 Q109 204 110 200Z" fill="#a6a7aa" />
            </g>
            {layer === 2 && <>
                <defs><clipPath id={clip}><rect x="38" y="38" width="144" height="144" rx="2" /></clipPath></defs>
                <rect x="38" y="38" width="144" height="144" rx="2" fill="#f7f7f7" />
                {/* Counter-rotate only the photo; its square clipping frame follows the ticket. */}
                <g clipPath={`url(#${clip})`}>
                    {url ? <image href={url} x="29" y="29" width="162" height="162" transform="rotate(5 110 115)" preserveAspectRatio="xMidYMid slice" /> : <text x="110" y="114" transform="rotate(5 110 115)" textAnchor="middle" fill="#aaa" fontSize="10">空文件夹</text>}
                </g>
                <rect x="38" y="38" width="144" height="144" rx="2" stroke="#c9cacc" strokeWidth=".65" />
            </>}
        </svg>)}
    </span>;
}
