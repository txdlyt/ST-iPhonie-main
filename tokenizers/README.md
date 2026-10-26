# 分词表

NovelAI 提示词 token 计数用（core/tokens.js），用到哪个模型才读哪个文件。

| 文件 | 用于 | 来源 | 授权 |
| --- | --- | --- | --- |
| `t5.json` | V4 / V4.5 | [google-t5/t5-base](https://huggingface.co/google-t5/t5-base) `tokenizer.json` 里的 Unigram 词条和分数（T5 v1.1 共用这套词表） | Apache-2.0 |
| `qwen.txt` | V5 | [Qwen/Qwen3.5-0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B) `merges.txt`，原样 | Apache-2.0 |

两份文件按 Apache License 2.0 再分发，见 `LICENSE-Apache-2.0.txt`。
