# magpie 插件契约：差异清单 + 骨架要点（v0.1.3913 实测）

> 目标：给已跑通的 ZenMux 插件做“文档 vs 真实 magpie”的差异核对，只记录会写错的点。
> 版本：本机 `/home/chr/.local/bin/magpie` = **0.1.3913**（2026-11-12 构建）。
> 证据等级：
> - **[A] 本机实测**：`.research/sandbox`（独立 HOME/XDG，`MAGPIE_ADDR=127.0.0.1:3499`）里 `plugin add/login/quota/plugin --json/provider test` 的实际输出。
> - **[B] 本机二进制**：`strings` 提取 + 从二进制里还原出的 plugin host JS（`examples/recovered-host.js`，含 `internal/plugin/host.js` 原文片段）。
> - **[C] 文档**：`.research/plugins-doc.txt`（https://usemagpie.ai/docs/plugins 全文）。
> - **[D] 社区源码**：`.research/examples/src/packages/*`（magpie-community/plugins 全仓 tarball 中抽取的真实插件，MIT）。

---

## 0. 结论先行：文档没写、但会踩的 10 个点

1. **`provider.models` 返回的是“内部 Model”形状，不是 config hook 的形状。** 顶层 `reasoning/tool_call/modalities` 在 models hook 里**被忽略**；必须写嵌套 `capabilities`。[A]
2. `provider.models` 返回里的 `disabled: true` **无效**（仍会列出）；隐藏模型只能在 config hook 的 `models` 里写 `disabled: true`。[A][B]
3. `status: "deprecated"` 的模型会被 magpie 过滤掉（config 与 models hook 都是）。[A][B]
4. `provider.models(provider, { auth, signal })` 的第三项 **`signal`** 真实存在（文档没提）；`auth.usage(getAuth, provider, { signal })`、`auth.loader(getAuth, provider)` 同理。[B][A]
5. `x-magpie-*` 请求头（`x-magpie-fallback`、`x-magpie-work-dir`、`x-magpie-session`、`x-magpie-effort` 等）**会出现在插件 fetch 收到的 `init.headers` 里**，转发给厂商前必须删掉。[A][B]
6. `api` 方法 `authorize()` 返回的 `accountId` **不会被保存**；API key 账号只能靠 `metadata.email` 命名，账号名规则是 `accountId ?? metadata.email ?? email`。[A][B]
7. `keyless: true` 只在 `type:"api"` **且存在 `authorize` 函数**时生效；而 `type:"api"` + `prompts` + `authorize` 时 magpie 自己就不会再要 key（host 里叫 `keyAsked`），两种机制叠加不冲突。[A][B]
8. API key 账号第一次存 `plugin-auth.json` 的键是 provider id；再登录不同账号是 **`id#` + 6 位 base36**（如 `acmep#0ibkrd`），不是文档里的 `id#xxxxxx` 字面 6 个 x，但位数一致。[A][B]
9. `auth.options`（provider 编辑器开关）真实可用，但文档没列：`[{key,label,description,default,confirm,labels,descriptions,confirms,filtersModels,placement}]`，最多 16 个，`key` 是 `[a-z0-9_-]{1,40}`；用户值存在 `settings.json` 的 `pluginOptions.<providerId>`，不在 `plugins.json`。[A][B]
10. `magpie plugin` 遇到坏插件不报错退出：`plugin add` 打印 `failed: …`、**exit 0**；`plugin --json` 的 `loaded[].error` 才有堆栈。Bun 首次下载失败也一样 exit 0。[A]

---

## 1. 包结构与入口（与文档一致处从略）

**入口查找顺序**（[B] `entries()`，与 [C] 一致）：

1. `package.json.exports["./server"]`（字符串，或 `{import|default}`）
2. `package.json.main`
3. `package.json.exports["."]`
4. `package.json.exports` 为字符串时
5. 目录下 `index.ts`、`index.tsx`、`index.js`、`index.mjs`、`index.cjs`
6. 传入的是文件路径 → 该文件

每个候选文件依次 `import`，**第一个能导出插件函数的文件生效**，后面的不再看。实测：`main` 指向 v1 插件、`exports["."]` 指向 OpenCode2 的 `{id, setup}` 时，加载的是 `main`；`exports["./server"]` 存在时优先于 `main`。[A]

TypeScript：`index.ts` 直接跑（Bun），实测默认导出 `{id, server}` 正常加载。[A]
真实包 `packages/minimax` 同时给 magpie 与 OpenCode 2.x：`"exports": {"./server": "./magpie.mjs", ".": "./opencode2.mjs"}`，`main: "./opencode.mjs"`（v1）——要兼容 OpenCode 2.x 时照抄这个三件套。[D]

**导出形状**（[B] `servers()`）：

