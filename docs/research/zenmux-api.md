# ZenMux Builder Plan（订阅）接入调研

调研时间：2026-11-14（Asia/Shanghai）。调研方式：web_fetch/curl 只读探测 + 官方文档源仓库 + 官方/第三方插件源码。
所有外部事实均标注「已验证」并附证据，或标「未证实」。**未注册、未登录、未使用任何真实密钥。**

> 重要更正（与 Lead 已确认信息冲突，务必更新实现）：**2026-11-10 起 v1 旧 Key 前缀已停用**，新前缀见 §0。

---

## 0. 关键事实：API Key 前缀已于 2026-11-10 迁移（已验证）

ZenMux 于 2026-10-22–11-10 进行 Key 升级，之后 **`sk-ss-v1-` / `sk-ai-v1-` / `sk-mg-v1-` 全部失效**，新前缀：

| 用途 | 旧前缀 | **当前前缀** | 现有证据 |
|---|---|---|---|
| 订阅（Builder Plan）推理 Key | `sk-ss-v1-…` | **`sk-subs-…`** | 前端 bundle 迁移公告表 + 实测 |
| PAYG 推理 Key | `sk-ai-v1-…` | **`sk-payg-…`** | 同上 |
| 平台管理（Management API）Key | `sk-mg-v1-…` | **`sk-mgmt-…`** | 同上 |

证据 1（前端 bundle 明文迁移对照表）：
`umi.js`（`https://cdn.marmot-cloud.com/page/tbox-router-home/umi.4c9fe62d.js`）含：
```
oldPrefix:"sk-ai-v1-…", newPrefix:"sk-payg-…"
oldPrefix:"sk-ss-v1-…", newPrefix:"sk-subs-…"
oldPrefix:"sk-mg-v1-…", newPrefix:"sk-mgmt-…"
```
以及 `legacyKeyNoticeMigration:"…Old API keys will stop working on November 10, 2026…"`。

证据 2（实测，curl 只读探测）：
```bash
# 旧前缀：被 migration 逻辑直接拦掉
curl -sS https://zenmux.ai/api/v1/management/subscription/detail \
  -H "Authorization: Bearer sk-mg-v1-aaaa…"
# HTTP 403
# {"success":false,"message":"The API key upgrade window (October 22–November 10, 2026) has ended.
#  Legacy keys have been disabled since November 10, 2026, at 00:00 UTC. …"}

# 新前缀：进入正常校验（结果为 Invalid API key，说明前缀格式有效）
curl -sS https://zenmux.ai/api/v1/management/subscription/detail \
  -H "Authorization: Bearer sk-mgmt-aaaa…"
# HTTP 403 {"success":false,"message":"Invalid API key","data":null}
```

证据 3（推理端点识别 Key 类型）：
```bash
curl -sS -X POST https://zenmux.ai/api/v1/chat/completions \
  -H "Authorization: Bearer sk-subs-aaaa…" -H 'Content-Type: application/json' \
  -d '{"model":"deepseek/deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}]}'
# HTTP 403 {"error":{"code":"403","type":"access_denied",
#   "message":"You have no permission to access this resource (api_key_source: subscription) …"}}
# 把 Authorization 换成 sk-payg-… → 同样 403，但 api_key_source: payg
```
结论：**同一 `/api/v1` 同时服务订阅与 PAYG，靠 Key 前缀区分计费来源**；插件应接受 `sk-subs-…` 作为推理 Key，并兼容用户可能仍贴旧前缀时给出明确报错（旧 Key 已不可用）。

> 文档站（docs.zenmux.ai / zenmux.ai/docs，源仓库 `ZenMux/zenmux-doc`，最新 commit 2026-11-13）**仍在写 `sk-ss-v1-…` / `sk-mg-v1-…`**，已过时；以上以前端迁移公告 + 实测为准。

---

## 1. 订阅计划名称、价格档位、鉴权方式

### 1.1 名称与档位

- 产品名：**ZenMux Builder Plan**（订阅）。已验证：https://zenmux.ai/docs/guide/subscription.html（“The ZenMux Builder Plan gives individual developers a fixed monthly fee…”）。
- **线上真实档位以公开计划接口为准**：`GET https://zenmux.ai/api/subscription/public/get_all_plans`（无需鉴权，HTTP 200）。

| planKey | name | price(USD/月) | period_quota（Flows/5h） | weekMaxFlows | monthMaxFlows | 模型条目数/去重数 |
|---|---|---|---|---|---|---|
| free | Free Plan | 0 | 5 | 38.64 | 165.6 | 43 / 27 |
| starter | Starter Plan | 20 | 50 | 213.29 | 914.11 | 294 / 234 |
| pro | Pro Plan | 20 | 50 | 213.37 | 914.44 | 308 / 244 |
| max | Max Plan | 100 | 300 | 1280.22 | 5486.66 | 322 / 256 |
| ultra | Ultra Plan | 200 | 800 | 3413.92 | 14631.09 | 322 / 256 |

