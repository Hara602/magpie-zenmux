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
| `provider.models` | 这个账号能看到哪些模型（按计划过滤、补名字、价格、上下文）。 |

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

## 目录

```
.                       # 仓库根 = npm 包根
├── package.json          # npm 名字、magpie 元数据（名称/图标/并发）、keywords 供 Plugins 搜索
├── index.mjs             # 插件：config / auth（methods、loader、usage）/ provider.models
├── zenmux.mjs            # 纯函数：额度映射、模型行构造、计划模型集、价格、过滤器（可单测）
├── test/zenmux.test.mjs  # 12 个单测（node --test）
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

# 3) 登录：按提示粘贴订阅 Key、管理 Key（可空）、邮箱（可空，用于给账号起名）
magpie plugin login zenmux

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

## 为什么比 zenmux.ai 上少

zenmux.ai 上显示 **219** 个模型；站内"200+"的列表来自
`/api/frontend/model/available/list`，它按 **endpoint** 一条一条返回（219 个模型对应 253 条）。
magpie 里要放的是 agent 真能调用的模型，所以会逐层收窄：

| 步骤 | 数量 | 原因 |
| --- | --- | --- |
| ZenMux 目录（`/api/v1/models`） | 219 | ZenMux 提供的全部 |
| → 只留聊天模型 | **170** | 去掉 49 个：输出图片 14、视频 14、语音 6、语音转写 6、向量 4、决策 3、rerank 2 —— agent 的模型选择器只能聊天 |
| → 你套餐包含的 | **169** | 只有 1 个聊天模型（`inclusionai/ring-2.6-1t`）不在任何 Builder Plan 里，其余按档位过滤 |
| 未登录时 | 102 | magpie 内置的 models.dev `zenmux` 条目，比 ZenMux 实时列表小 |

非聊天模型是**故意**不列的：在聊天 agent 里选了视频模型，第一个请求就会失败。
想全部列出来（例如给走 `/v1/images/generations` 的用法），设 `options.includeNonChat: true`。

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
才算拒绝。想固定探测模型可以设 `options.probeModel`。

## 已经踩平/需要知道的坑

这些是调研和沙箱实测（magpie v0.1.3913）踩出来的，改插件时值得照着做：

1. **`provider.models` 必须返回嵌套 `capabilities`**。models hook 顶层的
   `reasoning` / `tool_call` / `modalities` 会被忽略；只有 `config` hook 里才用顶层写法。
   （本插件两种字段都写，嵌套那份生效。）
2. **`GET /api/v1/models` 是公开的**，不校验 key（假 key 也 200），所以：
   - 模型列表可以未登录时就拿；
   - **不能**用它来验证登录，插件改用 `GET /api/v1/management/generation?id=…`（订阅 Key 可读 metering）判断 key 是否有效。
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
9. **`provider test` 的 anthropic/gemini 行会 404**：该命令按 provider 基址 `…/api/v1`
   探测所有协议，而 ZenMux 的 Anthropic/Vertex 端点在 `/api/anthropic/v1`、`/api/vertex-ai`。
   agent 实际走 chat，功能不缺。
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
npm test     # node --test，12 个用例
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