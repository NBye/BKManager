# ES Bookmark Manager 项目说明

> 文档基于 2026-08-26 工作区源码整理，面向开发、维护和部署交接。

## 1. 项目概览

ES Bookmark Manager 是一个 Chrome Manifest V3 浏览器扩展，用于管理网页收藏、文案收藏、文件夹层级和 Elasticsearch（下称 ES）同步。

项目采用“本地优先”模式：收藏和目录修改先写入浏览器本地 IndexedDB，即使 ES 暂时不可用也可以继续操作；后台再通过延迟同步将本地数据与 ES 合并。首次使用即使没有配置 ES，也可以从首页进入离线模式；后续成功配置 ES 时，离线 Profile 会迁移到目标 ES Profile。ES 作为跨浏览器、跨设备共享的数据源，本地数据库则承担离线缓存和待同步队列的职责。

当前版本为 `0.1.0`，前端使用原生 TypeScript、HTML 和 CSS，没有引入 UI 框架或状态管理库。

## 2. 技术栈与运行形态

- Chrome Extension Manifest V3。
- TypeScript 5.6，严格类型检查，目标为 ES2022。
- Vite 6，多入口构建。
- 原生 DOM API 负责页面渲染和交互。
- Chrome `storage.local` 保存连接配置。
- IndexedDB 保存节点、同步操作和同步元数据。
- `fetch` 调用 ES REST API，使用 API Key 鉴权。

扩展包含三个主要可见页面、一个设置兼容入口和一个后台 Service Worker：

| 页面 | 入口 | 作用 |
| --- | --- | --- |
| 弹出窗口 | `src/popup.html` / `src/popup.ts` | 快速查看、搜索、添加和操作收藏 |
| 收藏管理与设置工作台 | `src/manager.html` / `src/manager.ts` | 左侧导航切换收藏管理和连接设置，支持拖拽排序、导入导出和配置保存 |
| 设置兼容入口 | `src/options.html` | Chrome 设置入口跳转到工作台的连接设置视图 |
| 收藏捕获窗口 | `src/capture.html` / `src/capture.ts` | 从右键菜单打开，确认网页标题、URL 和图标 |
| 后台服务 | `src/background.ts` | 创建右键菜单、打开页面、转发同步调度消息 |

## 3. 目录结构

```text
.
├─ public/
│  ├─ manifest.json          Chrome 扩展清单
│  ├─ logo.svg               项目 Logo
│  └─ icon*.png              扩展图标
├─ src/
│  ├─ app.ts                 业务用例：创建、修改、删除、移动、加载
│  ├─ background.ts          Service Worker 和右键菜单
│  ├─ capture.*              右键收藏确认页
│  ├─ config.ts              Chrome 配置读写和规范化
│  ├─ db.ts                  IndexedDB 封装
│  ├─ es.ts                  ES 请求、索引初始化、批量读写
│  ├─ manager.*              收藏管理页
│  ├─ nodes.ts               节点清洗、去重和层级合法性检查
│  ├─ options.*              设置兼容入口
│  ├─ popup.*                扩展弹出窗口
│  ├─ sync.ts                本地队列和 ES 同步
│  ├─ tree.ts                通用树形渲染、折叠和拖拽
│  ├─ types.ts               领域类型和通用工具函数
│  ├─ ui.ts                  模态框、确认框和收藏编辑框
│  └─ styles.css             所有页面共享样式
├─ scripts/
│  └─ generate-icons.ps1     使用 System.Drawing 生成 PNG 图标
├─ docs/
│  ├─ project-overview.md    本文档
│  └─ todo.md                当前产品待办
├─ vite.config.ts            多入口构建配置
├─ tsconfig.json             TypeScript 配置
└─ package.json              npm 脚本和依赖
```

## 4. 领域数据模型

### 4.1 BookmarkNode

链接收藏、文案收藏和文件夹统一存储为节点，区别由 `nodeType` 表示。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | `crypto.randomUUID()` 生成的节点 ID，也是 ES 文档 `_id` |
| `nodeType` | `folder` / `bookmark` / `text` | 文件夹、链接收藏或文案收藏 |
| `parentId` | `string` / `null` | 父文件夹 ID；`null` 表示根目录 |
| `name` | `string` | 文件夹名称 |
| `url` | `string` | 收藏地址，仅允许 HTTP 或 HTTPS |
| `title` | `string` | 收藏显示标题 |
| `iconUrl` | `string` | 网站图标地址，可选 |
| `content` | `string` | 文案收藏的完整原文；标题自动取前 20 个字符 |
| `urlKey` | `string` | URL 去除首尾空格后的去重键 |
| `sortOrder` | `number` | 同一父目录下的混合排序值 |
| `createdAt` | `number` | 创建时间，Unix 毫秒时间戳 |
| `updatedAt` | `number` | 最后更新时间，Unix 毫秒时间戳 |
| `deletedAt` | `number` / `null` | 软删除时间；显示数据会过滤已删除节点 |