返回样例（截断）：
```json
{"success":true,"data":[{"planKey":"free","name":"Free Plan","price":0,"period_quota":5,
  "weekMaxFlows":38.64,"monthMaxFlows":165.6,"desc":"5 Flows/5h","models":[{"endpoint_slug":"*","model_slug":"z-ai/glm-4.6v-flash-free","provider_slug":"*"}, …]},
 {"planKey":"starter","name":"Starter Plan","price":20,"period_quota":50,…},
 {"planKey":"pro","name":"Pro Plan","price":20,"period_quota":50,…}, …]}
```

- **命名不一致（已验证，需注意）**：
  - 文档 guide 说“four tiers: Free / Starter / Max / Ultra”，$20 档叫 Starter；
  - 线上接口同时存在 `starter` 与 `pro`（均 $20），且前端 bundle `staticData.showStarterPlan:false`、i18n 文案已改为 `getPro:"Obtener Pro"`；
  - 管理接口文档 `subscription/detail` 的 `plan.tier` 枚举是 **`free` / `pro` / `max` / `ultra`**（无 starter）。
  - 结论：**当前 $20 档 = Pro**；Starter 是过渡/旧档（仍可能给老用户）。插件显示 plan 名称时用 `plan.tier` 归一化：free→Free、pro→Pro、max→Max、ultra→Ultra、starter→Starter(legacy)。
- `timeLimitedModels` / `benefitEndDate` 可能非空（限时模型/权益到期时间），已见字段但当前值为 null。

### 1.2 鉴权方式

三种凭据，彼此独立（已验证）：

1. **订阅 API Key**：`sk-subs-…`，用于推理；`Authorization: Bearer sk-subs-…`。文档/前端文案：“Your subscription API key (sk-subs-xx) is tied to your active plan… different from PAYG API keys (sk-payg-xx)”。
2. **PAYG API Key**：`sk-payg-…`，同样是 `Authorization: Bearer`，走同一 `/api/v1`，但按 token 计费、无 5h/7d 限制。
3. **Management API Key**：`sk-mgmt-…`（创建入口 https://zenmux.ai/platform/management），**只用于平台管理 API（含订阅额度）**。官方文档明确：“Only accepts Management API Keys. Standard API Keys are not supported.”（`docs_source/en/api/platform/subscription-detail.md`；account-usage.md 更写明“Standard API Keys, OAuth access tokens, and organization Management Keys are not supported”）。

- ZenMux 还支持 **OAuth 2.0 Authorization Code + PKCE** 登录（官方 OpenCode/DSH/Codex 等插件用），但 **OAuth access token 不能调用 management 额度接口**（文档明示）；因此“OAuth 登录 + 额度展示”单独不可行。详见 §5/§7。
- 没有发现 device-code 流程；社区 OAuth 都是 loopback `127.0.0.1:<port>/callback` + PKCE（官方 `@zenmux/opencode-oauth` 源码 `src/core.mjs`）。

---

## 2. 端点、协议、必需 headers

已验证（官方文档 https://zenmux.ai/docs/guide/quickstart.html + 自测 HTTP 状态）：

| 协议 | Base URL | 关键端点 | 鉴权 |
|---|---|---|---|
| OpenAI Chat Completions | `https://zenmux.ai/api/v1` | `POST /chat/completions` | `Authorization: Bearer <key>` |
| OpenAI Responses | `https://zenmux.ai/api/v1` | `POST /responses` | 同上 |
| Anthropic Messages | `https://zenmux.ai/api/anthropic` | `POST /v1/messages` | 文档写 `x-api-key` + `anthropic-version: 2023-06-01`；**实测 `Authorization: Bearer` 也被解析**（见下） |
| Google Vertex AI | `https://zenmux.ai/api/vertex-ai` | `POST /v1/publishers/{provider}/models/{model}:generateContent`（`apiVersion: v1`） | `Authorization: Bearer <key>` |

- **协议无关**：官方称“你可以用任意协议调用任意模型”（protocol agnostic）。订阅计划 `models[]` 里 `endpoint_slug:"*"`、`provider_slug:"*"` 表示该模型在所有端点/供应商可用。只有 **Free 档不能调 API**（仅 Studio Chat）；Starter 及以上可用 API。
- 订阅限制：**10–15 RPM**、周窗口上限；不允许生产使用；Free 档无 API。没有发现“订阅只能用某几个端点”的限制。