- `export default { id, server }`：`server` 必须是函数。default 对象里只要有 `server`/`id`/`tui` 任一键，就按 v1 模块解释；此时只取 `d.server`，没有就**一个插件都不算**。
- 否则：模块的**每个导出函数**都当插件调用；导出对象若含 `server` 函数，也取它。
- 所以 `_internal` 必须是**普通对象**（不是函数）才安全；helper 不要单独 export 成函数。

**package.json 字段**：

| 字段 | 必需 | 说明 / 限制 |
|---|---|---|
| `name` `version` `type:"module"` | 是 | npm 名；`main`/`exports` 指向 ESM |
| `main` / `exports["./server"]` / `exports["."]` | 至少一个 | 见上 |
| `keywords` | 建议 | 搜索要求 name/keywords 含 `opencode` 且含 `auth`/`plugin`/`provider`；社区包习惯 `["opencode","opencode-plugin","magpie", "<vendor>", "opencode-auth","opencode-provider"]` |
| `magpie.icon` | 可选 | `https://` 或 `data:image/`；字符串 ≤ 1.5 MB（`3<<19`），超了丢弃 |
| `magpie.name` | 可选 | 一行 ≤ 80 bytes，仅社区列表没给名字时用于 Installed 行/侧栏 |
| `magpie.summary` | 可选 | `{en,zh,…}`，每语言一行 ≤ 300 bytes |
| `magpie.maxConcurrency` | 可选 | 整数 1–1000；用户/provider 设置优先 |
| `magpie.maxAccounts` | 可选 | 文档没列，host 支持：同时用几个账号，1–1000 |
| `magpie.options` | 可选 | provider 开关默认值（`pluginOptions` 为空时编辑器起点） |
| `magpie.hooks` / `middleware` / `agent` / `page` / `panels` / `permissions` | 可选 | 非 provider 插件路线，本 spec 不展开 |

`auth.icon` / `auth.maxConcurrency` / `auth.maxAccounts` **覆盖** package.json 同名项。[A][B]

目录布局（建议，照社区）：

```
opencode-zenmux-auth/
  package.json          # name/type/main/files/keywords/magpie
  index.mjs             # 唯一插件导出 + export const _internal = {...}
  index.test.mjs        # bun test，只测 _internal
  README.md             # 登录方式、凭据存哪、模型列表
  LICENSE
```

---

## 2. config hook（模型声明层）

`config: async (cfg) => {}`，`cfg.provider ??= {}`；同一个 provider 的 entry 会先被“恢复”成用户配置（或该插件上次的产物）再调用，所以：

```js
// 文档写法：provider 不该被覆盖
cfg.provider ??= {}
cfg.provider[PROVIDER] ??= { name, npm, api, models: {…} }
```

两种真实变体（[D]，值得照抄）：

- 需要给已有 provider（models.dev 已列该 id）补默认值时，`??=` 什么都不做，要用**分层**：
  ```js
  const p = (cfg.provider[ID] ??= {})
  p.name ??= "ZenMux"; p.npm ??= "@ai-sdk/openai-compatible"; p.api ??= API
  p.models = { ...seedModels(), ...(p.models ?? {}) }
  ```
  （sensenova 的写法；Cline 用 `const was = cfg.provider[ID] ?? {}; cfg.provider[ID] = { defaults, ...was, models: { ...defaults, ...(was.models ?? {}) } }`）
- 多个插件签同一个 provider 时，各自 config hook 的 provider entry 会被隔离恢复，按加载顺序执行，“最后一个 auth hook 赢”。[B]

config hook 里模型支持**顶层**字段（文档 + [B] `info()` 一致）：

`id, name, provider:{npm,api}, api:{npm?,api?}, limit:{context,input?,output}, reasoning, tool_call, modalities:{input[],output[]}, cost:{input,output,cache_read,cache_write}, variants:{…}, free, rate ("x0.5"|0.5), rateWas, serviceTiers, decides, searches, disabled, temperature, headers, options, release_date, status`

- `cost` 单位：**US$/百万 token**；订阅套餐可以不写。
- `rate` 字符串 `"x0.5"` 会归一成 0.5；0 表示“没给”，不是免费。
- **免费只能用 `free: true`**，不要从 rate 推。
- `provider.decide: true` + `model.decides: true` = System One 分类模型；`provider.searches: true` = 厂商自带联网搜索。
- `disabled: true` 只在 **config** 的 models 里生效。[A][B]
- `npm` 决定协议：`@ai-sdk/anthropic` → `/messages`；`@ai-sdk/openai`/`azure` → `/responses`；`@ai-sdk/google` → Gemini；其它（含 `openai-compatible`）→ `/chat/completions`。ZenMux 若是 OpenAI 兼容，用 `@ai-sdk/openai-compatible`。
- base URL 优先级：**loader `baseURL` > model `provider.api` > provider `api` > SDK 默认**。

