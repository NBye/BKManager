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
5. 打开插件设置，配置 ES 地址、授权 Key 和索引前缀。

实际索引名为：

```text
索引前缀 + bookmarks
```

例如 `bm_company_` 对应 `bm_company_bookmarks`。

授权 Key 不需要集群级别的 `monitor` 权限。已存在的索引至少需要目标索引的读取和写入权限；如果希望插件自动创建索引，还需要 `create_index` 权限。

## 当前功能

- IndexedDB 本地全量存储和离线读写。
- Elasticsearch 全量同步和按 `updatedAt` 合并。
- 多级目录和收藏拖拽移动、混合排序。
- 网页右键收藏和链接右键收藏。
- 管理页编辑、级联删除、导入和导出。
- JSON 全量覆盖恢复和 URL 冲突合并。