自测（假 Key，只为确认路径/鉴权解析，未产生调用）：
```bash
# OpenAI chat
POST /api/v1/chat/completions, Bearer sk-subs-fake   → HTTP 403 access_denied (api_key_source: subscription)
# OpenAI responses
POST /api/v1/responses, Bearer sk-subs-fake          → HTTP 403 access_denied (api_key_source: subscription)   # 路径存在
# Anthropic messages，两种鉴权都能被解析
POST /api/anthropic/v1/messages, x-api-key: fake     → HTTP 403 access_denied (api_key_source: payg)
POST /api/anthropic/v1/messages, Bearer sk-subs-fake → HTTP 403 access_denied (api_key_source: subscription)
# Vertex generateContent
POST /api/vertex-ai/v1/publishers/google/models/gemini-4-hydrogen:generateContent, Bearer sk-subs-fake
                                                     → HTTP 403 access_denied (api_key_source: subscription)
```
结论（已验证）：**订阅 Key 在 OpenAI / Anthropic / Responses / Vertex 四条端点都可用**（HTTP 403 = 鉴权已解析、Key 无效，而不是 404 路径不存在）。Anthropic 端点两种 header 都接受；`anthropic-version` 必需（文档）。

### 必需 / 可选 headers

- 推理必需：`Authorization: Bearer <key>`（Anthropic 可 `x-api-key`）+ `Content-Type: application/json`（Anthropic 另需 `anthropic-version: 2023-06-01`）。
- 可选（已验证，文档 https://zenmux.ai/docs/api/overview.html）：
  - `HTTP-Referer`: 标识你的应用站点；
  - `X-Title`: 标识应用名；
  - 官方 DSH 插件额外发 `x-zenmux-session-id`（把请求归组到 agent 会话，见 `ZenMux/dsh-plugins` 源码 `src/session-header.ts`）；不是必需。
- 响应头：错误排查用 `X-ZenMux-RequestId`（文档 error-codes）；生成详情用 `x-generation-id`（zenmux-skills/zenmux-usage）。
- **没有** `x-zenmux-*` 系列必需鉴权头（bundle 里只有 `x-zenmux-upload-source`、`x-zenmux-signup-attribution` 等前端内部头）。

---

## 3. 模型列表与“按订阅过滤”

### 3.1 公开模型目录（均无需鉴权，已验证 HTTP 200）

1. **`GET https://zenmux.ai/api/v1/models`**（OpenAI 风格，219 条）
   - 顶层 `{object:"list", data:[…]}`；每项字段：`id`（`provider/model`，如 `deepseek/deepseek-v4.1-flash`）、`object:"model"`、`display_name`、`created`、`owned_by`、`input_modalities[]`（text/image/video/audio/file）、`output_modalities[]`、`capabilities:{reasoning:bool}`、`context_length`、`max_tokens`（219 中 171 条有）、`pricings`（`prompt/completion/input_cache_read/input_cache_write/web_search/audio/…`，每项 `{value,unit:"perMTokens"|"perCount",currency:"USD"}`）、`publish_time`。
   - 这是文档给 OpenAI 客户端的列表；不体现计划可用性。
2. **`GET https://zenmux.ai/api/anthropic/v1/models`**（Anthropic 风格，200）：
   - `{"data":[{"id":"google/gemini-4-hydrogen","created_at":"2026-11-13","display_name":…,"type":"model", …同 pricings}]}`
3. **`GET https://zenmux.ai/api/vertex-ai/v1beta/models`**（Vertex 风格，200，注意是 `v1beta` 不是 `v1`）：
   - `{"models":[{"name":"google/gemini-4-hydrogen","displayName":…,"description":…,"inputTokenLimit":…,"outputTokenLimit":…,"thinking":false,"inputModalities":[…],"outputModalities":[…]}]}`
4. **`GET https://zenmux.ai/api/frontend/model/available/list`**（**官方插件实际使用的富目录**，200，约 4.1 MB / 253 条目；Lead 之前认为 /api/v1/models 是唯一公开目录，实际不是）
   - 每项：`slug`、`name`、`description`、`context_length`、`max_completion_tokens`、`input_modalities`、`output_modalities`、`isFree`、`variant`（`standard`/`free`）、`endpoints[]`（每项含 `api` / `suitable_api` / `supported_parameters[]` / `supports_reasoning` / `supports_tool_parameters` / `pricing_prompt` 等）、`pricing_*`、`supported_parameters`（如 `reasoning_effort`、`tools`、`response_format`）、`flags`。
   - 官方 `@zenmux/opencode-oauth` 用它做模型目录并按端点选协议（`src/core.mjs`：`ZENMUX_MODEL_CATALOG_URL` 默认即此 URL；协议优先级 `anthropic-messages > openai-responses > openai-completions`）。
   - 注意：同一模型可能有多个条目（不同 provider/endpoint），需按 `slug` 聚合。

### 3.2 订阅频道与计划-模型映射（已验证）