models.dev 合并行为（[B] `info()` 实测）：provider id 若在 models.dev 里，magpie 先放它的 name/npm/api/models；再叠加 config 的 models（同 key 合并字段，`api.id` 默认 key，`api.url` 默认 provider api，capabilities 默认 `temperature:toolcall:input.text:output.text=true`）。**provider id 冲突时这一合并会额外塞进厂商模型**（见 §5）。[A]

**ZenMux 特别情况（实测）**：models.dev 里已经有 `zenmux` 条目（`name: "ZenMux"`、`npm: @ai-sdk/openai-compatible`、`api: https://zenmux.ai/api/v1`、约 110 个模型）。所以不需要在 config hook 里手写全量模型；config 的 `??=` 不会覆盖它，models hook 收到的 `provider.models` 已含这批模型。沙箱探针带假 key 请求 `https://zenmux.ai/api/v1/models` 返回 200（约 219 条），说明列表接口公共可读；agent 侧 id 实测就是 `zenmux/<model>`，**没有** `zenmux-plugin` 重命名。[A]

**ZenMux `/api/v1/models` 真实 payload（实测，假 key 也 200，219 条）**：字段与 OpenAI 常见写法不同，映射时别猜：

```json
{ "id": "google/gemini-4-hydrogen", "object": "model",
  "display_name": "Google: Gemini 4 Hydrogen", "created": 1794541125, "owned_by": "google",
  "input_modalities": ["file","image","text","video","audio"], "output_modalities": ["text"],
  "capabilities": { "reasoning": true }, "context_length": 1048576, "max_tokens": 65536,
  "pricings": {
    "prompt":             [{ "value": 1.5,  "unit": "perMTokens", "currency": "USD" }],
    "completion":         [{ "value": 7.5,  "unit": "perMTokens", "currency": "USD" }],
    "input_cache_read":   [{ "value": 0.075,"unit": "perMTokens", "currency": "USD" }],
    "input_cache_write":  [{ "value": 1.875,"unit": "perMTokens", "currency": "USD" }],
    "web_search":         [{ "value": 0.014,"unit": "perCount",   "currency": "USD" }] },
  "publish_time": "2026-11-13" }
```

映射到内部 Model：`display_name→name`、`context_length→limit.context`、`max_tokens→limit.output`、`capabilities.reasoning→capabilities.reasoning`、`publish_time→release_date`；`pricings.*[0].value`（unit 为 `perMTokens`）→ `cost.input/output/cache.read/cache.write`；`input_modalities` 里的 `file` 对应 magpie 的 `pdf`。`web_search` 是 perCount，不是 token 价，别塞进 cost。`skeleton/index.mjs` 已按此实现并在沙箱验证（219 模型、价格/上下文/推理/模态均正确显示）。

---

## 3. auth hook（登录 + 请求 + 额度）

```
auth: {
  provider, methods[], loader(getAuth, provider), usage(getAuth, provider, {signal})?,
  refresh(auth, provider)?, refreshLead?, rotating?, keepAlive?, checkin(getAuth, provider)?,
  calls(getAuth, provider, {since, signal})?, icon?, maxConcurrency?, maxAccounts?, single?, options?
}
```

### 3.1 methods / prompts / authorize（精确字段）

- `api`: `{ type:"api", label, placeholder?, keyless?, prompts?, authorize? }`
  - **无 authorize**：key 原样保存 `{type:"api", key, metadata?}`，prompts 的 select 答案进 metadata（typed 答案不进，避免 secret 存两份）。
  - **有 authorize**：magpie 把 key 也交给 prompts/authorize；`authorize(inputs, {signal})` 返回 `{type:"success", key, metadata?}` / `{type:"failed", error?}`（error 会被截断到 500 字）。
  - 实测保存形状：`{type:"api", key, metadata:{…}}`；`result.accountId` 被丢弃；账号名只认 `metadata.email`（或 `email`）。[A]
- `oauth`: `{ type:"oauth", label, prompts?, authorize }`
  - `authorize(inputs, {signal})` 返回：
    `{ url, instructions, method:"auto"|"code", opened?, callback(codeOrUndefined, {signal}) }`
    或直接 `{type:"failed", error}`（不必等 callback）。
  - `method:"auto"`：callback 自己等出结果；`"code"`：callback(用户粘贴的 code)。
  - callback 成功：`{type:"success", refresh, access, expires(ms), accountId?, uid?, email?, provider?, …自定义字段}`；也接受只有 `access`（会以 `refresh:""` 保存）。
  - 保存：`{type:"oauth", refresh, access, expires, ...其它字段原样}`；`provider:"other-id"` 存到另一个 provider 的新账号。
  - `opened:true` = 插件自己已经打开页面，magpie 不再打开第二遍（Grok CLI 场景，文档没写）。[B]
