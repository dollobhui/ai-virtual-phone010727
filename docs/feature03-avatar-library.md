# 功能03：URL 头像库开发报告

基于仓库 `dollobhui/ai-virtual-phone010727` 的 `feature/phone-upgrades`，开发基线为 `ee23d1123e2633a0fae3db1afc92e4ce2ae09ca4`。开始开发及收尾时，均通过 GitHub 比较确认远端分支与该基线一致。

实现保留在本地目标分支，提供可应用补丁。未推送远端、未合并 main、未创建部署。

## 1. 功能与修改文件

入口：手机桌面 → 资源库 → 头像库。

- 单独头像、情侣头像两个分类；各自支持自定义文件夹。
- 文件夹新建、重命名、删除；删除文件夹会将其中图片（含回收站记录）移回未分类。
- 单 URL 和逐行批量 URL 导入，支持 `描述：URL`、`描述: URL`。整批校验失败时不写入。
- 图片描述编辑、分类/文件夹移动、删除、回收站恢复。
- 导出 JSON（包含回收站），完整校验后合并导入。相同分类内按规范化 URL 去重，包含回收站中的 URL；不同分类允许同一 URL。
- 文件夹按分类与名称匹配；外部 ID 冲突时生成新 ID、同步映射引用；不覆盖原有图片、描述和文件夹。
- 分享给现有聊天联系人，进入原私聊并发送现有图片消息；用户通过聊天室原有回复按钮触发角色回复。
- 角色接受后更新头像、刷新列表和历史气泡，并记录灰色系统提示；拒绝保留原头像。

| 文件 | 用途 |
| --- | --- |
| `components/avatar-library/avatar-library-page.tsx` | 头像库管理界面、JSON 导入导出、角色选择 |
| `components/phone-resources-app.tsx` | 资源库入口 |
| `components/desktop-shell.tsx` | 支持资源库头像页导航 |
| `lib/avatar-library.ts` | 数据结构、URL/JSON 校验、去重合并、管理操作 |
| `lib/avatar-library-storage.ts` | 复用 IndexedDB KV 的持久化读改写 |
| `lib/avatar-library-share.ts` | 复用原聊天存储和会话导航发送推荐图片 |
| `lib/chat-avatar-intent.ts` | 推荐图片关联、回复决定、控制标记保护与清理 |
| `lib/chat-storage.ts` | 图片推荐元数据、回复关联、接受/拒绝落库和系统提示 |
| `lib/character-storage.ts` | 单个角色头像更新；避免延迟规范化覆盖新头像 |
| `lib/chat-engine.ts` | 推荐提示词、普通/流式/原生工具响应的正则标记保护 |
| `lib/llm-prompt-assembler.ts` | 历史图片保留描述和推荐状态 |
| `lib/rich-message-parser.ts` | 隐藏控制标记，保留角色正文 |
| `lib/stream-preview.ts` | 隐藏完整及未闭合的头像控制标记 |
| `components/chat/chat-room.tsx` | 最新头像刷新、生成时推荐 ID 快照、仅标记回复处理 |
| `components/chat/chat-message-list.tsx` | 聊天列表头像刷新 |
| `components/chat/chat-contacts-list.tsx` | 联系人头像刷新 |
| `lib/data-management/modules.ts` | 将头像库登记到原整机备份数据模块 |
| `package.json` | 新增测试命令；无新增依赖 |
| `scripts/test-avatar-library.cjs` | 存储/合并/聊天安全性与持久化自动化测试 |
| `scripts/test-avatar-library-ui.cjs` | 浏览器完整流程验证 |
| `scripts/fixtures/avatar-library-page.tsx` | 测试时挂载原资源库和聊天界面；临时路由测试后移除 |
| `docs/feature03-avatar-library.md` | 本开发报告 |

## 2. 数据结构变化

复用 `AiPhoneKvDB.entries`，新增键 `ai_phone_avatar_library_v1`。不新增图片数据库或图片文件，角色头像仍为原来的 `string | null`。

```json
{
  "schema": "ai_phone_avatar_library",
  "version": 1,
  "categories": ["single", "couple"],
  "folders": [
    { "id": "folder-id", "name": "收藏", "category": "single" }
  ],
  "images": [
    {
      "id": "image-id",
      "url": "https://example.com/a.png",
      "description": "黑色西装头像",
      "category": "single",
      "folderId": "folder-id"
    }
  ]
}
```

删除图片时添加 ISO 时间字段 `deletedAt`；恢复时移除。未分类使用 `folderId: null`。仅接受 HTTP/HTTPS URL，拒绝 data、blob、file、javascript 等协议以及带用户名/密码的 URL。