- **ZenMux 没有 `zenmux-builder` 这种“频道/模型 id 后缀”**。模型 id 就是 `provider/model`；订阅可用性不在模型目录里（catalog 无任何 plan/subscription 字段，`grep` 为 0）。
- 唯一权威来源：公开计划接口 `api/subscription/public/get_all_plans` 的 `models[].model_slug`（配合 `endpoint_slug:"*"`、`provider_slug:"*"`）。按用户的 `plan.tier`（management API 的 subscription/detail 给出）取对应 `planKey`，再以 `model_slug` 集合过滤模型目录即可。
- 若没有 management key（拿不到 tier）：
  - 保守做法：用所有付费档的并集（≈ Max/Ultra 的 256 个去重 slug）；Starter 用户会多看到约 22 个模型，实际调用返回 **404 `model_not_available`**；
  - 更好做法：在插件 sign-in 里让用户选自己的档位（Pro/Max/Ultra），存 metadata，先用它过滤；拿到 management key 后以真实 tier 校正。
- 各档模型关系（已验证，基于 plans 接口）：free ⊂ starter ⊂ pro ⊂ max/ultra；max 与 ultra 模型集合相同（只差额度）；starter→pro 有 19 个新增、9 个移除，pro→max 有 14 个新增、2 个移除，所以不要假设严格包含。
- 免费模型：catalog `isFree:true` 只有 `z-ai/glm-4.7-flash-free`、`z-ai/glm-4.6v-flash-free`；`/api/v1/models` 中价格全 0 的有 6 个（另含 image 类），可据此给 OpenCode 模型打 `free: true`。订阅用户用到免费模型是否消耗 Flow **未证实**（plans 的 free 档也含这两个模型，说明免费模型对所有档可见）。

### 3.3 模型元数据（已验证，来自 /api/v1/models 与富目录）

| magpie/OpenCode 字段 | ZenMux 来源 |
|---|---|
| id | `model.slug`（`/api/v1/models` 的 `id`） |
| name | `display_name` / `name` |
| limit.context | `context_length`（富目录另有 `endpoints[].context_length`，取 max/min 皆可） |
| limit.output | `max_tokens`（/api/v1/models）或 `max_completion_tokens`（富目录） |
| capabilities.reasoning | `capabilities.reasoning` 或 `endpoints[].supports_reasoning>0` |
| capabilities.toolcall | `endpoints[].supports_tool_parameters` / `supported_parameters` 含 `tools` |
| capabilities.attachment | `input_modalities` 含 `image`/`file` |
| cost | `pricings.prompt/completion`（USD per 1M tokens，转成每 token 需 /1e6）；订阅本身不按 USD 计费，但 OpenCode 需要 cost 字段 |
| free | `isFree` 或所有 pricing 为 0 |
| variants（推理等级） | `supported_parameters` 含 `reasoning_effort`；文档取值 `none/minimal/low/medium/high/xhigh`（默认与范围随模型变），可映射为 variants `{low,medium,high}`（安全起见不暴露 xhigh） |

- 图片输入：支持 `image` 的模型很多（如 `deepseek/deepseek-v4.1-flash` 支持 image+text 输入）；vision 由 `input_modalities` 判定。
- reasoning：`deepseek/deepseek-v4.1-flash` `capabilities.reasoning:true`、`context_length:1000000`、`max_tokens:384000`（富目录里 `max_completion_tokens:384000`）、`pricing_prompt:0.15`、`pricing_completion:0.6`（per MTokens，实测 JSON）。
- tool_call：`supports_tool_parameters:1`，`supported_parameters` 含 `tools,tool_choice,parallel_tool_calls`。

### 3.4 模型可用性错误

- **404 `model_not_available`**：模型存在但不在当前订阅计划（文档 error-codes 原文）。插件 fetch 应把它当作“模型不可用”（不要把账户标成 sign-in expired）。
- **404 `invalid_model` / 404 `model_not_supported`**：模型不存在 / 不支持该 API。

---

## 4. 额度 / 用量：接口、字段、单位与 magpie 映射

### 4.1 唯一可靠的订阅额度接口（已验证路径与 401 结构；字段来自官方文档与官方/第三方实现）

