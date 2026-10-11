import { loadAvatarLibrary } from "./avatar-library-storage";
import { loadCharacters } from "./character-storage";
import { hydrateChatStorage, isChatStorageHydrated, loadChatContacts, createOrGetSession, pushChatMessage } from "./chat-storage";

export async function shareLibraryAvatar(imageId: string, characterId: string) {
    const library = await loadAvatarLibrary();
    const image = library.images.find(x => x.id === imageId && !x.deletedAt);
    if (!image) throw new Error("头像已删除，请重新选择");
    await hydrateChatStorage();
    if (!isChatStorageHydrated()) throw new Error("聊天存储读取失败，请重试");
    const character = loadCharacters().find(x => x.id === characterId);
    if (!character || !loadChatContacts().some(x => x.characterId === characterId)) throw new Error("请先在聊天中添加这个角色为联系人");
    const session = createOrGetSession(characterId);
    if (session.isGroup || session.isBlacklisted) throw new Error("无法向这个会话推荐头像");
    const message = pushChatMessage({ sessionId: session.id, role: "user", content: "", mediaType: "image", mediaUrl: image.url,
        mediaData: { label: image.description, avatarLibraryImageId: image.id, avatarRecommendationForCharacterId: character.id, avatarRecommendationStatus: "pending" } });
    window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
    window.dispatchEvent(new CustomEvent("open-app", { detail: { appId: "chat", sessionId: session.id } }));
    return { session, message };
}