原 `ChatMessage.mediaData` 新增可选字段：

```ts
avatarLibraryImageId?: string;
avatarRecommendationForCharacterId?: string;
avatarRecommendationStatus?: "pending" | "accepted" | "declined";
```

原 `ChatMessage` 新增可选字段 `avatarRecommendationReplyToId?: string | null`，用于记录生成回复时的推荐图片消息 ID；`null` 表示该轮没有推荐。没有迁移要求，历史消息继续兼容。

管理操作使用现有 `kvUpdateCommitted` 事务，读取持久化最新值后写入，提交成功才更新缓存。损坏数据、读取失败和写入失败不会被当作空库覆盖。

## 3. 复用 momo 的逻辑

参考并读取 [momo 的 chat-avatar-intent.ts](https://github.com/jianchu-in/momo.float.phone/blob/main/lib/chat-avatar-intent.ts)，对照其 `chat-storage.ts`、`character-storage.ts`、聊天引擎和富消息解析流程：

- 复用 `findUserAvatarChangeIntent` 的当前用户轮次/回复批次关联思路，以及 12 条、30 分钟安全边界。
- 复用 `applyWithProtectedAvatarDecisionMarkers` 的占位保护，避免用户正则删除接受/拒绝标记。
- 复用接受/拒绝控制标记和 `inferAvatarDecisionFromReply` 的自然回复兜底，拒绝优先。
- 复用回复落库时决定推荐状态、更新对应 `character.avatar` 的流程。
- 继续使用目标仓库的 `pushChatMessage`、`createOrGetSession`、`saveCharacters` 与聊天导航；没有创建聊天系统。

安全收敛：只有头像库显式标记的图片参与换头像判断；不迁移普通图片凭自然语言自动配图的宽松路径。控制标记增加图片消息 ID；前台生成另存请求时的推荐 ID，旧回复不能处理后来发送的推荐。验证会话、角色、目标图片、未处理状态、时效、撤回状态；排除群聊和工具载体。自然回复只有明确头像采用动作才接受，询问、条件句和泛泛称赞不会接受。

## 4. 测试结果

| 验证 | 结果 |
| --- | --- |
| `npm run test:avatar-library` | 20 项 Node 测试通过 |
| `npm run test:avatar-library:ui` | 11 个浏览器场景通过，无运行时异常 |
| 原配置文件夹与模型选择测试 | 35 项回归测试通过 |
| TypeScript 源码检查 | 通过，隔离测试临时路由的生成类型目录 |
| `git diff --check` | 通过 |
| Next 生产构建 | 编译成功、71 个页面生成成功；隔离输出目录的 CSS 后处理通过 |

浏览器场景覆盖：URL/批量添加、文件夹新建/重命名/移动/删除、描述编辑、回收站恢复、JSON 导入导出与重复/非法导入、刷新保留、分享到原聊天室、角色接受及历史头像/列表刷新、角色拒绝、普通图片不触发、流式接受、仅控制标记回复。

补充自动化覆盖：JSON ID 冲突和文件夹引用映射、跨标签页更新、并发操作、读取失败、写入配额失败、损坏数据保护、错误角色/消息 ID、群聊排除、过期推荐、较新普通图片、旧生成回复、拒绝优先与控制标记正则保护。

生产验证使用 `NEXT_DIST_DIR=.next-avatar-build` 保留独立构建结果。原 `npm run build` 的最后一个 CSS 后处理命令默认读取 `.next/static/css`，隔离目录下该命令首次返回路径错误；已通过 `node scripts/restore-backdrop-filter.mjs --dir .next-avatar-build/static/css` 完成对应处理。没有修改部署脚本。构建生成的配置变动已恢复，临时测试路由不在交付代码中。

## 5. 未解决问题与验证边界

未发现本次功能的未解决测试失败。浏览器使用测试图片 URL 与模拟 LLM 响应，未调用真实外部模型服务；模型是否遵循标记及其自然语言风格仍取决于用户配置的模型。

分享对象沿用原聊天联系人：未添加为联系人的角色须先在聊天中添加；不会绕过好友机制。推荐不会强迫角色接受，模糊回复维持未处理状态。

没有新增本地图片上传、图片文件导出、AI 自主搜图、AI 定时换头像或角色专属收藏。原聊天图片功能保留。

应用补丁：在开发基线或包含该基线的目标分支上执行 `git apply --check avatar-library.patch`，确认后执行 `git apply avatar-library.patch`。完整数据仍保存在用户浏览器的现有 IndexedDB 中。