同一目录下文件夹、链接和文案共用 `sortOrder` 序列。新节点通常使用当前兄弟最大值加 `1000`；拖拽排序时会重新按 `1000、2000、3000...` 编排。

URL 规范化目前只做 `trim()`，不会进行大小写、默认端口、尾斜杠或查询参数的语义归一化。因此，只有规范化后完全相同的 URL 才会被判定为重复。

### 4.2 连接配置和 Profile

配置存储在 Chrome `storage.local` 的 `connectionConfig` 键中：

```ts
{
  esUrl: string,
  apiKey: string,
  indexPrefix: string
}
```

保存时会去除 ES 地址末尾斜杠、API Key 和索引前缀的首尾空格。实际索引名由 `indexPrefix + "bookmarks"` 组成；如果前缀本身已经以 `bookmarks` 结尾，则不会重复追加。

本地数据按 Profile 隔离，Profile Key 为：

```text
trim(esUrl) + "|" + actualIndexName
```

切换 ES 地址或索引前缀不会直接覆盖另一套本地数据，而是切换到新的 Profile。

## 5. 本地存储设计

IndexedDB 数据库名称为 `bookmark-manager-local`，版本为 `1`，包含三个 Object Store：

| Store | Key Path | 用途 |
| --- | --- | --- |
| `nodes` | `[profileKey, id]` | 保存节点；Profile 之间隔离 |
| `operations` | `id` | 保存每个节点最后一次待同步操作 |
| `meta` | `profileKey` | 保存同步状态、最后同步时间和错误信息 |

未配置 ES 的收藏保存在固定的 `offline-local` Profile 中。已配置 ES 但请求失败时，仍使用对应 ES Profile 的本地节点和同步操作队列，不会因为网络错误阻止新增、修改、移动或删除。

`nodes` 有 `profileKey` 索引；`operations` 有 `profileKey` 和 `[profileKey, queuedAt]` 索引，用于按 Profile 和排队时间读取操作。

每次本地修改都会：

1. 立即写入节点。
2. 按节点 ID 创建或覆盖一条同步操作。
3. 更新 `localDataUpdatedAt`，并把状态设为 `offline`。
4. 请求后台 Service Worker 安排同步。

同一个节点的多次连续修改会复用原操作 ID 和最初的 `queuedAt`，操作内容更新为最新节点状态，避免队列无限增长。

## 6. 同步机制

### 6.1 同步流程

同步入口有三类：管理页“同步”按钮、设置保存后的同步、以及本地写入后自动调度。

自动同步按 Profile 防抖 1 秒。弹出窗口或管理页写入后，通过 `chrome.runtime.sendMessage({ type: "schedule-sync" })` 通知后台；如果消息发送失败，则在当前页面直接调度。同步失败时队列保留，后台每分钟检查待同步队列；页面检测到恢复联网时也会立即触发一次同步。

一次 `syncProfile` 的主要步骤如下：

1. 检查目标索引是否存在，不存在时尝试创建并写入映射。
2. 读取本地节点和同步队列快照。
3. 使用 ES `match_all` 分页读取远端全部节点，每页 500 条。
4. 按节点 ID 合并本地与远端数据，冲突时保留 `updatedAt` 较新的版本。
5. 经过 `sanitizeNodes` 清洗：去重、过滤软删除节点、过滤无效 URL、过滤失效父级和循环层级。
6. 通过 ES `_bulk` 批量 upsert 合并后的节点。
7. 只对本地或远端明确带 `deletedAt` 且没有更新版本的一方执行远端删除；清洗过程中被过滤的异常节点不会直接物理删除。写入先于删除，避免写入失败时先丢失服务器数据。
8. 再次读取同步队列，写回合并结果，并只清理本轮开始时内容未变化且已完成的操作。
9. 更新 `lastSyncAt`、`localDataUpdatedAt` 和 `syncStatus`。

