// Adapted from jianchu-in/momo.float.phone. Only explicitly marked library
// recommendations are eligible: normal image/text conversations never opt in.
import type { ChatMessage } from "./chat-storage";

const DECISION_RE = /[\[【]\s*(接受|拒绝)头像推荐(?:[：:]\s*([^\]】\s]+))?\s*[\]】]/g;

export function stripAvatarDecisionMarkers(text: string): string {
    return text.replace(DECISION_RE, "").trim();
}

export function applyWithProtectedAvatarDecisionMarkers(text: string, transform: (text: string) => string): string {
    const markers: string[] = [];
    const protectedText = text.replace(DECISION_RE, marker => `\uE10Aavatar_decision_${markers.push(marker) - 1}_\uE10B`);
    return transform(protectedText).replace(/\uE10Aavatar_decision_(\d+)_\uE10B/g, (_match, index: string) => markers[Number(index)] || "");
}

export function avatarReplyDecision(text: string): { decision: "accepted" | "declined"; messageId?: string } | null {
    const markers = [...text.matchAll(DECISION_RE)];
    if (!markers.length) return null;
    // Conflicting targets are ambiguous. Rejection always takes precedence.
    if (new Set(markers.map(x => x[2] || "")).size > 1) return null;
    const marker = markers.find(x => x[1] === "拒绝") || markers[0];
    return { decision: marker[1] === "拒绝" ? "declined" : "accepted", messageId: marker[2] };
}

/** Conservative momo fallback: require an avatar-specific, affirmative action. */
export function inferAvatarDecisionFromReply(text: string): "accepted" | "declined" | null {
    const explicit = avatarReplyDecision(text);
    if (explicit) return explicit.decision;
    if ([...text.matchAll(DECISION_RE)].length) return null;
    const normalized = text.replace(/\s+/g, "");
    if (/(?:不换|不想换|不愿换|不想用|不用这张|不要这张|拒绝|暂时不换|以后再换|考虑一下)/.test(normalized)) return "declined";
    if (/[?？]|(?:如果|假如|要不要|也许|可能|打算)/.test(normalized)) return null;
    if (!/(?:头像|头图)/.test(normalized) || /(?:你|用户|我帮你).{0,8}(?:换|用|设)/.test(normalized)) return null;
    if (/(?:我(?:现在|马上|这就|就)?(?:把它|把这张)?(?:换上|换成|设为|设成)|就用这张|已经换|换好了|这张就当我的).{0,12}(?:头像|头图)/.test(normalized)
        || /(?:头像|头图).{0,8}(?:已经换好|换好了|就用这张)/.test(normalized)) return "accepted";
    return null;
}

/** Associate only the newest image in the user turn, bounded to momo's 30 min. */
export function findUserAvatarChangeIntent(history: ChatMessage[], sessionId: string, characterId?: string): { image: ChatMessage; intentText: string } | null {
    const messages = history.filter(x => x.sessionId === sessionId && !x.isRetracted);
    let end = messages.length;
    const last = messages[end - 1];
    if (last?.role === "assistant") {
        // Skip only this response batch, never previous unrelated assistant turns.
        do { end--; } while (end > 0 && last.responseBatchId && messages[end - 1].role === "assistant" && messages[end - 1].responseBatchId === last.responseBatchId);
    }
    for (let i = end - 1; i >= Math.max(0, end - 12); i--) {
        const image = messages[i];
        if (image.role === "assistant") break;
        if (image.role !== "user") continue;
        if (image.mediaType !== "image") continue;
        // A newer normal image supersedes a recommendation rather than pairing it.
        if (!image.mediaUrl || image.mediaData?.avatarRecommendationForCharacterId !== characterId || image.mediaData?.avatarRecommendationStatus !== "pending") return null;
        const age = Date.now() - Date.parse(image.createdAt);
        if (!Number.isFinite(age) || age < -60_000 || age > 30 * 60_000) return null;
        return { image, intentText: "请结合你的人设决定是否把这张图片换成自己的头像" };
    }
    return null;
}
