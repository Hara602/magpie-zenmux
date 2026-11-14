// ZenMux Builder Plan for OpenCode and magpie.
//
// ZenMux sells a monthly Builder Plan (Starter / Max / Ultra) instead of
// pay-as-you-go credits. Chat works exactly like the pay-as-you-go API: an
// OpenAI-compatible endpoint at https://zenmux.ai/api/v1, authenticated with a
// subscription API key (prefix sk-ss-v1-). What a plain key cannot tell you is
// how much of the plan is left: that is GET /api/v1/management/subscription/detail
// and it only accepts a Management API Key (prefix sk-mg-v1-, created at
// https://zenmux.ai/platform/management).
//
// So one sign-in asks for both: the subscription key serves the requests, the
// management key lets magpie show the rolling 5-hour and 7-day Flows and the
// plan's monthly cap. The management key is optional — chat still works without
// it, the account's card just has no quota on it.
//
// ZenMux's own words:
//   https://zenmux.ai/docs/guide/subscription.html
//   https://zenmux.ai/docs/api/platform/subscription-detail.html
//   https://zenmux.ai/docs/api/openai/create-chat-completion.html

import {
  API as ZENMUX_API,
  ANY_KEY_RE,
  EFFORTS,
  MANAGEMENT_API as ZENMUX_MANAGEMENT_API,
  LEGACY_KEY_RE,
  MANAGEMENT_KEY_RE,
  PUBLIC_API as ZENMUX_PUBLIC_API,
  NPM,
  PROVIDER,
  SUBSCRIPTION_KEY_RE,
  entries,
  isChatModel,
  isObj,
  isSubscriptionKey,
  keyOf,
  managementKeyOf,
  matches,
  modelRow,
  planModelSets,
  subscriptionToUsage,
} from "./zenmux.mjs"

// The bases can be pointed elsewhere for a test or a local mock; in normal use
// they are ZenMux's own.
const API = (process.env.ZENMUX_API_BASE || ZENMUX_API).replace(/\/+$/, "")
const MANAGEMENT_API = (process.env.ZENMUX_MANAGEMENT_API_BASE || ZENMUX_MANAGEMENT_API).replace(/\/+$/, "")
const PUBLIC_API = (process.env.ZENMUX_PUBLIC_API_BASE || ZENMUX_PUBLIC_API).replace(/\/+$/, "")

const DEFAULT_MODELS = {
  // Before the first sign-in magpie needs a model list to show. models.dev
  // already knows the `zenmux` provider, so this is only a fallback.
  "anthropic/claude-fable-5.2": { name: "Anthropic: Claude Fable 5.2", reasoning: true, tool_call: true, limit: { context: 200000, output: 64000 } },
  "openai/gpt-6.1-terra": { name: "OpenAI: GPT-6.1 Terra", reasoning: true, tool_call: true, limit: { context: 1050000, output: 128000 } },
  "deepseek/deepseek-v4.1-flash": { name: "DeepSeek: DeepSeek V4.1 Flash", reasoning: true, tool_call: true, limit: { context: 1000000, output: 384000 } },
  "moonshotai/kimi-k3.1-pro": { name: "MoonshotAI: Kimi K3.1 Pro", reasoning: true, tool_call: true, limit: { context: 1048576, output: 458752 } },
}

async function fetchModels(key, { signal } = {}) {
  const res = await fetch(`${API}/models`, {
    method: "GET",
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    ...(signal ? { signal } : {}),
  })
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw Object.assign(new Error(`ZenMux answered HTTP ${res.status}`), { status: res.status })
  }
  const body = await res.json()
  const data = Array.isArray(body?.data) ? body.data : []
  return data
}

function messageOf(text) {
  try {
    const body = JSON.parse(text)
    const msg = body?.error?.message ?? body?.message
    if (typeof msg === "string" && msg.trim()) return msg.trim()
  } catch {
    // not JSON
  }
  return String(text ?? "").trim().slice(0, 200)
}

// checkSubscriptionKey proves a subscription key is live. GET /models answers
// 200 for any key (it is public), so the check goes through a management
// endpoint that a subscription key may read metering from: an unknown
// generation id is fine (400/404/200), a refused key is 401/403.
async function checkSubscriptionKey(key, { signal } = {}) {
  const res = await fetch(`${MANAGEMENT_API}/generation?id=gen_magpie_signin_check`, {
    method: "GET",
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    ...(signal ? { signal } : {}),
  })
  const text = await res.text().catch(() => "")
  await res.body?.cancel().catch(() => {})
  return { status: res.status, ok: res.ok, text }
}