- prompts：`{ type:"text"|"password"|"select", key, message, placeholder?, options?, when?, condition?, validate?(v)=>"错误文字"|undefined, required?, labels?, messages? }`
  - `password` 是 magpie 自有类型（masked）；OpenCode 只有 text/select。
  - `select.options[] = {label, value, hint?, labels?, hints?}`。
  - `when: {key, op:"eq", value}`：host 只实现 eq；**op 非 "eq"（含未写）被当作“不等”**。`condition(inputs)` 是函数版。
  - `required:false` 在 0.1.3913 的 host prompt RPC 里没有读取（仍会问、可空）；别依赖它。
  - 还有一个未文档化的 `method.ask(inputs)` 自定义提问（pi 用），provider 插件不需要。
- `auth.single: true`：每次新登录合并到唯一账号；`auth.maxAccounts`：限制同时使用的账号数。

### 3.2 loader / fetch（请求契约）

`loader(getAuth, provider)` 每账号每登录态跑一次，返回 `{baseURL, apiKey, headers, fetch}`（可缓存）：

- `apiKey` 省略时，API key 登录默认用保存的 key；SDK 头：Anthropic `x-api-key`、Google `x-goog-api-key`、其它 `Authorization: Bearer`。
- `fetch(input, init)` 收到完整 URL、`POST`、JSON 字符串 body（非 UTF-8 时 bytes）、`init.signal`（agent 取消）。
- **header 覆盖顺序**（后者覆盖前者）：SDK key 头 → loader.headers → gateway 请求头 → `chat.headers` 钩子。实测 [A]：`authorization: Bearer <key>`、loader 的 `x-loader-header`、chat.headers 的 `x-chat-headers` 同时在；还带 **`x-magpie-fallback: 1`**。
- 必须转发返回 `Response`；流式重写 body 时删 `content-length`/`content-encoding`。
- **magpie 专用请求头**（插件可见、必须不发给厂商）：`x-magpie-fallback`, `x-magpie-work-dir`, `x-magpie-work-git`, `x-magpie-session`, `x-magpie-subagent`, `x-magpie-effort`。[A][B]
- `provider test <id>` 的请求体实测：`{"model":"<api id>","messages":[{"role":"user","content":"hi"}],"max_tokens":16,"stream":true}`；chat.headers 也会被调用（sessionID 为空）。[A]

### 3.3 401 / X-Magpie-Sign-In（回答 Lead 的问题 2）

- `X-Magpie-Sign-In` 响应头**确实被 gateway 读取并消费**（二进制里有 header 名与处理逻辑；host 把响应头原样送出，Go 端在转发给 agent 前删掉）。大小写不敏感；插件用小写 `x-magpie-sign-in` 即可。[B]
- 取值：`expired` = 登录被拒（任意状态码，包括 403/502）；`kept` = 别动账号状态（例如与 token 无关的 401）；`renewed` = 已续期，清标记。
- **403 本身不会被当作 sign-in 问题**：默认只是普通失败/换账号；文档明确“模型不可用时回 403/404 并带厂商原话，不要 401”。所以 403 + 明确 key 无效时，加 `x-magpie-sign-in: expired` 才能标记账号；若 403 是“模型不支持”，**不要**加 expired，否则会把正常账号标成掉线。[C][A]
- 裸 401 且是 OAuth、access 未过期：host 会自行补 `x-magpie-sign-in: kept`（避免误标），插件已给的 header 不会被覆盖。[B]
- 从 `fetch` 或 `provider.models` **throw** `Object.assign(new Error(...), {signIn:"expired"})` 同样生效；host 会发 `signIn` 事件，Go 标记账号。[B][A]（实测 usage 返回 `signIn:"expired"` 后 `magpie accounts --json` 出现 `lapsed` 文案）
- 账号被标记后：quota 卡片显示原因、路由停止使用该账号；重新登录清除。

**建议给 fetch 的判定**：401 → 先看 body 是否 token/key/sign-in 语义，是则 expired；403 → 仅当 body 命中 `invalid|expired|revoked|unauthorized|key|token` 才 expired，否则原样透传（模型不支持）。这与 cline 的 `lapsed()` 正则思路一致（[D] cline/index.mjs:225,618）。

### 3.4 usage hook（单位已由 Lead 实测；这里补规范化细节）

`auth.usage(getAuth, provider, {signal})` 返回（全部可选）：

```
{ plan, user, until, renew:"auto"|"off", balance, error, signIn:"expired"|"kept"|"renewed",
  resets:{count, until?, byWindow?, fiveHour?, weekly?, team?, each?:[{until?,window?}]},
  windows:[{ name, used, resetsAt, resetSecs, display, amount, limit, unit, span,
             model, models[], notModels[], family, pool, aside, runsOutAt, runsOut, balance }] }
```

