# 飞书适配实现说明

本项目基于 [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper) 1.7.1，基线提交 `6d56d618b00bd970aa738d6a7a61edee27783e81`。来源、安装和许可证说明见 [README.md](README.md)。

## 提取流程

飞书长文档按视口渲染，网页 DOM 不等于整篇文档。适配器在当前页面主环境中读取已加载的文档模型，仅复制根节点可达的记录和可达引用源。它不读取 Cookie 或账号凭据，不调用其他文档接口，也不新增上传请求。

块树按原始顺序转换为 HTML，再复用上游 Markdown 转换。剪藏弹窗、复制、下载和阅读模式使用统一异步入口。普通网页仍走 Defuddle；已生成的阅读模式正文优先复用，不重新依赖被清理的飞书编辑器。

## 完整度处理

- 普通正文块缺失、页面来源改变或模型无法读取时，明确失败，不退回首屏抓取。
- 图片没有可用 HTTPS 地址时，保留原文位置并提示；取得地址不等于离线下载成功。
- 同步引用优先使用模型中可达的来源记录；来源不可用时，保留当前可见内容或原文链接并提示。
- 未知类型、无法识别的文字结构以及深度或循环问题均报告警告。
- 有选中文字时，仍保留上游保存选区的行为。

页面变量包含 `feishuBlockCount`、`feishuWarnings`、`feishuComplete`。存在任何已知提取警告时，`feishuComplete` 为 `false`；这个标记只描述适配器检测到的结构问题，不保证远程图片或附件可以离线访问。

## 代码位置

| 文件 | 职责 |
| --- | --- |
| `src/utils/feishu-page-snapshot.ts` | URL 边界、页面模型读取、可达记录快照、已渲染图片与引用回退 |
| `src/utils/feishu-renderer.ts` | 块树、富文本、列表、图片和引用转换，完整度报告 |
| `src/utils/feishu-extractor.ts` | 扩展消息、超时、提取结果与面向用户的提示 |
| `src/background.ts` | 来源校验和主页面脚本桥接 |
| `src/utils/clip-utils.ts` | 共用异步提取入口 |
| `src/content.ts`、`src/utils/content-extractor.ts`、`src/utils/reader.ts` | 剪藏与阅读模式集成、错误传播 |

## 验证与已知边界

Chrome 真实长文档会话已验证：模型提取覆盖离屏正文，剪藏预览显示缺失图片和同步引用提示。未完成写入 Obsidian 的端到端验收，也未验证真实 Lark、Firefox 或 Safari 会话。飞书页面内部模型不是稳定公开接口，后续站点更新可能需要调整。

合成测试覆盖可达记录与无关记录隔离、序列化脚本独立运行、缺块、循环、富文本链接和内嵌文档标题、HTML 转义、危险 URL、超时以及共用入口。真实页面快照和文章正文仅用于本地诊断，不纳入仓库。

```sh
npm ci
npm run build:chrome
npx tsc --noEmit --module es2020
TZ=America/Los_Angeles npm test
```

上游日期测试使用固定时区预期，因此回归测试指定 `America/Los_Angeles`。它不影响日常使用时的本地时区设置。