```http
GET https://zenmux.ai/api/v1/management/subscription/detail
Authorization: Bearer <ZENMUX_MANAGEMENT_API_KEY>   # sk-mgmt-…
```
无凭证实测：
```bash
curl -sS https://zenmux.ai/api/v1/management/subscription/detail
# HTTP 401 {"success":false,"message":"API key not provided","data":null}
```
成功响应结构（官方文档样例，`docs_source/en/api/platform/subscription-detail.md`，同一结构被第三方 `dsh-subscription-usage` 解析）：
```json
{"success":true,"data":{
  "plan":{"tier":"ultra","amount_usd":200,"interval":"month","expires_at":"2026-04-12T08:26:56.000Z"},
  "currency":"usd",
  "base_usd_per_flow":0.03283,
  "effective_usd_per_flow":0.03283,
  "account_status":"healthy",           // healthy|monitored|abusive|suspended|banned
  "quota_5_hour":{"usage_percentage":0.0715,"resets_at":"2026-03-24T08:35:09.000Z",
                  "remaining_resets":1,"max_flows":800,"used_flows":57.2,
                  "remaining_flows":742.8,"used_value_usd":1.88,"max_value_usd":26.27},
  "quota_7_day":{"usage_percentage":0.0673,"resets_at":"2026-03-26T02:15:05.000Z",
                 "max_flows":6182,"used_flows":416.11,"remaining_flows":5765.89,
                 "used_value_usd":13.66,"max_value_usd":202.99},
  "quota_monthly":{"max_flows":34560,"max_value_usd":1134.33}   // 只有上限，没有实时 used
}}
```
语义（已验证/文档原文）：
- `usage_percentage`：**0–1 小数**（4 位小数），窗口已消耗比例；消费按滚动窗口实时更新。
- `quota_5_hour` / `quota_7_day`：**滚动窗口**（从首个请求开始计时，5h / 7d 重置）；三个窗口（5h、7d、月度）**同时生效**，任一打满即限流。
- `quota_monthly`：当前计费周期的**上限**（max_flows / max_value_usd），不含实时用量。
- `resets_at`：ISO 8601（UTC，带毫秒 `Z`）；窗口未开始时为 `null`。
- `remaining_resets`：本订阅周期内可用的“提前重置 5h 窗口”次数（非 Flow 剩余；自然重置不消耗；无订阅/Free/过期返回 0）。
- `plan.tier`：`free` / `pro` / `max` / `ultra`（文档枚举；线上 plans 另有 `starter`）。
- `plan.expires_at`：当前订阅周期到期时间 ISO 8601。
- `base_usd_per_flow` / `effective_usd_per_flow`：1 Flow ≈ $0.03283；异常账号 effective 会更高（滥用惩罚）。

### 4.2 其他相关接口

| 接口 | 鉴权 | 用途 | 证据 |
|---|---|---|---|
| `GET /api/v1/management/payg/balance` | management key | PAYG 余额 `{currency,total_credits,top_up_credits,bonus_credits}`（USD，1 credit=1 USD） | 文档+zenmux-skills 状态栏脚本 |
| `GET /api/v1/management/flow_rate` | management key | Flow 汇率 `{currency,base_usd_per_flow,effective_usd_per_flow}` | 文档，实测无 key→401 |
| `GET /api/v1/management/generation?id=` | management key/API key | 单次请求 token/成本（3–5 分钟延迟） | 文档 |
| `GET /api/v1/management/usage?type=usage&query_dimension=BIZ_MTH&query_time=YYYYMM…` | management key（仅 `sk-mgmt-*`） | 账号 usage 分析；**不含订阅用量**（文档：Usage Analytics 只统计 PAYG） | 文档 |
| `GET /api/v1/models` | 无需 | 模型目录（不校验 key，合法/非法/无 key 都 200） | 实测 |

控制台内部 API（从前端 bundle 提取，**均需控制台会话 cookie，插件不应依赖**）：
`api/subscription/get_current`、`api/subscription/get_current_usage`、`api/subscription/get_five_hour_reset_usage`、`api/subscription/reset_five_hour_usage`、`api/subscription/public/get_all_plans`（这个公开可匿名访问，已验证 200）、`api/subscription/public/get_subscriptions_count`、`api/subscription/get_my_rate_history` 等。未鉴权时 console 接口返回 `{"success":false,"message":"Unauthorized"}`（实测 401，`/api/subscription/get_current` 等）。

### 4.3 magpie `auth.usage` 的 `{plan, windows:[{name, used, resetsAt, span}]}` 一一映射建议

依据 `.research/plugins-doc.txt`（magpie v0.1.6xx 文档）usage 返回结构：`plan`、`until`、`windows[{name,used(百分比,可>100),resetsAt|resetSecs,span(秒),display,amount,limit,unit,aside,runsOutAt,balance}]`、`resets{count,…}`。

建议：

```js
// GET /api/v1/management/subscription/detail, Authorization: Bearer <sk-mgmt-…>
const d = body.data, pct = (w) => (typeof w?.usage_percentage === 'number' ? w.usage_percentage * 100 : undefined)
const win = (name, w, span) => ({
  name,
  used: pct(w),                              // 0–100；vendor 不给就不传（月度窗口不要填 0）
  resetsAt: w?.resets_at ?? undefined,       // ISO 8601 UTC，magpie 接受 ISO/epoch
  span,                                      // 秒：5h=18000，7d=604800
  amount: w?.used_flows, limit: w?.max_flows, unit: 'Flows',   // 可选：显示 “57.2 / 800 Flows”
  display: `${w.used_flows} / ${w.max_flows} Flows`,            // 可选
})
return {
  plan: `ZenMux Builder · ${title(d.plan.tier)}`,   // free/pro/max/ultra
  until: d.plan.expires_at,                          // ISO
  windows: [
    win('5h', d.quota_5_hour, 18000),
    win('7d', d.quota_7_day, 604800),
    { name: 'monthly cap', display: `${d.quota_monthly.max_flows} Flows / month`, aside: true },
  ],
  resets: { count: d.quota_5_hour?.remaining_resets ?? 0 },  // “可提前重置 5h 次数”
  // 可选：若同时配置了 management key，可再取 /payg/balance 用 balance 字段展示钱包
}
```
要点：
- `quota_monthly` **没有实时 used**，只能做 `display` 窗口（`used`/`amount`/`limit` 都不要传，否则会被理解为 0 或满额）；用 `aside:true` 表示它不参与路由/不会“用尽即停”。
- `account_status` 为 `suspended`/`banned` 时：可返回 `error`/`signIn:"expired"`，让 magpie 标账户；`monitored`/`abusive` 仍可用，可加 display 提示。
- 5h 窗口 `resets_at` 为 null（窗口未开始）→ 不传 `resetsAt`。
- management key 失效（401/403）：返回 `{error: "ZenMux 管理 Key 无效或已过期（需要在 zenmux.ai/platform/management 重新创建）", windows: []}`；**不要标记推理 Key 失效**（两者不同）。