async function fetchSubscription(managementKey, { signal } = {}) {
  const res = await fetch(`${MANAGEMENT_API}/subscription/detail`, {
    method: "GET",
    headers: { authorization: `Bearer ${managementKey}`, accept: "application/json" },
    ...(signal ? { signal } : {}),
  })
  const text = await res.text().catch(() => "")
  let body
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  await res.body?.cancel().catch(() => {})
  return { status: res.status, ok: res.ok, body, text }
}

// Plans change rarely; one host asks once every six hours.
let planCache = { at: 0, sets: null }
const PLAN_TTL = 6 * 3600_000

// fetchPlanSets reads the public plan catalogue: which models each planKey
// (free / starter / pro / max / ultra) serves. It needs no key, so it also
// lets chat-only users curate by `plan` without a Management API key.
async function fetchPlanSets({ signal } = {}) {
  const now = Date.now()
  if (planCache.sets && now - planCache.at < PLAN_TTL) return planCache.sets
  const res = await fetch(`${PUBLIC_API}/subscription/public/get_all_plans`, {
    method: "GET",
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  })
  const text = await res.text().catch(() => "")
  await res.body?.cancel().catch(() => {})
  if (!res.ok) throw new Error(`ZenMux answered HTTP ${res.status}`)
  let body
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    throw new Error("ZenMux sent a plan catalogue magpie couldn't read")
  }
  const sets = planModelSets(body?.data)
  if (sets.size) planCache = { at: now, sets }
  return sets
}

// planKeyFor says which plan this account is on: an explicit `plan` option
// wins, else the Management API key's subscription detail.
async function planKeyFor(auth, options, { signal } = {}) {
  const forced = typeof options?.plan === "string" ? options.plan.trim().toLowerCase() : ""
  if (forced) return forced
  const managementKey = managementKeyOf(auth)
  if (!managementKey) return ""
  try {
    const { status, body } = await fetchSubscription(managementKey, { signal })
    if (status !== 200 || !isObj(body) || body.success === false) return ""
    const tier = isObj(body.data?.plan) && typeof body.data.plan.tier === "string" ? body.data.plan.tier : ""
    return tier.trim().toLowerCase()
  } catch {
    return ""
  }
}

// isKeyRefusal tells "this key is not valid" apart from "this model is not in
// the plan": ZenMux answers both with 403 access_denied, but only the first
// talks about the key / a legacy key / the upgrade window.
function isKeyRefusal(status, text) {
  if (status === 401) return true
  if (status !== 403) return false
  const s = String(text ?? "")
  return /api[_ -]?key|legacy key|upgrade window|credential|sign[- ]?in|token/i.test(s) && !/model/i.test(s)
}