**单位/规范化**（[B] host `usageOf` 实测 + [A] `magpie quota`）：

| 字段 | 真实语义 | 写错会怎样 |
|---|---|---|
| `used` | **百分比 0–100**（小数可以；>100 允许=超支） | 写 0–1 会显示 0.37%；**非 number（如 `"37"`）被当 0**；省略 ≠ 0 |
| `resetsAt` | ISO 字符串或 epoch **秒/毫秒**；host 统一转 ISO（<1e11 视为秒） | 不合法字符串 → 丢弃（quota 显示“reset time passed”） |
| `resetSecs` | 从现在起的**秒**；host 会换算成 resetsAt | 写毫秒会变成很远的未来 |
| `span` | 窗口时长**秒**（5h=18000，7d=604800，Copilot 月=2592000） | 只影响 `quota history` 推算 start，不影响百分比 |
| `amount`/`limit`/`unit` | 窗口自己的计数；`used` 省略时用 `amount/limit` 推百分比；`unit` 如 `"credits"`/`"requests"` | 有 amount/limit 无 used 时 CLI 实测显示 370/1000 = 37% |
| `display` | 原样展示（可带 count） | 只有 display 没有 used/amount/limit 时是“只显示”窗口，不参与路由 |
| `balance`（window） | 预付钱包剩余（unit 单位），无 total；配 `aside:true` 展示 | 会被当作“份额未知”而非 0 |
| `model`/`models`/`notModels` | 窗口只统计哪些模型；`model` 是 id 子串，`models` 精确列表，`notModels` 排除 | 不写=计所有模型 |
| `family`/`pool` | 模型家族/共享额度的池；卡片用 pool 的窗口替代各模型窗口 | — |
| `aside` | true：用尽不影响账号（路由不读） | 该关而不关会让路由过早放弃账号 |
| `runsOutAt`/`runsOut` | 最早过期时间点 / 会损失多少 | — |
| `plan`/`user`/`until`/`renew` | 套餐名/厂商侧账号名/套餐结束/renew 语义 | `user` 显示为 alias，账号名另算 |
| `error` | 显示在窗口位置 | 有 error 时 windows 可空 |
| `signIn` | 本次读取对登录态的含义 | 无 signIn 时：错误含“重新登录”会标记，干净读取会清标记 |

CLI 实测解读（[A]）：
- `magpie quota` 文本：`provider · plan · renews/expires <until> · <alias> (<account>)  subscription  5h 38% · 7d 12% ↻23h59m …`
  - `%` = **used 百分比**（不是剩余）；`↻` = resetsAt；`reset time passed` 表示 resetsAt 已过去；
  - 只有 display 的窗口原文显示、无百分比；`aside` 窗口也显示。
- `magpie quota --json` 额外给 `remaining`、`text:true`（只显示窗口）、`spent/spentSince`（balance 窗口）、`holdsWhy`（路由内部权重），以及 `alias`（=usage.user）与 `user`（=账号名）。这些是 CLI 派生字段，插件不要依赖。
- `GET /v1/magpie/quotas`、statusline、卡片都读同一份；`quota history` 用 `span` 反推窗口起点。
- **不要**给未知的窗口发 `used: 0`；给 `display` 或干脆省略窗口。字符串数字一律被丢成 0。[A][B]

---

## 4. provider.models（回答 Lead 的问题 1）

签名（[B] host `info()`；文档只写 `models(provider, {auth})`）：

```js
provider: {
  id: "zenmux",
  async models(provider, { auth, signal } = {}) { … }
}
```

- `provider` 是 **deep clone 的内部 provider**：`{id, name, source, env, options, npm, api, decide, searches, models}`；`models` 以 key 为索引，值是**内部 Model**（见下）。
- `auth` 是该账号保存对象的副本：`{type:"api", key, metadata?}` 或 `{type:"oauth", refresh, access, expires, …}`；无账号时可能为空/未登录（不会调用）。
- 每个账号各调一次（账号 scope + 该账号 proxy），账号只服务它列出的模型。
- 返回值：**key→内部 Model**，key 会成为模型 id（host 会补 `id:key, providerID`）。

**内部 Model 形状（models hook 的正确返回；[A] 实测）**：

