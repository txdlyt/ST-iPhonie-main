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
绘图 App 选「一次画 4 张」时，插件发 4 个请求，`run` 相同、`index` 0–3、`size` 4。反代只在 PixAI 上画一次（4 张档），再一个请求发一张。单独一张的出图（正文配图、朋友圈等）`size` 为 1，反代开 1 张档的任务（反代会自己点网页上的「單張 / 多張 (x4)」按钮切过去并确认；只有网页上找不到这组按钮、也没配 `PIXAI_QTY` 时，才是网页当前几张就画几张，多出来的丢掉）。

`server.js` 没有改动，与上传时一致。

## 切换网页张数：POST /ai/settings

绘图 App 里点「1」或「4」时，插件会调用它，把 PixAI 网页上的「一次出几张」切过去，再读回网页的设置（消耗积分会跟着变）。

- 请求体：`{"count": 1}` 或 `{"count": 4}`（只接受 `PIXAI_COUNTS` 里的值，其他返回 400）。带 `BRIDGE_TOKEN` 时同样要 `Authorization: Bearer <密钥>`。
- 成功（200）：和 `GET /ai/status` 一样的内容，`count` 已是新值。
- 反代正在出图：409，`{"ok": false, "message": "反代正在出图，画完再切张数"}`，不动网页。
- 点了但网页没有变过去：502。网页读不到：503。
- 每次出图时反代也会按这一批要几张自己切一次，所以插件没切成功也不会画错张数。

## 重新获取（bridge_batch.recover）

页面刷新或网络中断后，插件拿不到已经画好的图时，会带着原来的 `bridge_batch`（同一个 run、index、size）再请求一次，并加上 `"recover": true`。反代还留着这张图（约 10 分钟内，且没有重启）就直接返回同一张，不重画、不再扣积分；已经没有了就返回 410，不会去重画。不带 `recover` 的请求行为不变。

## 切比例 / 尺寸 / 横竖（/ai/settings）

`POST /ai/settings`，下面几项都可以不带，带哪个切哪个（顺序：张数 → 比例 → 尺寸 → 横竖互换）：

```json
{"count": 4, "ratio": "9:16", "size": "M", "swap": true}
```

- `size` 写档位字母（M、L……），被锁住（要会员）的档位不会点，返回 502。
- `swap` 点网页自带的「切換橫豎」。
- `/ai/status` 的 `resolution.ratios` / `resolution.sizes` 列出页面上现有的比例和尺寸按钮（含是否选中、是否被锁），`canSwap` 表示有没有横竖按钮。
- 酒馆插件选过比例、尺寸或横竖之后，出图前不再按 `PIXAI_RATIO` 切回去；反代重启后清零，回到 `PIXAI_RATIO` 默认。
