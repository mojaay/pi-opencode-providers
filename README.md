# pi-opencode-providers

Two OpenCode providers for [pi](https://pi.dev): **OpenCode Zen** and **OpenCode Go**, under
pi's own provider ids `opencode` and `opencode-go`.

pi 的 OpenCode 双 provider 扩展，提供 **OpenCode Zen** 与 **OpenCode Go**，注册在 pi 自有的
provider id `opencode` 与 `opencode-go` 下。

- Login is the console device flow. One approval covers both providers; the access token is
  refreshed automatically, so a session does not have to be re-authenticated.
- The model catalog is the one the OpenCode client reads, `https://models.opencode.ai/experimental/v2.0/api.json`.
  It supplies the base models, each model's protocol and endpoint, limits and prices. The console V2
  config (`/console/api/v2/config`) only overlays workspace changes such as disabled models and route
  or metadata overrides. A model the overlay does not mention stays in the list. Nothing is bundled.
  `OPENCODE_MODELS_URL` points the catalog at a mirror; a mirror without the v2 path answers 404 there,
  and the v1 `/api.json` is then read and converted, as the OpenCode client does.
- `chat` entries become pi chat models. `decision` entries, the Jev models, become pi classifier
  models reachable through `classify()` only. `image` entries are not published, because pi would
  need an image endpoint this extension does not route.
- Reasoning flags and thinking levels come from the same catalog response (`capabilities.reasoning`
  and its `effort` values).
- Because the extension registers pi's own ids, the built-in definitions for those ids are
  replaced instead of duplicated.

- 登录走 console 设备码流程。一次批准覆盖两个 provider，访问令牌自动续期，会话中途无需重新登录。
- 模型目录取自 OpenCode 客户端读的那份，即 `https://models.opencode.ai/experimental/v2.0/api.json`，
  它给出基础模型、每个模型的协议与端点、上下限与价格。console 的 V2 配置（`/console/api/v2/config`）
  只覆盖工作区的改动，例如停用的模型以及路由与元数据的替换。覆盖层没有提到的模型仍留在列表里。
  仓库内不内置任何模型清单。`OPENCODE_MODELS_URL` 可以把目录指向镜像，镜像没有 v2 路径时先收到 404，
  随后读 v1 的 `/api.json` 并做转换，与 OpenCode 客户端的处理一致。
- `chat` 条目发布为 pi 的对话模型。`decision` 条目即 Jev 模型，发布为 pi 的分类模型，只能通过
  `classify()` 调用。`image` 条目不发布，因为需要本扩展没有路由的图像端点。
- 推理标记与思考档位取自同一份目录响应，即 `capabilities.reasoning` 及其 `effort` 取值。
- 扩展注册的是 pi 自有的 id，因此内置的同名定义被替换，而不是并存一份。

## Requirements 环境要求

- pi 1.3.0 or newer (peer of `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`).
- An OpenCode account with access to Zen, Go, or both.

- pi 1.3.0 或更新版本，依赖的 peer 包是 `@earendil-works/pi-ai` 与 `@earendil-works/pi-coding-agent`。
- 一个可访问 Zen 或 Go 的 OpenCode 账号，两者都有亦可。

## Install 安装

```bash
pi install /path/to/pi-opencode-providers
```

Then run `/login` and pick **Sign in with an account** → the provider → approve the device code in
the browser and choose the workspace. Do the same for the other provider: it reuses the credential
just obtained and finishes immediately, without a second approval. No API key entry exists — neither
provider declares one, so the login list never offers one.

随后运行 `/login`，选 **Sign in with an account**，再选 provider，在浏览器里批准设备码并选择工作区。
另一个 provider 同样操作，它复用刚取得的凭据，立即完成登录，不需要第二次批准。登录列表中没有 API
key 一项，两个 provider 都没有声明这种方式，因此 pi 不会给出该选项。

## Commands 命令

```
/opencode [status]     auth source, workspace and model counts
/opencode usage [range]  Go quota, per-model usage and catalog diff (range: 24h|7d|30d)
/opencode switch-org   pick another workspace (session only; re-login to keep it)
/opencode refresh      re-fetch the console catalog now
```

```
/opencode [status]      登录来源、工作区与模型数量
/opencode usage [range]  Go 额度、逐模型用量与目录差异，range 取 24h、7d 或 30d
/opencode switch-org     切换工作区，仅本次会话有效，要保留须重新登录
/opencode refresh        立即重新拉取 console 目录
```

## Settings 设置

Output is English by default. Add a top-level `language` key to the pi settings file to switch:

```json
{ "language": "zh-Hans" }
```

输出默认英文。在 pi 的设置文件顶层加一个 `language` 键即可切换。

| Value 取值 | Result 结果 |
| --- | --- |
| `zh`, `zh-Hans`, `zh-CN`, `zh-SG` | Chinese, Simplified 简体中文 |
| `zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO` | English: no Traditional copy ships 英文，未提供繁体文案 |
| `en`, missing, anything else | English 英文 |

The key is read whenever a command runs, so a change applies without restarting pi for the commands.
Only this extension reads it; pi has no locale layer of its own. Copy is rendered by i18next, which
is also what supplies the singular forms (`1 request` versus `2 requests`); the tables live in
`src/i18n.ts`.

这个键在每次执行命令时读取，改动后不必重启 pi 即对命令输出生效。只有本扩展读它，pi 自身没有语言
设置层。文案由 i18next 渲染，单复数形式也由它给出，例如 `1 request` 与 `2 requests`。文案表位于
`src/i18n.ts`。

## Layout 目录结构

| Path 路径 | Role 职责 |
|---|---|
| `index.ts` | pi entry module, re-exports `src/extension.ts` so the startup summary names the package（入口模块，重新导出 `src/extension.ts`，使启动摘要把包名报出来） |
| `src/console.ts` | Console client, device flow, refresh grant, workspace list, V2 config（console 客户端，负责设备码流程、续期授权、工作区列表与 V2 配置） |
| `src/catalog.ts` | OpenCode's catalog plus the V2 overlay to pi chat and classifier models, with routing, prices, limits and availability（OpenCode 目录与 V2 覆盖合成 pi 对话与分类模型，含路由、价格、上下限与可用性） |
| `src/catalog-source.ts` | OpenCode catalog fetch, capability flags and thinking-level map（OpenCode 目录拉取、能力标记与思考档位映射） |
| `src/request.ts` | Per-provider request wrapping, Go session header and Zen identity headers（逐 provider 包装请求，Go 加会话头，Zen 加身份头） |
| `src/token.ts` | One console token shared by both providers（两个 provider 共用的 console 令牌） |
| `src/monitor.ts` | Go quota, usage and catalog-diff endpoints, cache and formatting（Go 额度、用量与目录差异接口，含缓存与格式化） |
| `src/snapshot.ts` | Persisted Go catalog snapshot and one-time diff notifications（落盘的 Go 目录快照与一次性差异通知） |
| `src/i18n.ts` | English and Simplified Chinese copy via i18next, language resolved from settings（经 i18next 提供中英文案，语言由设置解析） |
| `src/extension.ts` | Provider registration, catalog refresh, commands（provider 注册、目录刷新与命令） |

## Acknowledgements 致谢

This extension follows ideas and implementation approaches from another pi extension. Thanks to `opencode-zen-oauth`, which established the console device-flow login this extension's auth follows.

本扩展的思路与实现方式来自另一个 pi 扩展。感谢 `opencode-zen-oauth`，本扩展的登录方式沿用它所建立的
console 设备码流程。

## License 许可

MIT