```js
{
  id, name,
  api: { id, url, npm },                    // url 空则由 base 优先级兜底
  limit: { context, input?, output },
  capabilities: {
    reasoning, toolcall, attachment, temperature?,
    input:  { text:true, image?:true, audio?, video?, pdf? },
    output: { text:true }
  },
  cost: { input, output, cache: { read, write } },   // US$/M tokens
  variants: { low:{}, medium:{}, high:{} },          // key = reasoning 档位
  release_date, status: "active"|"alpha"|"beta"|"deprecated",
  options?, headers?,
  // magpie 扩展（顶层，有效）：
  free:true, rate:"x0.5"|0.5, rateWas, serviceTiers:["priority",{id:"ultrafast"}],
  decides:true, searches:true, fast:true
}
```

**最容易写错**（[A] 对照实验，同一 hook 返回三种模型）：

- 顶层 `reasoning:true, tool_call:true, modalities:{input:["text","image"]}` → 列表里 `reasoning:false, image:false, inputs:["text"]`（**被忽略**）。
- 嵌套 `capabilities` → `reasoning:true, image:true, inputs:["text","image"], inputsSaid:true`（**生效**）。
- 所以：**models hook 一律返回 capabilities 形状**；config hook 才用顶层 `reasoning/tool_call/modalities`。
- 通用做法：从 `provider.models[key]` 展开再改：
  ```js
  return { ...provider.models, [id]: { ...provider.models[id], name } }
  ```
  （社区 sensenova/gumloop 的 row() 同时带顶层与 capabilities，是为了 config/models 两个 hook 复用；照抄会导致列表多塞无用字段但不算错。）
- `disabled` 在 models hook 返回值里**不生效**；`status:"deprecated"` 会被 magpie 过滤。[A][B]
- `free/rate/rateWas/serviceTiers/decides/searches/fast` 在 models hook 顶层**生效**（实测 `rate:"x0.5"`→0.5，serviceTiers 对象被归一成 id）。[A]
- **models.dev 起点**：provider id 在 models.dev 里时，models hook 收到的 `provider.models` 已经含 models.dev 的条目（合并 config 后）。实测用 `auth.provider="deepseek"` 的探针，config 只声明 1 个模型，列表出现 **3 个**（models.dev 的 deepseek 模型被并入）。用未见过的 id（`zenmux`）最干净；若冲突见 §5。[A]
- **失败语义**（三者等价，magpie 保留旧列表）：
  1. fetch 失败后 `return provider.models`（host 通过自己的 fetch 包装器记录 `tried/lastOk` 判定）；
  2. `throw`（保留旧列表，错误进日志/`listError`）；
  3. 返回自有列表并带 `list[Symbol.for("magpie.fellBack")] = true`。
  登录态被拒：`throw Object.assign(new Error(...), {signIn:"expired"})`，账号被标记，且短时间不再重复问厂商。[B][A]
- 如果账号确实没有可用模型（例如 plan 不含模型），返回 `{}` 是合法特例（sensenova 在“只登录看额度”的账号上这么做）。[D]

---

## 5. provider id 冲突 / 重命名（回答 Lead 的问题 3）

- 实测：插件 `auth.provider = "deepseek"`（被内置/预设占用）→ `magpie plugin` 列表显示 **`deepseek-plugin (DS Plugin, 3 models)`**；`magpie plugin --json` 的 `providers[].id` 仍是 **`deepseek`**；`magpie plugin login deepseek` 用原 id；agent 侧用 `deepseek-plugin/<model>`。
- 同一 id 被两个已安装插件签入时：`magpie plugin use <name> <provider>` 指定谁服务；否则后添加的赢；两者都留在 Installed，各行标注由谁服务。（文档）
- 注意区分两件事：**models.dev 有条目** ≠ **id 被占用**。`zenmux` 在 models.dev 里（这是好事：免费带目录），但它不是内置订阅/preset/magpie 自身，所以不会被改名。实测 `m plugin --json` 的 id、`m plugin` 列表、`m models` 前缀都是 `zenmux`。真正会触发 `<id>-plugin` 的是内置订阅/preset（如 `deepseek`）。[A]
- 结论：ZenMux 继续用 `zenmux` 即可；如果看到 `providers[].id` 与列表显示 id 不一致，是内部/展示 id 的差异（`deepseek` 场景），不是 bug。[A]

---

## 6. 真实社区插件里比文档更好用的做法（回答 Lead 的问题 4）

来源：`.research/examples/src/packages/`（MIT）。完整清单见 `examples/README.md`。

