# opencode-zenmux-auth

[中文说明](docs/zh-CN.md) · [Windows install](docs/windows.md) · [Research notes](docs/research)

A provider plugin for [magpie](https://usemagpie.ai) (and OpenCode): **ZenMux's Builder Plan**.

It signs in with a ZenMux subscription API key, serves the plan's models through
ZenMux's OpenAI-compatible API, and — with a second, optional Management API key —
shows how much of the plan is left: the rolling 5-hour and 7-day **Flows** windows,
their reset times, the monthly cap, and the remaining bonus window resets.

```
zenmux · Builder Pro · until Dec 14 · you@example.com  subscription
  5h 10% (5.19 / 50 Flows) ↻3h42m  7d 2% (5.19 / 213 Flows) ↻6d22h
  monthly 914 Flows/month   ↺ 3 five-hour resets until Dec 14
```

## What ZenMux needs from you

ZenMux renamed its key prefixes on **2026-11-10**; the docs and many blog posts still
show the old ones. Current keys look like:

| Key | Prefix | Where | Needed for |
| --- | --- | --- | --- |
| Subscription API key | `sk-subs-…` | [zenmux.ai/platform/subscription](https://zenmux.ai/platform/subscription) | chat / requests |
| Pay-as-you-go API key | `sk-payg-…` | [zenmux.ai/platform/pay-as-you-go](https://zenmux.ai/platform/pay-as-you-go) | same API, credits instead of Flows |
| Management API key | `sk-mgmt-…` | [zenmux.ai/platform/management](https://zenmux.ai/platform/management) | **the quota** (`/management/subscription/detail`) |

Old `sk-ss-v1-…` / `sk-ai-v1-…` / `sk-mg-v1-…` keys were disabled that day; the plugin
tells you so if you paste one.

The Free plan has **no API access** (Studio Chat only) — sign in with Starter/Pro/Max/Ultra.

## Install

```sh
# from the GitHub repository (magpie fetches it with Bun)
magpie plugin add github:Hara602/magpie-zenmux

# or from a clone / downloaded folder, for development
magpie plugin add .

magpie plugin login zenmux        # asks for the subscription key, the management key (optional), an email (optional)
magpie quota                      # 5h / 7d Flows, monthly cap, resets
magpie provider test zenmux       # one tiny chat request
magpie plugin --json              # what the plugin lists: models, usage, sign-in
```

From npm once published:

```sh
magpie plugin add opencode-zenmux-auth
```

In the app: **Plugins → Add a plugin**, point it at the folder (or name), then sign in
from the provider's row.

## What it does

- **Provider `zenmux`** — agents reach models as `zenmux/deepseek/deepseek-v4.1-flash`,
  `zenmux/openai/gpt-6.1-terra`, … ZenMux's models are namespaced `<vendor>/<model>`,
  so the model id itself carries a slash; that is expected.
- **Models** — for a model `models.dev` knows, the row is `models.dev`'s answer: name,
  limits (context / input / output), modalities, capabilities, price, release date and
  the reasoning levels `models.dev` lists for that model. The plugin asks ZenMux's
  public `GET /api/v1/models` (219 chat/image/video/audio models); the live catalogue
  fills only what `models.dev` leaves unsaid, plus every model `models.dev` does not
  know (those get the plugin's three fallback levels, low / medium / high). Since 0.1.6
  the levels come from magpie's own `models.dev` snapshot (the file `magpie sync` names,
  `~/.cache/magpie/models.json` on every platform; read-only): no extra download, and
  nothing is sent anywhere. A snapshot that is
  missing, unreadable, or older than models.dev's level names falls back to the live
  catalogue and the three levels. Only the models **your plan serves** are listed,
  because a model outside the plan answers `403`:
  - the plan is read from the Management API key's `subscription/detail` → `plan.tier`
    (`free` / `starter` / `pro` / `max` / `ultra`);
  - the plan's model list comes from the public
    `GET /api/subscription/public/get_all_plans`;
  - without a Management API key (or with `options.plan` unset) every chat model is
    listed. Set `options.plan` to filter anyway — see *Options*.
- **Requests** — `auth.loader` signs each request with the subscription key. On
  streamed chat completions it asks for `stream_options.include_usage`, and it strips
  every `x-magpie-*` header (fallback markers, work dir, session ids) so local paths and
  magpie's internals never go to ZenMux.
- **Sign-in state** — ZenMux answers a dead key with `403 access_denied` (not `401`),
  which magpie would otherwise read as "this model refused". The plugin inspects the
  body and adds magpie's `x-magpie-sign-in: expired` header / `signIn` field only when
  the words are about a key, never when they are about a model.
- **Quota** — `auth.usage` maps `GET /api/v1/management/subscription/detail`:

  | ZenMux | magpie |
  | --- | --- |
  | `quota_5_hour.usage_percentage` (0–1) | `windows[5 hours].used` (× 100, 0–100) |
  | `quota_5_hour.used_flows` / `max_flows` | `amount` / `limit`, `unit: "Flows"`, `display: "5.19 / 50 Flows"` |
  | `resets_at` | `resetsAt` (ISO string) |
  | `span` | `18000` (5 h) / `604800` (7 d) |
  | `quota_7_day` | `windows[7 days]`, the same |
  | `quota_monthly.max_flows` | `windows[monthly]`, `aside: true`, display only |
  | `quota_5_hour.remaining_resets` | `resets.count` (5-hour window resets left) |
  | `plan.tier` / `plan.expires_at` | `plan: "Builder Ultra"` / `until` |
  | `account_status: suspended/banned` | `error`, windows hidden |

  A management key that is refused does **not** mark the chat account as expired
  (`signIn: "kept"`), because the two keys are independent.

- **How sign-in proves your key** — the model lists (`/api/v1/models`,
  `/api/anthropic/v1/models`, `/api/vertex-ai/v1beta/models`) answer `200` to *any* key, so
  they cannot test one; and every `/api/v1/management/*` endpoint answers `403` to a valid
  subscription key, because it wants a Management API key. So sign-in proves the
  subscription key with one minimal real request (`max_tokens: 1`), trying a few
  mainstream models in turn. It costs a few tokens of one Flow, and these answers all
  count as a working key: `200`, `429`/`402` (the allowance is spent) and `400`/`404`/`422`
  (the key got through; the model or body was the problem). Only `401`, or a `403` whose
  text does not name a model, is a refusal. `options.probeModel` pins the model tried.
- **No check-in** — ZenMux has no daily check-in, so the plugin implements no
  `auth.checkin`. It never writes files, never runs the vendor's CLI and sends
  requests only to `zenmux.ai` (or an override you set).

## If sign-in answers 403

ZenMux answers `403 access_denied` / "You have no permission to access this resource"
for several different situations, so the message alone does not say which. In order of
likelihood:

1. A key made **before 2026-11-10** (`sk-ss-v1-…`, `sk-ai-v1-…`, `sk-mg-v1-…`): those were
   disabled. Create a `sk-subs-…` key at <https://zenmux.ai/platform/subscription>.
2. The **Management key pasted into the first question**: the first question wants the
   subscription key, the second one the `sk-mgmt-…` key.
3. **Free plan**: it has no API access at all (Studio Chat only) — Starter/Pro/Max/Ultra needed.
4. An **organization** key without inference permission: ask the plan owner to allow the key.

`sk-payg-…` (pay-as-you-go) keys work too — they spend credits instead of Flows.

## Seeing every model in your plan

Since 0.1.4 the picker lists **every model your plan serves**, not only chat models:

```
default (whole plan): 218  (170 chat + 48 image / video / speech / embedding)
chat models only    : 169
ignore the plan     : 219  (every chat model ZenMux has, plus the non-chat ones)
```

Two switches, in Plugins → Installed → Options (*Show every model the plan serves*,
on by default; *Ignore the plan filter*, off), or from a terminal — note the name is the
**plugin folder's**, not the provider id:

```powershell
magpie plugin options magpie-plugin '{"includeNonChat": false}'   # chat models only
magpie plugin options magpie-plugin '{"allModels": true}'         # ignore the plan
magpie plugin options magpie-plugin off                           # back to defaults
```

For a plugin installed as `github:Hara602/magpie-zenmux` the folder is `magpie-zenmux`.
`magpie plugin options zenmux …` answers `no plugin "zenmux"`: `zenmux` is the provider id.

The non-chat models can be listed, but a *chat* request to one of them fails — ZenMux
refuses it, not the plugin. Turn the switch off when you only chat.

### A model that does not show up (e.g. `qwen/qwen3.8-max-0902`)

1. **Not signed in**: the list then came from magpie's bundled models.dev entry, 110 models,
   and it has **no qwen3.8 at all** (`qwen3.8-max-0902` is absent there). Since 0.1.5 the
   public ZenMux catalogue is read even before signing in (219 models), so this is gone.
2. **Not in your plan**: `qwen/qwen3.8-max-0902` is served by Starter, Pro, Max and Ultra —
   not by Free.
3. **The plan's model list moved**: ZenMux rotates them; the View dialog on
   <https://zenmux.ai/pricing/subscription> is authoritative.

Checking:

```powershell
magpie plugin --json        # signedIn, and how many models
magpie models | Select-String qwen
magpie provider test zenmux qwen/qwen3.8-max-0902
```

An agent names it `zenmux/qwen/qwen3.8-max-0902` (the model id itself has a slash). Its
`suitable_api` is `chat.completions` only, so the Responses and Anthropic native endpoints
do not serve it — magpie translates to chat, which is what agents use.

## Why the picker shows fewer models than zenmux.ai

zenmux.ai lists **219** models; the site's own count of "200+" comes from
`/api/frontend/model/available/list`, which returns one row per *endpoint* (253 rows for
those 219 models). magpie has to show models an agent can actually call, so:

| Step | Count | Why |
| --- | --- | --- |
| ZenMux catalogue (`/api/v1/models`) | 219 | everything ZenMux serves |
| → chat models only | **170** | drops 49 that output images (14), video (14), speech (6), transcriptions (6), embeddings (4), decisions (3) and reranks (2) — an agent's model picker can only chat |
| → your plan's models | **218** (default) | the whole plan: 170 chat + 48 non-chat (169 when only chat models are shown; `inclusionai/ring-2.6-1t` is in no plan) |
| before signing in | 219 | since 0.1.5 the public catalogue is read anyway (it used to be models.dev's 102, which lacks qwen3.8) |

Non-chat models are listed by default so the plan is fully visible; a *chat* request to one
of them fails at ZenMux. `includeNonChat: false` hides them.

## Which API each model is asked on

ZenMux serves one model over several protocols, and each is a different request
shape. The plugin asks each model on the best protocol it speaks, in ZenMux's own
order — the same order its official OpenCode plugin uses:

| Order | Protocol | Base | Why |
| --- | --- | --- | --- |
| 1 | Anthropic Messages (`@ai-sdk/anthropic`) | `/api/anthropic/v1` | the only protocol that carries `cache_control`, so prompt caching works |
| 2 | OpenAI Responses (`@ai-sdk/openai`) | `/api/v1` | reasoning summaries and conversation state |
| 3 | Chat completions (`@ai-sdk/openai-compatible`) | `/api/v1` | the only protocol every model speaks |

The protocol comes from ZenMux's public catalogue
(`/api/frontend/model/available/list`, each model's `suitable_api`). On the current
catalogue that is 110 chat, 80 Messages and 28 Responses models out of 218.

61 of the chat models — including `deepseek/deepseek-v4.1-flash` and
`qwen/qwen3.8-max-0902` — speak **only** chat completions, so they stay there; a
Responses-only default would have broken them.

`options.protocol`:

| Value | Effect |
| --- | --- |
| `"auto"` (default) | route per model, as above |
| `"chat"` | everything on chat completions (the old behaviour) |
| `"responses"` / `"messages"` | force one protocol; models that cannot speak it will fail |

`options.store` (default `false`): Responses keeps the conversation on ZenMux's
side (`store: true`). The plugin turns that off unless you ask for it.

Two small things it also does on the wire: it adds `anthropic-version: 2023-06-01`
to Messages requests (ZenMux requires it), and `stream_options.include_usage` to
streamed chat requests so a streamed turn still reports its tokens.

## Options

`plugins.json` options, e.g. `magpie plugin options zenmux '{"plan":"pro"}'` when the
plugin is added through the app; a folder entry can also carry `"options"`:

```json
{ "spec": "/path/opencode-zenmux-auth", "options": {
    "plan": "pro",                 // force a plan without a Management API key
    "models": ["openai/", "*/kimi-*"],  // only these (exact id, vendor/ prefix or glob)
    "exclude": ["deepseek/deepseek-v4-flash"],
    "allModels": true,             // list every chat model, ignore the plan filter
    "includeNonChat": true,        // also list image / video / audio / embedding models
    "protocol": "auto",            // auto | chat | responses | messages
    "store": false,                // Responses: keep the conversation on ZenMux's side
} }
```

## Testing

```sh
node --test test/zenmux.test.mjs          # pure helpers: usage, cost, models.dev alignment

sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache \
        MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add ./opencode-zenmux-auth
m plugin login zenmux
m quota
m provider test zenmux
```

A plugin you are writing should never touch your real magpie: the sandbox `HOME` above
keeps sign-ins, plugins and cache apart. To try the quota path without a real key, point
the plugin at a local stand-in for ZenMux:

```sh
ZENMUX_API_BASE=http://127.0.0.1:3599/api/v1 \
ZENMUX_MANAGEMENT_API_BASE=http://127.0.0.1:3599/api/v1/management \
ZENMUX_PUBLIC_API_BASE=http://127.0.0.1:3599/api m quota
```

`magpie provider test zenmux` shows `chat ✓`, `responses ✓` on real ZenMux, and
`anthropic ✗`/`gemini ✗` — that command probes `provider/api` (`…/api/v1`) for every
protocol, while ZenMux's Anthropic and Vertex endpoints live at `/api/anthropic/v1` and
`/api/vertex-ai`. Agents still use chat, so nothing is missing.

## DSH web search

DeepSeek Harness (dsh) configures its built-in `web-search-deepseek` separately from
chat. This provider plugin supplies ZenMux models, authentication and quota; it does
not configure dsh's search backend. A successful chat request does not verify native
web search.

If search reports `DeepSeek returned no web_search_tool_result blocks`, the response
lacked the structured native search block dsh requires. Plain text, links or ordinary
function tool calls do not satisfy it. Check dsh's **Plugins → Built-in plugin settings
→ Web search** for the search endpoint, and verify the configured search model.
A search routed through Magpie also
requires Magpie either to preserve upstream native search results or to execute search
through a configured search source and return those blocks. Check **Magpie's Settings
→ Models → Web search** and its **Routing** page too: a signed-in ChatGPT/Codex account
can search for a ZenMux chat model. Some dsh versions expose the search model only in
deployment configuration or request events. Choose any endpoint change yourself and
use credentials accepted by that endpoint.
See the [Windows / dsh troubleshooting steps](docs/windows.md#dsh-web-search).

## Publishing

- npm: `npm publish` (the package name above; keywords already make Plugins' search find it).
- Community listing: add an entry to `registry.json` in
  [magpie-community/plugins](https://github.com/magpie-community/plugins):

  ```json
  { "package": "opencode-zenmux-auth", "name": "ZenMux Builder Plan",
    "icon": "https://zenmux.ai/docs/favicon.svg", "providers": ["zenmux"],
    "summary": { "en": "ZenMux's Builder Plan with 5-hour and 7-day Flows.",
                 "zh": "ZenMux Builder Plan：5 小时 / 7 天 Flows 额度。" } }
  ```

  The same entry is kept in [`docs/registry-entry.json`](docs/registry-entry.json).

- Repo: <https://github.com/Hara602/magpie-zenmux>
- Or tag the repository with the GitHub topic `magpie-plugin` and it appears under
  Plugins → Discover → Unofficial.

## Related

ZenMux also ships official OAuth plugins for OpenCode (`@zenmux/opencode-oauth`),
DeepSeek Harness and Hermes Agent. They sign in through the browser and serve the model
catalogue, but none of them shows the Builder Plan's Flows: `management` endpoints
accept only a Management API key, and OAuth tokens are refused there. This plugin is
the quota side of the same subscription, over the same chat API. Don't install both for
the same provider: the one added last serves `zenmux` (`magpie plugin use <name> zenmux`
picks).

## References

- [ZenMux subscription plans](https://zenmux.ai/docs/guide/subscription.html)
- [Get Subscription Detail](https://zenmux.ai/docs/api/platform/subscription-detail.html)
- [Reasoning models](https://zenmux.ai/docs/guide/advanced/reasoning.html)
- [magpie plugin docs](https://usemagpie.ai/docs/plugins)

MIT.