### 4.4 401 / 403 / 422 / 429 语义（已验证 + 文档）

- **推理端点**：无效 Key 返回 **403**（不是 401）：`{"error":{"code":"403","type":"access_denied","message":"You have no permission to access this resource (api_key_source: subscription|payg) (request_id: …)"}}`（实测）。
- **额度/管理端点**：缺 header → **401** `{"success":false,"message":"API key not provided","data":null}`；带无效 Key → **403** `{"success":false,"message":"Invalid API key","data":null}`；旧 v1 Key → **403** 带 migration 文案（实测）。
- **422**：管理 API 平台级限流（“Exceeding the limit returns a 422 error”，文档 subscription-detail/flow-rate/payg-balance）。
- **429**：推理限流 `{"error":{"code":"429","type":"rate_limit","message":"Rate limit exceeded"}}`（文档 error-codes）；`Retry-After` 只在 account-usage/account-cost 文档明确（每账号 60 rpm，第 61 次返回 HTTP 429 + `Retry-After: 60`）；**推理 429 是否带 Retry-After 未证实**。
- **402 `quote_exceeded`**：订阅额度耗尽（文档原文，含 “wait for automatic quota refresh…upgrade…or use a Pay-As-You-Go API Key”）。
- **404 `model_not_available`**：模型不在当前订阅计划。
- magpie 注意：magpie 默认把 **401** 当 sign-in 失效、**403/404 当模型拒绝**；ZenMux 推理无效 Key 是 403，所以插件 fetch 里应识别 `403 + access_denied + api_key_source` 并主动 `throw Object.assign(new Error(...), {signIn:"expired"})`，或给响应加 `X-Magpie-Sign-In: expired` 头。

---

## 5. 每日签到 / Token 过期与刷新

### 5.1 每日签到（checkin）

- **未发现 ZenMux 有每日签到接口**（结论：不存在，或至少没有公开/可程序化调用的 checkin）：
  - 控制台全部 API 路径（从前端 bundle 提取的 `api/...` 列表）无 checkin/daily-sign 类端点；相关的只有一次性活动领取：`api/gift/creditsRedPacket/{info,claim}`、Token Pack 领取（`claim.*` 前端文案，活动批次制，不是每日签到）；
  - 官方文档（guide/help/best-practices）无 check-in；官方插件（opencode/dsh/codex/hermes/openclaw）无 checkin 实现；
  - 第三方 `dsh-subscription-usage` 也无 checkin。
  - 因此 magpie 的 `auth.checkin` 钩子**不要实现**。
- 有“每日购买限额”“每日自动检测保险赔付”等每日概念，但都不是签到领额度。

### 5.2 Token 过期 / refresh

- **API Key（sk-subs-… / sk-payg-… / sk-mgmt-…）**：未发现过期时间；由用户在控制台轮换（v1→新前缀就是一次强制轮换）。不需要 `auth.refresh`，插件只需在 401/403 invalid key 时提示重新签发。
- **OAuth（可选登录方式）**：
  - authorize：`GET https://zenmux.ai/oauth/authorize`（实测存在，无参/无会话时 302 → `/`）；
  - token：`POST https://zenmux.ai/oauth/token`，`application/x-www-form-urlencoded`，`grant_type=authorization_code|refresh_token`，`client_id`、`code`/`refresh_token`、`redirect_uri`、`code_verifier`；实测无效 code → `HTTP 400 {"error":"invalid_grant","error_description":"Authorization code is invalid or expired"}`；
  - scopes：`inference:invoke offline_access`；
  - 官方 `@zenmux/opencode-oauth` 行为：access token 默认按 `expires_in || 7200` 秒记，提前 **2 分钟** 刷新，refresh token 轮换并持久化；有 `oauth/register` 动态注册（非生产 origin 用，`token_endpoint_auth_method:"none"`）；生产用内置 public client ID `zpc_w3HpDNWorRuWEE6uIJxDSr5r`（OpenCode 的 client，**不是 magpie 的**；OAuth client 需向 support@zenmux.ai 申请注册）。
  - 结论：如果插件采用 OAuth 登录，需要 `auth.refresh` + `refreshLead: 2*60*1000`，逻辑按 `@zenmux/opencode-oauth` `src/core.mjs` 即可照抄；**但 OAuth token 拿不到额度**（management 接口明确拒绝 OAuth access token），所以额度仍须 Management Key。

