# magpie × ZenMux 订阅插件

为 [magpie](https://usemagpie.ai) 写的 **ZenMux Builder Plan 订阅插件**：用 ZenMux 订阅 API Key
登录，经 ZenMux 的 OpenAI 兼容接口服务模型，并把计划额度（滚动 5 小时 / 7 天的 **Flows**、
月度上限、剩余窗口重置次数）显示在 magpie 的 Provider 卡片、`magpie quota` 和
`GET /v1/magpie/quotas` 里。

- 仓库：<https://github.com/Hara602/magpie-zenmux>；插件本体就在仓库根目录（`package.json` 在根，所以 `magpie plugin add github:Hara602/magpie-zenmux` 可以直接装）
- **装到 Windows 上的 magpie**：[`docs/windows.md`](windows.md)
- 英文 README（npm / 社区页面用）：[`../README.md`](../README.md)
- 调研纪要：[`docs/research/lead-findings.md`](research/lead-findings.md)、[`docs/research/zenmux-api.md`](research/zenmux-api.md)、[`docs/research/magpie-spec.md`](research/magpie-spec.md)

## 先回答「该怎么做」

magpie 的插件就是 **OpenCode 的 provider 插件**（Bun 宿主，npm 包 / git 仓库 / 文件夹均可）。
一个「订阅插件」要做的只有三件事，magpie 负责其余（多账号、故障转移、用量、代理、翻译各协议）：

| 钩子 | 作用 |
| --- | --- |
| `config(cfg)` | 声明 provider（id、npm 包、api 基址、默认模型）。models.dev 已收录 `zenmux` 时这段可以留空，magpie 会自动合并它的 110 个模型元数据。 |
| `auth` | 登录（`methods` + `prompts` + `authorize`）、每个账号的请求怎么发（`loader` 返回 `{baseURL, fetch}`）、额度怎么读（`usage`，magpie 自有钩子，OpenCode 忽略）。 |
| `provider.models` | 这个账号能看到哪些模型（按计划过滤；models.dev 认识的模型用 models.dev 的名字、限额、模态、能力和推理档位，实时目录只补 models.dev 没说到的）。 |

ZenMux 的特殊之处只有两个：

1. **聊天和额度是两把钥匙**。聊天用订阅 Key（`sk-subs-…`），额度接口
   `GET /api/v1/management/subscription/detail` **只认 Management API Key**（`sk-mgmt-…`）。
   所以插件登录时问两个 key（第二个可留空，留空只影响额度显示）。
2. **Key 前缀在 2026-11-10 换过**：旧 `sk-ss-v1-` / `sk-mg-v1-` 已全部停用，官方文档站还没改。
   插件已按新前缀 `sk-subs-` / `sk-payg-` / `sk-mgmt-` 实现，并在用户贴旧 key 时直接说明原因。

### 官方其实有 OpenCode / DSH / Hermes 插件，但这个位置是空的

ZenMux 目前官方发布的是三件套：`@zenmux/opencode-oauth`（OpenCode，OAuth PKCE）、
[ZenMux/dsh-plugins](https://github.com/ZenMux/dsh-plugins)（DeepSeek Harness）、
[ZenMux/hermes-plugin](https://github.com/ZenMux/hermes-plugin)（Hermes Agent）。
它们做的是「浏览器 OAuth 登录 + 模型目录 + 按模型选协议」，**都不显示订阅额度**：
额度接口只接受 Management API Key，OAuth token 会被 management 接口明确拒绝。

magpie 能直接安装官方 OpenCode 插件来聊天（`magpie plugin add @zenmux/opencode-oauth`），
但 `magpie quota` 里不会有 Flows。本插件补的就是「订阅额度 + 按计划过滤模型」这块，
复用同一套聊天 API。两者都签 `zenmux` 时只有一个在服务（后添加者赢，
`magpie plugin use <name> zenmux` 可指定），别同时装。

### 模型信息跟 models.dev 对齐（0.1.6 起）

magpie 的 Models 页和 agent 的模型选择器里，模型元数据以 **models.dev** 为准：

- models.dev 收录的模型（当前 `zenmux` 条目约 110 个）：名字、上下文 / 输入 / 输出限额、
  输入输出模态、能力位（reasoning、tool_call、attachment、temperature）、价格、发布日期、
  推理档位（`reasoning_options` 里的 effort 值）都用 models.dev 的；ZenMux 实时目录只补
  models.dev 没说的字段。
- models.dev 没收录的模型（ZenMux 实时目录里另外约 100 个）：用实时目录，推理档位退回插件的
  五档兜底 low / medium / high / xhigh / max。
- 推理档位读的是 magpie 自己的 models.dev 快照（就是 `magpie sync` 打印的那个文件：
  各平台默认都是 `~/.cache/magpie/models.json`，Windows 的 `C:\Users\<你>\.cache\magpie\models.json`
  也是这个位置；另外还会查 `$XDG_CACHE_HOME`、macOS `~/Library/Caches`、Windows `%LocalAppData%`），**只读**：
  不额外下载，也不往外发任何东西；快照不存在、读不了，或早于 models.dev 的档位字段时，
  退回实时目录 + 五档兜底。

效果举例（models.dev 的 zenmux 条目说了算）：`moonshotai/kimi-k3` 只提供 `max` 一档，
`deepseek/deepseek-v4.1-flash` 是 `low/high/max`，`anthropic/claude-fable-5.1` 是
`low/medium/high/xhigh/max`；`openai/gpt-6.1-terra` 不在 models.dev 的 zenmux 条目里，
所以保持五档兜底。要自己收窄档位，仍可用 `magpie model efforts zenmux/<vendor>/<model> low,medium,high`
（`--reset` 恢复）。

## 目录

```
.                       # 仓库根 = npm 包根
├── package.json          # npm 名字、magpie 元数据（名称/图标/并发）、keywords 供 Plugins 搜索
├── index.mjs             # 插件：config / auth（methods、loader、usage）/ provider.models
├── zenmux.mjs            # 纯函数：额度映射、模型行构造、计划模型集、价格、过滤器（可单测）
├── test/zenmux.test.mjs  # 32 个单测（node --test）
├── README.md             # 英文 README（npm 页面 / GitHub 首页）
├── LICENSE
└── docs/
    ├── zh-CN.md          # 本文件
    ├── windows.md        # Windows 安装指南
    ├── registry-entry.json  # 提交给 magpie-community/plugins 的条目
    └── research/         # 调研纪要 + 本地 mock（ZenMux 字段、字节级证据）
```

## 用起来

```sh
# 1) 在 ZenMux 拿两把钥匙
#    订阅 Key：https://zenmux.ai/platform/subscription   （sk-subs-…）
#    管理 Key：https://zenmux.ai/platform/management     （sk-mgmt-…，用于额度；可选）

# 2) 安装（三种都行）
magpie plugin add github:Hara602/magpie-zenmux                  # 直接拉 GitHub
magpie plugin add .                                          # 或本地仓库根目录
magpie plugin add opencode-zenmux-auth                       # 或 npm 发布之后

# 3) 登录：两种方式二选一
magpie plugin login zenmux oauth   # 浏览器授权（推荐，不用粘 Key）
magpie plugin login zenmux         # 或选订阅 API Key：粘贴 sk-subs-… → 管理 Key（可空）→ 邮箱（可空）

# 4) 三连验证
magpie plugin --json      # zenmux 有模型、usage:true、signedIn:true
magpie provider test zenmux   # ✓ chat
magpie quota                  # 5h / 7d Flows + 月度上限 + 剩余窗口重置
```

验收输出长这样（沙箱 + 本地 mock，见下）：

```
zenmux · Builder Ultra · until Dec 14 · qa@example.com  subscription
  5h 10% (5.19 / 50 Flows) ↻3h19m 18:05
  7d 2% (5.19 / 213 Flows) ↻6d22h Nov 21 13:05
  monthly 914 Flows/month ($30)   ↺ 3 five-hour resets until Dec 14 13:02
```

App 里的操作路径：**Plugins → Add a plugin** 指向文件夹 → 在 provider 行点登录；
额度出现在 Providers 卡片和 `magpie quota`。agent 里模型名是 `zenmux/<vendor>/<model>`，
例如 `zenmux/deepseek/deepseek-v4.1-flash`、`zenmux/openai/gpt-6.1-terra`。

## 看到套餐里的全部模型（0.1.4 起的默认行为）

登录后默认列出**你套餐里的全部模型**，不只是聊天模型：

```
默认（套餐全量）: 218 个（170 聊天 + 48 图片/视频/语音/向量）
只要聊天模型    : 169 个
忽略套餐过滤    : 219 个（ZenMux 全部聊天模型 + 非聊天）
```

开关有两处，改完重启宿主（`magpie plugin off <插件名> ; magpie plugin on <插件名>`）：

1. **App 里**：Plugins → Installed → 该插件 → Options，两个开关：
   - *Show every model the plan serves*（默认开）——关掉就只列聊天模型；
   - *Ignore the plan filter*（默认关）——打开就列 ZenMux 全部模型，不管套餐。
2. **命令行**（注意名字是**插件目录名**，不是 provider id）：

```powershell
magpie plugin options magpie-plugin '{"includeNonChat": false}'   # 只留聊天模型
magpie plugin options magpie-plugin '{"allModels": true}'         # 忽略套餐过滤
magpie plugin options magpie-plugin off                           # 回到默认
```

> 从 GitHub 装的目录名是 `magpie-zenmux`；如果 `magpie plugin` 里显示的名字不同，就用它。
> 写成 `magpie plugin options zenmux …` 会报 `no plugin "zenmux"` —— `zenmux` 是 provider id，
> 不是插件名。

非聊天模型（图片/视频/语音/向量）能在列表里看到，但**用聊天接口调用它们会失败**，这是
ZenMux 端的限制，不是插件的问题；所以只想聊天时可以关掉开关让列表干净一些。

### 为什么有的模型（例如 `qwen/qwen3.8-max-0902`）看不到

1. **没登录成功**：未登录时列表来自 magpie 内置的 models.dev，只有 110 个模型，
   而且**完全没有 qwen3.8 系列**（实测：models.dev 的 zenmux 条目里 `qwen3.8-max-0902` 不存在）。
   0.1.5 起，未登录也会去读 ZenMux 的公开目录（219 个），这种情况已经不会再发生。
2. **套餐不含**：`qwen/qwen3.8-max-0902` 在 Starter / Pro / Max / Ultra 里有，**Free 档没有**。
3. **登录成功但套餐列表变了**：计划里的模型会轮换，以 `zenmux.ai/pricing/subscription` 的 View 为准。

自查：

```powershell
magpie plugin --json                 # signedIn 是否 true，模型数是多少
magpie models | Select-String qwen   # 列表里有没有
magpie provider test zenmux qwen/qwen3.8-max-0902   # 直接打一次
```

agent 里要写全：`zenmux/qwen/qwen3.8-max-0902`（模型 id 本身带一个 `/`）。
该模型的 `suitable_api` 只有 `chat.completions`，所以走 Responses / Anthropic 原生端点不适用，
但 magpie 会自动翻译成 chat，正常使用不受影响。

## 为什么比 zenmux.ai 上少

zenmux.ai 上显示 **219** 个模型；站内"200+"的列表来自
`/api/frontend/model/available/list`，它按 **endpoint** 一条一条返回（219 个模型对应 253 条）。
magpie 里要放的是 agent 真能调用的模型，所以会逐层收窄：

| 步骤 | 数量 | 原因 |
| --- | --- | --- |
| ZenMux 目录（`/api/v1/models`） | 219 | ZenMux 提供的全部 |
| → 只留聊天模型 | **170** | 去掉 49 个：输出图片 14、视频 14、语音 6、语音转写 6、向量 4、决策 3、rerank 2 —— agent 的模型选择器只能聊天 |
| → 你套餐包含的 | **218**（默认） | 套餐全量：170 聊天 + 48 非聊天；只列聊天时是 **169**（1 个聊天模型 `inclusionai/ring-2.6-1t` 不在任何 Builder Plan 里） |
| 未登录时 | 219 | 0.1.5 起也读 ZenMux 的公开目录（之前是 models.dev 的 102 个，缺 qwen3.8 等） |

默认会列出套餐里的非聊天模型；只用于聊天时，建议设 `options.includeNonChat: false`。

## 推理档位

像 Codex 一样，选择模型和推理档位即可，协议参数与思考预算由插件内部处理。

- 模型声明了哪些档位，就显示哪些档位，顺序也保持一致。例如 DeepSeek V4.1 Flash
  是 `low / high / max`。
- 元数据只声明思考开关的模型，不会凭空增加档位；缺少档位资料的推理模型使用
  `low / medium / high / xhigh / max` 五档兜底。
- Chat 和 Responses 分别通过 `reasoning_effort`、`reasoning.effort` 原样传递所选档位，
  `max` 仍是 `max`，`xhigh` 仍是 `xhigh`。
- 优先读取 Magpie 的 `x-magpie-effort` 原始选择，避免协议转换后的默认值覆盖用户选择；
  这个内部请求头会在发往 ZenMux 前删除。

Messages 会把 adaptive thinking 转换成思考预算：

| 档位 | `budget_tokens` |
| --- | --- |
| none | 关闭思考 |
| minimal | 1024 |
| low | 2048 |
| medium | 5120 |
| high | 10240 |
| xhigh | 24576 |
| max / ultra | 32768 |

生成的预算通常不超过 `max_tokens` 的 80%，至少为 1024，且始终小于 `max_tokens`；
`max_tokens <= 1024` 时关闭思考，避免产生无效请求。调用方显式提供的正数预算会保留，
但选择 `none` 时会关闭思考。只有请求没有携带档位时，才用 `options.effort`，默认 `high`。

协议转换细节见 [ZenMux 官方说明](https://zenmux.ai/docs/api/protocol-conversion.html)。

## 两种登录方式（0.2.0 起）

| 方式 | 需要什么 | 额度 |
| --- | --- | --- |
| **ZenMux OAuth（浏览器登录）** | 什么都不用粘：浏览器授权 + PKCE + 本机回环回调 | 仍需 Management API Key（登录时一并问，可留空） |
| **ZenMux 订阅 API Key** | 粘贴 `sk-subs-…` | 同上 |

OAuth 用的就是 ZenMux 给 OpenCode / DeepSeek Harness 的那套流程：公开原生客户端、`S256`
PKCE、`127.0.0.1:<随机端口>/callback` 回调、scope `inference:invoke offline_access`，
refresh token 每次续期都轮换（magpie 在到期前 2 分钟续，且并发只续一次；`rotating: true`
告诉 magpie 这个 refresh token 是一次性的）。明确拒绝 refresh grant，或成功轮换却只返回
access token、没有替换用的 refresh token，才会要求重新登录。HTTP 429、服务端错误、
响应格式异常和网络故障会保留登录状态，供 Magpie 重试。
浏览器回调无论成功还是报错，都必须先匹配本次登录的 `state`。

两种方式产出的凭据都用于签名请求：API Key 原样用，OAuth 用 access token。

额度仍然离不开 Management API Key——ZenMux 的 `management/*` 接口拒绝 OAuth token。
它在登录时作为**可选项**询问，并与账号并存（存为 `managementKey`），不会替代 token。

## 每个模型走哪个 API（0.1.9 起）

ZenMux 同一个模型可以支持多种协议。在 `auto` 模式下，插件优先采用公开目录
`suitable_api` 中排在最前的可用协议；推理模型会优先选择能直接传递档位名的 Chat 或
Responses。目录没有给出顺序时，按 Responses、Chat、Messages 的顺序兜底。

| 协议 | SDK | 基址 |
| --- | --- | --- |
| Chat completions | `@ai-sdk/openai-compatible` | `/api/v1` |
| OpenAI Responses | `@ai-sdk/openai` | `/api/v1` |
| Anthropic Messages | `@ai-sdk/anthropic` | `/api/anthropic/v1` |

只列出 Chat 的模型仍然走 Chat，Codex 调用 Magpie 的 Responses 入口时也一样，
由 Magpie 负责转换请求与响应。

`options.protocol`：

| 值 | 效果 |
| --- | --- |
| `"auto"`（默认） | 按模型目录逐模型路由 |
| `"chat"` | 全部走 chat（旧行为） |
| `"responses"` / `"messages"` | 强制某一种，不支持该协议的模型会失败 |

`options.store`（默认 `false`）：Responses 默认会把会话留在 ZenMux 服务端（`store: true`），
插件默认关掉，除非你显式打开。

另外两个线缆细节：Messages 请求自动补 `anthropic-version: 2023-06-01`（ZenMux 要求），
流式 chat 请求自动加 `stream_options.include_usage`，让流式回合也能统计 token。

套餐、`models`、`exclude` 和 `includeNonChat` 过滤规则同时生效，排除项优先。
过滤结果为空时会保持为空；只有目录请求失败时才退回已知模型，并继续应用显式模型过滤。
模型列表、套餐、额度和登录检查请求支持取消，每个 HTTP 请求均有 30 秒超时。

## 登录报 403 时看这里

ZenMux 对多种情况都回同一句 `403 access_denied` / “You have no permission to access this
resource”，所以**不能只看状态码**。按可能性排序：

1. Key 是 **2026-11-10 之前**建的（`sk-ss-v1-…`、`sk-ai-v1-…`、`sk-mg-v1-…`）：那批已停用，
   去 <https://zenmux.ai/platform/subscription> 建新的 `sk-subs-…`。
2. 把 **Management Key 填进了第一个问题**：第一个问题要订阅 Key，第二个才是 `sk-mgmt-…`。
3. **Free 档**：完全没有 API 权限（只能 Studio Chat），需要 Starter 及以上。
4. **组织（organization）账号的 Key** 没有推理权限：让套餐所有者给这个 Key 开权限。

`sk-payg-…`（按量付费）Key 也能用，花的是 credits 而不是 Flows。

顺带说明：模型列表接口（`/api/v1/models`、`/api/anthropic/v1/models`、
`/api/vertex-ai/v1beta/models`）对**任何** Key 都回 200，验证不了 Key；而所有
`/api/v1/management/*` 对**合法订阅 Key** 也回 403（它要 Management Key）。所以 v0.1.1 起，
登录改为发一个 `max_tokens: 1` 的真实请求来验证（消耗几个 token，可忽略）。

v0.1.2 又修了一处：探测用的模型如果恰好上游报错（例如某些新模型回
`404 Server encountered an unexpected error`），旧版会把它当成 Key 无效。现在会依次换几个
主流模型再试，并且把这些响应都算「Key 已通过」：`200`、`429/402`（额度用尽）、
`400/404/422`（鉴权过了，是模型或请求体的问题）。只有 `401`、或文案里**不提模型**的 `403`
才算鉴权拒绝。5xx、网络故障和空目录会提示暂时无法验证，不会保存为登录成功。
登录验证直接检查推理接口，不再用 Management 接口猜测推理权限。
想固定探测模型可以设 `options.probeModel`。

## 已经踩平/需要知道的坑

这些是调研和沙箱实测（magpie v0.1.3913）踩出来的，改插件时值得照着做：

1. **`provider.models` 必须返回嵌套 `capabilities`**。models hook 顶层的
   `reasoning` / `tool_call` / `modalities` 会被忽略；只有 `config` hook 里才用顶层写法。
   （本插件两种字段都写，嵌套那份生效。）
2. **`GET /api/v1/models` 是公开的**，不校验 key（假 key 也 200），所以：
   - 模型列表可以未登录时就拿；
   - **不能**用它来验证登录，插件用一次最小聊天请求验证推理 Key。
3. **按计划过滤模型**：`GET /api/subscription/public/get_all_plans` 是公开的，
   每个 `planKey`（free/starter/pro/max/ultra）带 `models[].model_slug`；
   与 `subscription/detail` 的 `plan.tier` 求交集即可。线上 $20 档现在叫 **Pro**（Starter 已隐退），
   所以别把档位名写死成 Starter。
4. **403 不一定是掉线**：ZenMux 对无效 Key 返回 `403 access_denied`（而不是 401），
   magpie 会把裸 403 当成「该模型不可用」并换账号。插件只在 body 谈 key/token/legacy 时
   加 `x-magpie-sign-in: expired`，谈到 model 时不动——避免正常账号被误标 lapsed。
5. **额度窗口单位**：`usage_percentage` 是 0–1，要乘 100 才是 magpie 的 `used`（0–100）；
   `resetsAt` 用 ISO 字符串；`span` 秒。月度上限没有实时用量，用 `aside: true` 的
   display-only 窗口，不要塞进路由（否则会被当成 0 用量窗口）。
6. **别把 magpie 的内部请求头带给厂商**：插件 fetch 会收到 `x-magpie-fallback`、
   `x-magpie-work-dir` 等，本插件统一删掉所有 `x-magpie-*`（隐私）。
7. **订阅 Key 与 PAYG Key 同一 API**：本插件对 `sk-payg-` 也工作（此时模型会带 USD 价格）；
   只有订阅 Key 的 cost 被刻意留空——订阅花的是 Flows 不是美元。
8. **没有签到**：ZenMux 没有每日 check-in，不要实现 `auth.checkin`。
9. **部分版本的 `provider test` 会探测错误基址**：如果命令按 `…/api/v1` 探测所有协议，
   anthropic/gemini 的 404 可能只是基址不匹配；ZenMux 对应端点在
   `/api/anthropic/v1`、`/api/vertex-ai`。agent 按各模型的协议和基址调用，应再验证实际请求。
10. **keyless + prompts 才能让 `authorize` 拿到全部字段**：magpie 对 `api` 方法默认会
    自己问 key 且不交给 `authorize`；加 `keyless: true` 后，用 `prompts`（支持
    `required: false`、`password` 类型、`validate`）收齐字段。

## 沙箱验证（不碰真实 magpie）

真实 magpie 的 plugin/sign-in 都在 `~/.config/magpie`，写插件必须隔离：

```sh
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache \
        MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add .
m plugin login zenmux            # 假 key 会在这里被明确拒绝
m plugin --json                  # 未登录时也有 models.dev 的 102 个模型
```

为了在没有真 key 的情况下验证额度渲染，本仓库用了一个本地 mock：
[`docs/research/mock-zenmux.py`](research/mock-zenmux.py) 提供
`/api/v1/models`、`/api/v1/management/subscription/detail`、`/api/v1/chat/completions`
（含 SSE），把插件指向它即可看到完整 quota/provider test 流程：

```sh
python3 docs/research/mock-zenmux.py 3599 &
export ZENMUX_API_BASE=http://127.0.0.1:3599/api/v1
export ZENMUX_MANAGEMENT_API_BASE=http://127.0.0.1:3599/api/v1/management
export ZENMUX_PUBLIC_API_BASE=http://127.0.0.1:3599/api
# 在沙箱 plugin-auth.json 里注入假账号后：
m quota && m provider test zenmux && m plugin --json
```

单测：

```sh
npm test     # node --test，包含登录、OAuth、推理档位和模型过滤回归测试
```

## 发布到社区

- `npm publish`（包名 `opencode-zenmux-auth`，keywords 已包含 opencode / opencode-plugin / zenmux，Plugins 搜索能找到）；
- 或向 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 `registry.json` 加一条
  （现成 JSON 见 [`docs/registry-entry.json`](registry-entry.json)），之后所有 magpie 的 Discover 里都能一键安装；
- 或给 GitHub 仓库打 `magpie-plugin` topic，会出现在 Plugins → Discover → Unofficial。

## 参考

- [magpie 插件文档](https://usemagpie.ai/docs/plugins)
- [ZenMux 订阅计划](https://zenmux.ai/docs/guide/subscription.html)
- [Get Subscription Detail](https://zenmux.ai/docs/api/platform/subscription-detail.html)
- [ZenMux 推理参数（reasoning_effort / reasoning）](https://zenmux.ai/docs/guide/advanced/reasoning.html)