1. **refresh 三件套**（cline；文档只说 refresh/refreshLead）：`refreshLead`（默认 5min，host 上限 24h）+ `rotating: true`（告诉 magpie refresh token 一次性，别把登录态搬机器）+ 单飞锁。refresh 返回**只含变化的字段**，magpie 会合并到旧对象（实测 host `{...was, ...fields, type:"oauth"}`），允许返回 `undefined` 表示“没得续”。`signIn:"expired"` 让 magpie 永久标记，其他错误 30s 后重试。
2. **API key + prompts + keyless**（gumloop）：`keyless:true` 跳过 magpie 自己的 key 输入；authorize 里用 `/models` 探测 key；**typed 答案默认不进 metadata**，账号名放 `metadata.email`；可选余额/校准值也放 metadata。配额耗尽时返回 **429 + `x-magpie-sign-in: kept`**，让网关换账号而不是标记掉线（比返回 402/403 更好）。
3. **auth.options 开关**（sensenova/atomcode/minimax）：用户可关自动建 key、清旧 key、压缩工具等；`plugin options <name> '<json>'` 可脚本化，支持 `labels/descriptions/confirms` 多语言、`filtersModels`（开关会改变模型列表）、`placement:"top"`；值存 `settings.json.pluginOptions`。[A]
4. **多窗口 usage + aside**（copilot/gumloop）：`used` 百分比 + `resetsAt` ISO + `span` 秒；把“不该阻断路由”的窗口标 `aside:true`（如 completions、赠送额度）；余额窗口用 `balance`+`unit`；错误信息不塞 token/body，且 `signIn` 明确给 `kept/renewed/expired`。
5. **oauth `method:"code"` + 本地回调**（raccoon/sensenova）：`method:"auto"` 时插件可开本地 127.0.0.1 回调或自己开浏览器（`opened:true` 防开两次）；`"code"` 时 callback 支持“粘贴整段回调 URL 或原始 token”，解析失败返回 `{type:"failed",error}`。
6. **`provider.warming()`**：只存在于 OpenCode2 shim 的适配层（`opencode2.mjs`），v1 host 不调用；不要在 magpie provider 里指望它。
7. **icon**：`auth.icon` 优先于 `magpie.icon`（实测）；可内联 `data:image/png;base64,…`（社区 joycode/raccoon 整块内嵌）。
8. **`auth.calls`**：未文档化但 host 支持，把“厂商自己客户端用的额度”记进 magpie Usage（`{rid,t,model,in,out,cache_read,cache_write,cost,session}`）；ZenMux 若有用量 API 可考虑，但不是首版必需。

---

## 7. 沙箱 recipe（可粘贴，Lead 已验证可跑）

```sh
SB=/home/chr/magpie-plugin/.research/sandbox
m() { env HOME=$SB/home XDG_CONFIG_HOME=$SB/home/.config XDG_CACHE_HOME=$SB/home/.cache \
        BUN_INSTALL=$SB/home/.bun MAGPIE_ADDR=127.0.0.1:3499 /home/chr/.local/bin/magpie "$@"; }
m plugin add /home/chr/magpie-plugin/opencode-zenmux-auth </dev/null
m plugin --json                     # providers/methods/models/loaded[].error
m plugin login zenmux              # api: 每题一行 stdin 即可；password 不回显
m plugin                            # 行尾 "failed: …" 即加载错误
m provider test zenmux             # ✗ chat 403 · <body>  / ✓ chat 7 ms · model
m quota                             # usage hook 文本；--json 给脚本
m quota history zenmux --days 1 --json
m statusline zenmux
m plugin options zenmux '{"…":true}'
m plugin logout zenmux
```

实测环境细节：

- Bun：首次 `plugin add` 自动下载 **Bun 1.4.2** 到 `~/.cache/magpie/bun/`，来源 `https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64-baseline.zip`；可用 `MAGPIE_BUN` 指定现成 bun。[A][B]
- 离线/代理坏：`plugin add` 仍把插件写进 `plugins.json`，打印 `magpie: downloading Bun …: proxyconnect … connection refused`，**exit 0**；后续 `magpie plugin` 同样报这行、不列 provider。CI 里别只看 exit code。[A]
- 宿主机错误：插件 `console.log/process.stdout` → stderr，行前缀 `plugin:`；`plugin --json` 的 `loaded[].error` 有堆栈；`plugin` 列表行尾 `failed: <msg>`。`plugin add` 对“没入口文件”给 plain 错误，对模块抛错给堆栈。[A]
- npm 安装：`plugin add @magpie-community/opencode-zen-free-auth` 装到 `~/.config/magpie/plugins/`（Bun 工程：`package.json`/`bun.lock`/`node_modules`），`plugins.json` 记录 `"spec":"<pkg>@latest"`；列表显示 spec 名。[A]
- 沙箱证据文件：`sandbox/plugin-json.json`、`sandbox/quota-out.json`、`sandbox/offline-bun-error.txt`、`sandbox/recipe.sh`、`sandbox/magpie-strings.txt`（二进制 strings，216k 行）。[A]

---

## 8. 发布/上架（与文档一致，补社区实操）