---

## 6. 官方 / 第三方 SDK 与实现证据

| 来源 | 说明 |
|---|---|
| GitHub `ZenMux/zenmux-doc` | 文档源仓库（VitePress），`docs_source/en/api/platform/subscription-detail.md` 等即本报告引用；最新 commit `943422a`（2026-11-13）。 |
| npm `@zenmux/opencode-oauth` / GitHub `ZenMux/opencode-plugin` | **OpenCode 风格的官方 OAuth 插件**（与 magpie 插件模型最接近）：PKCE、`oauth/authorize`、`oauth/token`、refresh、模型目录 `/api/frontend/model/available/list`、协议选择（Anthropic/Responses/Chat）。 |
| npm `@zenmux/dsh-plugins` / GitHub `ZenMux/dsh-plugins` | DSH 官方 OAuth 插件；含 `x-zenmux-session-id` 头、模型目录刷新、Anthropic Messages 路由。 |
| npm `@zenmux/openclaw-plugin`、`@zenmux/codex-oauth`、`@zenmux/pi-zenmux-oauth`、`ZenMux/hermes-plugin` | 其它官方 OAuth 客户端，流程一致。 |
| npm `@zenmux/ai-sdk-provider`（1.0.0-beta.1） | AI SDK 官方 provider（API Key 方式），可参考模型字段转换。 |
| GitHub `ZenMux/skills`（zenmux-statusline / zenmux-usage） | 官方 skills：`zenmux-statusline.sh` 用 `ZENMUX_MANAGEMENT_KEY` 调 `management/subscription/detail` + `payg/balance`，解析 `usage_percentage*100`、`plan.tier`、`resets_at`（与我们的映射一致）；`zenmux-usage/SKILL.md` 列出全部 management endpoints。 |
| npm `dsh-subscription-usage`（第三方） | **已实现 ZenMux Builder 额度面板**：`plans/zenmux-builder.js` 用 `management/subscription/detail`，`usage_percentage`(0–1)→percent，`quota_5_hour`→rolling、`quota_7_day`→weekly、注释“monthly cap only, never reports monthly used”，`account_status` banned/suspended→停用。 |
| npm `dsh-zenmux`（第三方） | 同样用 `/management/subscription/detail` + `/management/payg/balance`，`ZENMUX_MANAGEMENT_KEY` 环境变量，`quota_5_hour`/`quota_7_day` 窗口。 |
| npm `@metatronwings/claude-code-zenmux-status` | 第三方状态栏额度监控（未展开验证）。 |

**注意**：`zenmux-builder` 只是第三方插件里的 plan label（`dsh-subscription-usage` 的 `id:'zenmux-builder'`），**不是 ZenMux API 的频道标识**；ZenMux 侧没有该 slug。

---

## 7. 给 magpie 插件的实现建议

1. **Sign-in 方式（推荐顺序）**
   - **A. API Key（主）**：`auth.methods` 用 `{type:"api", label:"ZenMux Builder 订阅 API Key", placeholder:"sk-subs-…"}`，并加 prompts 让用户可选填 `Management API Key (sk-mgmt-…，用于额度显示与精确模型过滤)`；用 `authorize(inputs)` 校验 management key（`subscription/detail` 200/401/403），推理 key 只做前缀/长度校验（避免为验证产生一次 Flow 消耗）。sub成功后保存为 `{type:"api", key: sk-subs…, metadata:{managementKey}}`（magpie 会保留多余字段）。
   - **B. OAuth（可选，后做）**：照抄 `@zenmux/opencode-oauth` 的 PKCE + loopback callback；需先向 support@zenmux.ai 注册 magpie 的 OAuth client（或开发期用 `/oauth/register` 动态注册）；配 `auth.refresh`（`refreshLead: 120000`）。OAuth 账户仍需 prompt 一个 `sk-mgmt-…` 才能显示额度（management 接口拒绝 OAuth token，文档明示）。
   - 不建议只依赖控制台 cookie；不要复用其他产品的 client ID 作为生产方案。
2. **baseURL / loader**：provider id 建议 `zenmux`，`api` 按模型选择：
   - 默认 `@ai-sdk/openai-compatible` + `https://zenmux.ai/api/v1`；
   - Anthropic 模型（想用 prompt caching/thinking）用 `@ai-sdk/anthropic` + `https://zenmux.ai/api/anthropic/v1`，并确保 magpie loader 发 `x-api-key`（magpie 对 anthropic 默认发 `x-api-key`；实测 Bearer 也被 ZenMux 接受）；
   - Vertex 模型用 `https://zenmux.ai/api/vertex-ai`；
   - 推理请求的模型 id 用 `provider/model` slug。
