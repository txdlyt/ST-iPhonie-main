# PixAI 反代（PixAI Bridge）

插件里「引擎 → 图像 → PixAI 反代」这张卡对接的服务。它对外说的是 **NovelAI 的接口**，里面用 Playwright 驱动一个已登录的 PixAI 网页出图。`server.js` 是反代本体，`PixAI_Bridge_逻辑与实现原理说明.txt` 是部署和维护说明。

## 插件这边怎么填
- 引擎 → PixAI 反代 → **反代地址**：写到反代的根为止，如 `https://pixai.example.com`（插件会自己加 `/ai/generate-image`）。
- **令牌**：反代设了 `BRIDGE_TOKEN` 才填，同一个值；没设就留空。
- 绘图 App 里把「用哪个画」切到 PixAI 反代即可；正文出图、朋友圈、查手机等所有出图都走当前选中的引擎。

## 插件发给反代的请求（想自己写脚本适配，读这个就够）
`POST {地址}/ai/generate-image`，JSON：

| 字段 | 内容 |
| --- | --- |
| `input` | 整张图的提示词：画风 + 场景 tag，后面接每个角色的外貌（PixAI 只有一个提示词框），不带 NovelAI 的质量标签 |
| `action` | 固定 `generate`（没有图生图、局部重绘） |
| `parameters.width` / `height` | 绘图 App 里选的尺寸 |
| `parameters.seed` | 种子（没固定就是随机数） |
| `parameters.negative_prompt` | 负面（合并了各角色的负面） |
| `parameters.characters` | `[{prompt, negative}]`，角色分开的版本，脚本想分开用时读它 |
| `parameters.bridge_batch` | `{run, index, size}`：这张图是同一次请求 `size` 张里的第 `index` 张（从 0 数），同一次的 `run` 相同。`size` 为 1 表示这张图自己是一次请求 |

返回：状态 201，`application/zip`，ZIP 里放一张图（取第一个文件）。出错返回非 2xx，正文 JSON 的 `message` 会显示给用户。`GET /health` 给「测试连接」用，不需要令牌。

## 一次出 4 张
绘图 App 选「一次画 4 张」时，插件发 4 个请求，`run` 相同、`index` 0–3、`size` 4。反代只在 PixAI 上画一次（4 张档），再一个请求发一张。单独一张的出图（正文配图、朋友圈等）`size` 为 1，反代开 1 张档的任务（没配置「切换张数」选择器时，网页当前是几张就画几张，多出来的丢掉）。

`server.js` 没有改动，与上传时一致。