- npm 名（社区包）：`@magpie-community/opencode-<name>-auth`；自己的仓库用 `opencode-<name>-auth` / 任意作用域，registry 条目 **不加** `"community": true`，不会出现在 community 分区，搜索按 name/summary/publisher 命中。
- registry.json 条目（provider）：`{ "package", "name", "icon", "providers":["zenmux"], "community":true, "summary":{"en","zh"} }`；图标可以是 magpie 内置图标名（如 `"copilot"`）或 https/data URI。条目 schema 实测：`package,name,icon,providers,community,kind,replaces,summary`。
- GitHub：仓库打 **`magpie-plugin`** topic → Discover→Unofficial；`package.json` 必须在仓库根；npm 发布时 `repository` 指向该仓库，否则从仓库现状安装（加载文件必须已提交，dist-only 会被跳过）。
- `MAGPIE_PLUGIN_MARKET=<url>` 指向另一份列表；`=off` 用内置副本。社区包自动更新（启动后不久 + 每小时），自发布包显示更新点。
- 发布机制：社区仓 `packages/<name>` + 版本 bump push main → GitHub Actions 先上 `dist` 分支（`tgz/<file>` + `index.json` + sha512，magpie 0.1.1243+ 从这装），再尽力 npm trusted publishing；新包不需要等 npm。
- README 必须写：登录到哪个服务、怎么登录、凭据存哪、有哪些模型。
- 频道唯一性：同 channel（vendor 服务）已有条目时，新包必须在 PR/README/summary 三处说明差异，否则不合并。

---

## 9. 套到 ZenMux 的 checklist

1. id 用 `zenmux`：models.dev 已有该条目（~110 模型 + 正确 npm/api），不是内置/preset，所以不会改名、还能白拿目录；先在沙箱 `m plugin --json` 确认 `providers[].id === "zenmux"`、`m models | grep zenmux` 前缀正确。
2. 协议选 `@ai-sdk/openai-compatible`（除非 ZenMux 的订阅只走 Anthropic Messages，则 `@ai-sdk/anthropic` + `/messages`）；base 放 `provider.api` + loader 的 `baseURL`。
3. 登录：`api` + `prompts:[{type:"password",key:"key"…},{type:"text",key:"email",required:false}]` + `authorize`；`keyless:true` 可留；**账号名只能靠 `metadata.email`**（`result.accountId` 对 api 方法无效）。
4. key 探测：authorize 里打 `/models`；401/403 → `{type:"failed",error}`；网络错误也 failed 但提示重试。
5. fetch：删 `x-magpie-*`；401/403 按 body 语义决定是否加 `x-magpie-sign-in: expired`；其余错误原样透传（模型不支持不要 expired）。
6. models hook：只返回 **capabilities 形状**；从 `provider.models` 展开；失败 `return provider.models`；登录被拒 `throw {signIn:"expired"}`；`disabled` 放 config hook；deprecated 会自动隐藏。
7. usage：`used` 百分比 0–100；`resetsAt` ISO；`span` 秒；窗口名用 `"5 hours"`/`"7 days"`；未知就不发 used、只给 display；`signIn:"kept"` 明确写；若 ZenMux 无公开用量接口，首版可以**不实现 usage**（插件列表 `usage:false`，quota 不显示），而不是发假 0。
8. 发布：README + registry 条目 + `magpie-plugin` topic；自发布包不加 `community`。
9. 用 `bun test` 测 `_internal`（不要 export helper 函数）；CI 至少跑 `m plugin --json` + `m provider test zenmux`。

---

## 10. 证据索引

| 文件 | 内容 |
|---|---|
| `.research/plugins-doc.txt` | 官方文档全文（[C]） |
| `.research/examples/recovered-host.js` | 从本机二进制 strings 还原的 plugin host JS（[B]，含 host.js 的 methods/prompts/usage/checkin/save/account/info/entry 原文；尾部混入无关嵌入数据，只读前 ~3000 行） |
| `.research/sandbox/` | 探针插件、逐次实测输出、Bun 离线错误、recipe.sh |
| `.research/examples/src/packages/` | 真实社区插件源码（gumloop/cline/sensenova/copilot/zen-free/zcode/raccoon/atomcode/minimax 等） |
| `.research/examples/registry.json` | 社区 registry.json 全文（122 条，`version:1`） |
| `.research/examples/skeleton/` | 本次产出的 ZenMux 插件骨架（已在沙箱 `plugin add`/`login`/`plugin --json` 跑通） |

恢复 host.js 的方法：`strings -n 6 /home/chr/.local/bin/magpie > magpie-strings.txt`，JS 文件在 strings 里按行保存；`grep -n "function methods\|function usage\|listing"` 定位后截取 200214–203465 行。Go 结构标签也可直接检索（如 `json:"resetsAt"`、`json:"keyless,omitempty"`、`json:"rotating,omitempty"`、`json:"serviceTiers,omitempty"`），用于交叉验证 host 字段。