没有 ES 配置时不会执行远程请求，所有操作只写入 `offline-local` Profile。首次配置并成功测试 ES 后，离线节点会先复制到目标 Profile，再按正常合并规则同步；迁移失败时原离线 Profile 保留，不会因为配置失败而清除。

同步失败时不会清理队列。当前实现按单设备顺序使用，不处理多个设备同时写入的并发冲突；在此前提下，本地未上传修改会优先进入合并结果，远端异常数据也不会因为一次清洗被直接删除。

### 6.2 ES API 使用

假设实际索引名为 `bm_company_bookmarks`，请求形态如下：

| 用途 | 方法 | 地址 |
| --- | --- | --- |
| 检查索引 | `HEAD` | `/{index}` |
| 创建索引和映射 | `PUT` | `/{index}` |
| 分页读取 | `POST` | `/{index}/_search` |
| 批量写入或删除 | `POST` | `/_bulk` |

搜索使用 `updatedAt asc`、`id asc` 排序，并通过 `search_after` 分页。批量写入采用 `index` action，以节点 ID 作为 `_id`；删除采用 `delete` action。

当前同步算法最终以合并结果为准批量写入和删除，队列里的 `action` 字段主要用于记录本地变更语义和防止并发覆盖，并没有单独执行 create/update/delete 三种不同的远程分支。

### 6.3 状态和错误

同步元数据支持 `idle`、`syncing`、`offline`、`error` 四种状态。请求失败时会保留本地数据和同步操作，并将错误文本写入 `lastError`；下一次手动或自动同步可以继续尝试。

## 7. 页面功能与交互

### 7.1 弹出窗口

- 未配置时直接显示内嵌 ES 配置表单，可测试连接并保存连接；配置支持表单模式和 JSON 模式，JSON 模式要求包含 `esUrl`、`apiKey` 和 `indexPrefix` 三个字符串字段。
- 已配置时显示树形收藏列表。
- “收藏当前地址”读取当前活动标签页的 URL、标题和 favicon。
- “创建子文件夹”在当前选中文件夹下创建目录；未选中时创建根目录。
- 搜索会匹配文件夹名称、收藏标题、URL 和文案全文，并自动保留匹配节点的祖先目录，保证结果仍可在树中定位。
- 点击链接收藏打开新标签页；点击文案收藏复制完整原文；点击文件夹可选中它。
- 右键节点可编辑或级联删除。
- 每次打开收藏夹浮窗时，在线会自动同步一次；同步失败时继续显示本地数据并提示错误。
- 拖拽节点支持放到目标节点之前、之后或文件夹内部。
- 文件夹折叠状态同时保存在内存和 `localStorage`，按页面路径及容器 ID 区分。
- 支持树状和平铺两种布局；平铺模式按当前文件夹显示卡片，双击文件夹进入，顶部显示路径并支持返回上级。

### 7.2 收藏管理与设置工作台

工作台最大宽度为 1200px，左侧导航宽度为 320px，内容区最大宽度为 900px。管理视图复用通用树渲染器，并额外提供：

- 根目录创建。
- 节点编辑、删除和子目录创建。
- 收藏创建日期显示。
- 手动同步。
- 本地 Profile 数据导出为 JSON。
- JSON 备份导入，支持全量覆盖和按 URL/文件夹的合并模式。

连接设置视图提供表单模式和 JSON 模式。JSON 模式要求包含 `esUrl`、`apiKey` 和 `indexPrefix` 三个字符串字段，适合复制粘贴完整配置；保存前两种模式都会先测试 ES 连接并同步目标 Profile。

删除文件夹时会递归计算整个子树，将所有节点写成带 `deletedAt` 的删除操作。

导出文件格式为：

```json
{
  "format": "bookmark-manager-backup",
  "version": 1,
  "exportedAt": "ISO-8601 时间",
  "nodes": ["BookmarkNode 数组"]
}
```

导出只包含当前 Profile 的非删除节点。导入前会检查文件标识、版本和备份内重复 URL；全量覆盖模式先为现有节点创建删除操作，再写入备份节点。合并模式以收藏 URL 作为收藏冲突键，以文件夹 ID 作为文件夹冲突键。

### 7.3 右键收藏

后台创建“收藏到书签”“收藏链接到书签”和“加入BKM收藏”三个菜单项：

