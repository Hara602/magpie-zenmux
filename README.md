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
- **Models** — magpie already has a `models.dev` entry for `zenmux`, so names, context
  windows, modalities and reasoning levels come from there. The plugin asks ZenMux's
  public `GET /api/v1/models` (219 chat/image/video/audio models) and returns the chat
  ones, merged over `models.dev`. Only the models **your plan serves** are listed,
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
  subscription key with one minimal real request (`max_tokens: 1`). It costs a few tokens
  of one Flow; a `429`/`402` still counts as a good key, because it means the key works
  and the window is spent.
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

## Options

`plugins.json` options, e.g. `magpie plugin options zenmux '{"plan":"pro"}'` when the
plugin is added through the app; a folder entry can also carry `"options"`:

```json
{ "spec": "/path/opencode-zenmux-auth", "options": {
    "plan": "pro",                 // force a plan without a Management API key
    "models": ["openai/", "*/kimi-*"],  // only these (exact id, vendor/ prefix or glob)
    "exclude": ["deepseek/deepseek-v4-flash"],
    "allModels": true              // list every chat model, ignore the plan filter
} }
```

## Testing

```sh
node --test test/zenmux.test.mjs          # pure helpers: usage mapping, cost, filters

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