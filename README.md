# ES Bookmark Manager Chrome Extension

离线优先的 Elasticsearch 浏览器收藏插件第一版。

项目 Logo：`public/logo.svg`。

## 开发构建

```bash
npm install
npm run build
```

构建产物位于 `dist/`。

## 加载到 Chrome

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择项目下的 `dist` 目录。
5. 打开插件设置，配置 ES 地址、授权 Key 和索引前缀；也可以在收藏夹首页选择“离线使用”，暂时不配置 ES。

实际索引名为：

```text
索引前缀 + bookmarks
```

例如 `bm_company_` 对应 `bm_company_bookmarks`。

授权 Key 不需要集群级别的 `monitor` 权限。已存在的索引至少需要目标索引的读取和写入权限；如果希望插件自动创建索引，还需要 `create_index` 权限。

## 当前功能

- IndexedDB 本地全量存储和离线读写。
- 未配置 Elasticsearch 时可直接进入离线模式，先在本地管理收藏。
- 已配置但网络或 Elasticsearch 暂不可用时，新增和修改会保存在本地队列，联网后自动重试同步。
- 离线模式下创建的数据，在首次成功配置 Elasticsearch 后会自动迁移并同步。
- Elasticsearch 全量同步和按 `updatedAt` 合并。
- 多级目录、链接和文案拖拽移动、混合排序。
- 网页、链接右键收藏，以及选中文案后右键“加入BKM收藏”。
- 文案收藏点击即可复制，支持离线保存和 ES 同步。
- 管理页编辑、级联删除、导入和导出。
- JSON 全量覆盖恢复和 URL 冲突合并。