- 页面菜单使用当前标签页 URL、标题和 favicon。
- 链接菜单使用右键链接 URL。
- 选中文案菜单将原文作为 `text` 节点直接保存到根目录，标题取前 20 个字符。
- 非 HTTP/HTTPS 地址会被忽略。
- 菜单打开一个独立的 `capture.html` 弹窗确认信息。
- 如果 URL 已存在，会提示是否移动到根目录并更新标题和图标。

后台还提供打开收藏管理、打开插件设置和打开带 `sync=1` 参数的管理页同步菜单；插件设置菜单最终进入统一工作台的连接设置视图。

## 8. 扩展权限与部署要求

`public/manifest.json` 声明了以下权限：

- `storage`：保存连接配置。
- `contextMenus`：注册右键菜单。
- `activeTab`：读取当前活动标签页信息。
- `alarms`：定期重试失败的同步队列。
- `clipboardWrite`：点击文案收藏时写入系统剪贴板。
- `http://*/*`、`https://*/*`：访问网页和配置的 ES HTTP/HTTPS 地址。

ES 端要求：

- API Key 至少具备目标索引的读取和写入权限。
- 如果允许插件自动创建索引，还需要 `create_index` 权限。
- 目标 ES 必须允许来自扩展的请求，并能正常处理 `HEAD`、`_search` 和 `_bulk` 请求。
- API Key 会保存在浏览器本地，并以 `Authorization: ApiKey <key>` 请求头发送；不要把 API Key 写入源码或提交到仓库。

## 9. 开发、构建与加载

安装依赖：

```bash
npm install
```

生产构建：

```bash
npm run build
```

Vite 会将多入口页面和脚本输出到 `dist/`，包含：

- `dist/background.js`
- `dist/popup.js`
- `dist/manager.js`
- `dist/options.js`
- `dist/capture.js`
- `dist/src/*.html`
- `dist/assets/*`

加载到 Chrome：

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 选择项目根目录下的 `dist/`。
5. 打开扩展设置，填写 ES 地址、API Key 和索引前缀。

开发脚本中还提供 `npm run dev`，但扩展实际验证应以生产构建后的 `dist/` 目录为准。

## 10. 当前限制与待办

当前仓库没有单元测试、集成测试或 lint 脚本，现阶段主要依赖 TypeScript 构建和手工验证。已执行的 `npm run build` 可以成功完成。

`docs/todo.md` 中记录的产品待办包括：

1. 已完成弹出窗口标题栏固定、滚动条显示策略和滚动条样式优化。
2. 已完成弹出窗口树状/平铺布局、双击进入文件夹、路径显示和返回。
3. 已完成设置页和收藏管理页整合为统一工作台。
4. 已完成设置表单/JSON 双模式。
5. 已完成宫格模式当前路径创建、拖拽排序和节点移动，并禁止选择弹窗文案。
6. 已完成网页选中文案右键收藏，新增 text 节点并支持同步、拖拽排序、编辑和点击复制。

维护时还应关注以下实现边界：

- 导入备份目前主要校验文件格式和 URL 重复，未对每个节点的全部字段、父级引用和层级结构做完整 schema 校验。
- URL 去重是字符串级别，不是完整 URL 规范化。
- 同步是全量读取和批量写入，数据规模很大时会增加 ES 和浏览器端开销。
- 删除节点通过同步时的远端删除实现，ES 中不会长期保留删除历史。
- 配置变更按 ES 地址和索引名切换 Profile；切换后如果新 Profile 没有本地缓存，会从对应 ES 索引初始化。

## 11. 关键文件速查

| 需求 | 首先查看 |
| --- | --- |
| 修改收藏或文件夹业务规则 | `src/app.ts` |
| 修改 ES 请求或索引映射 | `src/es.ts` |
| 修改同步和冲突处理 | `src/sync.ts` |
| 修改本地数据结构 | `src/db.ts`、`src/types.ts` |
| 修改数据清洗和重复规则 | `src/nodes.ts` |
| 修改树形显示、折叠、拖拽 | `src/tree.ts` |
| 修改弹出窗口行为 | `src/popup.ts`、`src/popup.html` |
| 修改管理页行为 | `src/manager.ts`、`src/manager.html` |
| 修改右键收藏流程 | `src/background.ts`、`src/capture.ts` |
| 修改连接设置 | `src/options.ts`、`src/config.ts` |
| 修改通用弹窗 | `src/ui.ts` |
| 修改扩展权限和入口 | `public/manifest.json` |
| 修改构建入口和输出 | `vite.config.ts` |