// annotate tells magpie when the deal is a dead sign-in, which a bare 403 does
// not: the gateway would read it as "that model refused", not "sign in again".
async function annotate(res) {
  if (!res || (res.status !== 401 && res.status !== 403)) return res
  let text = ""
  try {
    text = await res.clone().text()
  } catch {
    return res
  }
  if (!isKeyRefusal(res.status, text)) return res
  const headers = new Headers(res.headers)
  headers.set("x-magpie-sign-in", "expired")
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

// request is the account's fetch: it signs every request with the subscription
// key and asks chat completions for usage on streams, so a streamed turn still
// reports its tokens.
async function request(key, input, init) {
  const headers = new Headers(init?.headers ?? {})
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${key}`)
  headers.set("accept", headers.get("accept") ?? "application/json")
  // magpie adds its own routing headers (x-magpie-fallback, x-magpie-work-dir,
  // x-magpie-session, …). They carry nothing ZenMux needs and local paths
  // shouldn't leave this machine, so drop every one of them.
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith("x-magpie-")) headers.delete(name)
  }

  let body = init?.body
  if (typeof body === "string" && /\/chat\/completions(?:[?#]|$)/.test(String(input))) {
    try {
      const parsed = JSON.parse(body)
      if (isObj(parsed) && parsed.stream === true) {
        parsed.stream_options = {
          ...(isObj(parsed.stream_options) ? parsed.stream_options : {}),
          include_usage: true,
        }
        body = JSON.stringify(parsed)
        headers.delete("content-length")
      }
    } catch {
      // Not JSON we know: send it as it came.
    }
  }
  const res = await fetch(input, { ...init, headers, ...(body !== undefined ? { body } : {}) })
  return annotate(res)
}

export const ZenMuxBuilderAuthPlugin = async (input, pluginOptions) => {
  const options = isObj(pluginOptions) ? pluginOptions : isObj(input?.magpie?.options) ? input.magpie.options : {}
  const include = entries(options?.models ?? options?.include)
  const exclude = entries(options?.exclude ?? options?.notModels)
  const allModels = options?.allModels === true || options?.allModels === "true"

  return {
    // The provider and its default models, before anyone signs in. models.dev
    // lists `zenmux` itself, so ??= leaves that entry in place.
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "ZenMux",
        npm: NPM,
        api: API,
        models: DEFAULT_MODELS,
      }
    },

    auth: {
      provider: PROVIDER,

      methods: [
        {
          type: "api",
          label: "ZenMux subscription API key",
          // magpie asks for an API method's key itself and doesn't hand it to
          // authorize; keyless makes the prompts below the only questions.
          keyless: true,
          prompts: [
            {
              type: "password",
              key: "key",
              message: "Subscription API Key (ZenMux → Subscription → sk-subs-…)",
              validate: (v) => {
                const s = String(v ?? "").trim()
                if (!s) return "ZenMux needs a subscription API key"
                if (!ANY_KEY_RE.test(s)) return "That doesn't look like a ZenMux API key (sk-subs-… or sk-payg-…)"
                return undefined
              },
            },
            {
              type: "password",
              key: "managementKey",
              required: false,
              message: "Management API Key (zenmux.ai/platform/management → sk-mgmt-…; optional, needed for the Flows)",
              validate: (v) => {
                const s = String(v ?? "").trim()
                if (!s) return undefined
                if (!MANAGEMENT_KEY_RE.test(s)) return "A ZenMux Management API key starts with sk-mgmt-"
                return undefined
              },
            },
            {
              type: "text",
              key: "email",
              required: false,
              message: "Email (optional; names this account in magpie)",
            },
          ],
          async authorize(inputs, { signal } = {}) {
            const key = String(inputs?.key ?? "").trim()
            const managementKey = String(inputs?.managementKey ?? "").trim()
            const email = String(inputs?.email ?? "").trim()
            if (!key) return { type: "failed", error: "ZenMux needs a subscription API key" }
            if (!ANY_KEY_RE.test(key)) return { type: "failed", error: "That doesn't look like a ZenMux API key (sk-subs-… or sk-payg-…)" }
            if (managementKey && !MANAGEMENT_KEY_RE.test(managementKey)) {
              return { type: "failed", error: "A ZenMux Management API key starts with sk-mgmt-" }
            }

            // The subscription key: a management request proves it is live.
            try {
              const probe = await checkSubscriptionKey(key, { signal })
              if (probe.status === 401 || probe.status === 403) {
                const why = messageOf(probe.text)
                const legacy = LEGACY_KEY_RE.test(key) ? " — this key's sk-ss-v1- / sk-mg-v1- prefix was retired on 2026-11-10: create a new key" : ""
                return {
                  type: "failed",
                  error: `ZenMux refused this API key (HTTP ${probe.status})${why ? `: ${why.slice(0, 300)}` : ""}${legacy}`,
                }
              }
              if (!probe.ok && probe.status >= 500) {
                return { type: "failed", error: `ZenMux answered HTTP ${probe.status}` }
              }
            } catch (e) {
              return { type: "failed", error: `ZenMux unreachable: ${e?.cause?.code || e?.message || "network error"}` }
            }

            // The management key: check it too, but a network hiccup there
            // shouldn't block a sign-in — usage will say so later.
            if (managementKey) {
              try {
                const { status, body } = await fetchSubscription(managementKey, { signal })
                if (status === 401 || status === 403) {
                  return { type: "failed", error: `ZenMux refused the Management API key (HTTP ${status})` }
                }
                if (isObj(body) && body.success === false) {
                  const why = typeof body.message === "string" && body.message ? body.message : "no subscription details"
                  return { type: "failed", error: `ZenMux Management API: ${why.slice(0, 300)}` }
                }
              } catch (e) {
                if (e?.status === 401 || e?.status === 403) {
                  return { type: "failed", error: `ZenMux refused the Management API key (HTTP ${e.status})` }
                }
              }
            }

            return {
              type: "success",
              key,
              metadata: {
                // key is kept once, as the account's own key, not twice.
                key: undefined,
                ...(managementKey ? { managementKey } : {}),
                ...(email ? { email } : {}),
                ...(isSubscriptionKey(key) ? { plan: "builder" } : {}),
              },
            }
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth()
        const key = keyOf(auth)
        if (!key) return {}
        return {
          baseURL: API,
          apiKey: key,
          fetch: (input_, init) => request(key, input_, init),
        }
      },

      // magpie's own hook: how much of the Builder Plan is left. Runs in the
      // account's scope, so a refreshed token would be saved to this account.
      async usage(getAuth) {
        const auth = await getAuth()
        const key = keyOf(auth)
        const managementKey = managementKeyOf(auth)
        if (!key) return { windows: [] }
        if (!managementKey) {
          return {
            windows: [],
            signIn: "kept",
            error:
              "Add a Management API Key (zenmux.ai/platform/management) to this provider's sign-in to see the plan's Flows",
          }
        }

        let res
        try {
          res = await fetchSubscription(managementKey)
        } catch (e) {
          return { windows: [], error: `ZenMux unreachable: ${e?.cause?.code || e?.message || "network error"}` }
        }

        if (res.status === 401 || res.status === 403) {
          // The subscription key still works; it is the management key that is
          // bad, so don't rest the account for chat.
          return {
            windows: [],
            signIn: "kept",
            error: `ZenMux refused the Management API key (HTTP ${res.status}); replace it at zenmux.ai/platform/management and sign in again to save it`,
          }
        }
        if (res.status === 422) {
          return { windows: [], signIn: "kept", error: "ZenMux asked us to slow down reading the subscription (HTTP 422)" }
        }
        if (!res.ok) {
          return { windows: [], signIn: "kept", error: `ZenMux answered HTTP ${res.status}` }
        }
        if (!isObj(res.body) || res.body.success === false) {
          const why = isObj(res.body) && typeof res.body.message === "string" ? res.body.message : res.text.slice(0, 200)
          return { windows: [], signIn: "kept", error: `ZenMux did not return the subscription details${why ? `: ${why}` : ""}` }
        }

        return subscriptionToUsage(res.body.data)
      },
    },

    // The models this account can use, asked of ZenMux. models.dev already
    // gives each id its name, limits, reasoning levels and pricing; the live
    // list says which ones exist (and which the plan may use right now).
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const base = isObj(provider?.models) ? provider.models : DEFAULT_MODELS
        const key = keyOf(auth)
        if (!key) return base

        let live
        try {
          live = await fetchModels(key)
        } catch (e) {
          if (e?.status === 401 || e?.status === 403) {
            throw Object.assign(new Error(`ZenMux refused this account's API key (HTTP ${e.status}); sign in again`), {
              signIn: "expired",
            })
          }
          // ZenMux is down: keep the list magpie already had.
          return base
        }
        if (!live.length) return base

        const subscription = isSubscriptionKey(key)

        // Only the models this account's plan serves, when we can tell which
        // plan that is: ZenMux answers 403 for a model outside it.
        let served = null
        if (!allModels) {
          const planKey = await planKeyFor(auth, options)
          if (planKey) {
            try {
              served = (await fetchPlanSets()).get(planKey) ?? null
            } catch {
              served = null
            }
          }
        }

        const build = (filter) => {
          const out = {}
          for (const m of live) {
            if (!isChatModel(m)) continue
            if (filter && !filter.has(m.id)) continue
            if (include.length && !include.some((p) => matches(m.id, p))) continue
            if (exclude.length && exclude.some((p) => matches(m.id, p))) continue
            out[m.id] = modelRow(m, base?.[m.id], { subscription, api: { id: m.id, url: API, npm: NPM } })
          }
          return out
        }

        let models = build(served)
        // A plan list that shares nothing with the live list is not a reason
        // to show an empty picker.
        if (served && !Object.keys(models).length) models = build(null)
        if (!Object.keys(models).length) return base

        // A model the user asked for by name that the live list didn't have
        // still gets a row, so a curated option list never silently loses one.
        for (const pattern of include) {
          if (models[pattern] || pattern.includes("*") || pattern.endsWith("/")) continue
          const known = base?.[pattern]
          const one = live.find((m) => m.id === pattern)
          if (one) models[pattern] = modelRow(one, known, { subscription, api: { id: one.id, url: API, npm: NPM } })
        }
        return models
      },
    },
  }
}

export const _internal = {
  request,
  annotate,
  isKeyRefusal,
  checkSubscriptionKey,
  messageOf,
  subscriptionToUsage,
  isChatModel,
  modelRow,
  entries,
  matches,
  planModelSets,
  EFFORTS,
  DEFAULT_MODELS,
  PROVIDER,
  API,
  MANAGEMENT_API,
  PUBLIC_API,
  SUBSCRIPTION_KEY_RE,
  MANAGEMENT_KEY_RE,
}