3. **provider.models 钩子（按账户）**
   - 拉公开富目录 `https://zenmux.ai/api/frontend/model/available/list`（官方 opencode 插件同款），按 `slug` 聚合多端点条目；用 `endpoints[].api/suitable_api` 决定协议；字段映射见 §3.3。
   - 过滤：若 metadata 里有 managementKey → 调 subscription/detail 取 `plan.tier` → 调公开 `get_all_plans` 取该 planKey 的 `models[].model_slug` 集合 → 过滤；否则用 sign-in 时用户选的档位或付费档并集（并在返回的模型上标记 `free`/cost）。
   - 失败时返回上次缓存（magpie 会保留旧列表），不要返回空列表覆盖。
4. **auth.usage**：§4.3 映射；请求只用 `Authorization: Bearer <managementKey>` 调 `https://zenmux.ai/api/v1/management/subscription/detail`；5h/7d 两个窗口 + monthly display，`resets.count = remaining_resets`。Windows 的 `used` 必须是百分比（0–100）。
5. **fetch 错误处理**：识别 `403 access_denied (api_key_source: …)` → 标 `signIn:"expired"`；`404 model_not_available` → 模型级失败（让网关 failover，不要标账户）；`402 quote_exceeded` → 账户额度用尽（可让网关切账户/模型）；`429` → 按网关默认退避；`X-ZenMux-RequestId` 可记录日志。
6. **headers**：推理请求加 `HTTP-Referer`/`X-Title`（可选，标识 magpie）；如有会话 id 可加 `x-zenmux-session-id`；Anthropic 协议加 `anthropic-version: 2023-06-01`。
7. **不要实现 auth.checkin**（无接口）。

---

## 8. 仍未证实 / 需真 Key 才能确认

1. **`sk-subs-…` 订阅 Key 是否也能调用 `/api/v1/management/subscription/detail`**：文档明确“只接受 Management Key”，我们的无 Key/假 Key 探测无法区分（假 Key 一律 403 Invalid）。建议按文档：额度必须 `sk-mgmt-…`。反向：`sk-mgmt-…` 能否用于推理未证实（chat 探测中 `sk-mgmt-fake` 被归类为 `api_key_source: payg`，暗示它**不是**订阅推理 Key，大概率不能推理）。
2. **`/api/v1/models` 是否随 Management Key 返回“按计划过滤”的列表**：实测 `/api/v1/models` 完全不校验 key（无 key、假 key 都是 200 全量 219 条），因此**不能**按计划过滤；只能靠 `get_all_plans` + `subscription/detail` 自行求交集。
3. **推理 429 是否带 `Retry-After`**：仅 account-usage/account-cost 文档明确 `Retry-After: 60`（60 rpm），推理 429 未证实；管理端点平台限流为 422。
4. **401 vs 403 的稳定性**：实测/文档一致（管理端点缺 key=401，无效/旧 key=403；推理无效 key=403），但 ZenMux 文档 error-codes 里根本没有 401 条目，未来是否统一为 403 未知；插件应按“401 或 403+invalid key/api_key_source”都当鉴权问题。
5. **OAuth access token 能否调用 console 内部订阅接口**（`/api/subscription/get_current_usage`）——文档只说 management 接口拒绝 OAuth；console 接口需 cookie，未验证。
6. **免费模型是否消耗 Flow**、订阅档内 Flow 的逐请求换算（alpha/gamma/leverage 语义）未验证；插件无需计算，展示百分比即可。
7. **真实 `subscription/detail` 响应**（本环境无真 Key，仅按官方文档样例 + 第三方实现字段解析）：建议实现时对缺失字段做防御。

---

## 附录：本次保存的原始资料（均在 `.research/` 下）

- `zenmux-models.json`：`/api/v1/models` 完整响应（219 条）
- `zenmux-model-catalog.json`：`/api/frontend/model/available/list` 富目录（253 条，4.1 MB）
- `zenmux-plans.json`：`/api/subscription/public/get_all_plans` 完整响应（5 个 plan）
- `zenmux-doc-repo/`：`ZenMux/zenmux-doc` 浅克隆（源文档 markdown）
- `zenmux-opencode-plugin/`、`zenmux-dsh-plugins/`、`zenmux-skills/`、`zenmux-hermes-plugin/`：官方插件/技能源码
- `npm-pkgs/`：`dsh-subscription-usage`、`@zenmux/ai-sdk-provider`、`@zenmux/cli`、`dsh-zenmux` 解包源码
- `umi.js`：zenmux.ai 前端主 bundle（含 i18n、API 路径、Key 迁移公告、plan 文案）
- `zm-api_platform_subscription-detail.txt` 等：从 VitePress 文档页抽取的正文