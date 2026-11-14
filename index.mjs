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

import { readFileSync, statSync } from "node:fs"

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
  modelsDevCachePaths,
  planModelSets,
  subscriptionToUsage,
} from "./zenmux.mjs"

// The bases can be pointed elsewhere for a test or a local mock; in normal use
// they are ZenMux's own.
const API = (process.env.ZENMUX_API_BASE || ZENMUX_API).replace(/\/+$/, "")
const MANAGEMENT_API = (process.env.ZENMUX_MANAGEMENT_API_BASE || ZENMUX_MANAGEMENT_API).replace(/\/+$/, "")
const PUBLIC_API = (process.env.ZENMUX_PUBLIC_API_BASE || ZENMUX_PUBLIC_API).replace(/\/+$/, "")

const DEFAULT_MODELS = {
  // Last resort, for a host with no models.dev catalogue whose live list also
  // fails: magpie still has a few models to show before the next try.
  "anthropic/claude-fable-5.2": { name: "Anthropic: Claude Fable 5.2", reasoning: true, tool_call: true, limit: { context: 200000, output: 64000 } },
  "openai/gpt-6.1-terra": { name: "OpenAI: GPT-6.1 Terra", reasoning: true, tool_call: true, limit: { context: 1050000, output: 128000 } },
  "deepseek/deepseek-v4.1-flash": { name: "DeepSeek: DeepSeek V4.1 Flash", reasoning: true, tool_call: true, limit: { context: 1000000, output: 384000 } },
  "moonshotai/kimi-k3.1-pro": { name: "MoonshotAI: Kimi K3.1 Pro", reasoning: true, tool_call: true, limit: { context: 1048576, output: 458752 } },
}

// models.dev's catalogue as magpie keeps it. The plugin host hands the models
// hook a Model built from that catalogue, but its reasoning levels are not part
// of that Model, so the per-model levels are read from magpie's own models.dev
// snapshot: the same bytes, no extra download and nothing sent anywhere. A
// missing or unreadable snapshot is not an error — the live catalogue and our
// fallback levels take over.
let modelsDevCache = { file: "", mtime: 0, models: {} }

function modelsDevModels(env = process.env) {
  for (const file of modelsDevCachePaths(env)) {
    try {
      const st = statSync(file)
      if (modelsDevCache.file === file && modelsDevCache.mtime === st.mtimeMs) return modelsDevCache.models
      const data = JSON.parse(readFileSync(file, "utf8"))
      const provider = isObj(data?.[PROVIDER]) ? data[PROVIDER] : {}
      const models = isObj(provider.models) ? provider.models : {}
      modelsDevCache = { file, mtime: st.mtimeMs, models }
      return models
    } catch {
      // Not there or not readable: try the next place magpie might keep it.
    }
  }
  return {}
}

async function fetchModels(key, { signal } = {}) {
  // The catalogue answers 200 to anyone, signed in or not, so a missing key is
  // not a reason to skip it.
  const headers = { accept: "application/json" }
  if (key) headers.authorization = `Bearer ${key}`
  const res = await fetch(`${API}/models`, {
    method: "GET",
    headers,
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

// The cheap, no-quota checks all lie about a key: GET /api/v1/models,
// /api/anthropic/v1/models and /api/vertex-ai/v1beta/models answer 200 for any
// key at all, and every /api/v1/management/* endpoint answers 403 to a valid
// subscription key too (it wants a Management API key). So a subscription key
// is proved the only way ZenMux lets us: a one-token chat request, which is
// exactly the thing the key is for.
// Mainstream ids first: a probe wants a model that is certainly served and
// certainly healthy, not merely one whose name looks cheap.
const PREFERRED_PROBE = [
  "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4-flash",
  "google/gemini-4-hydrogen",
  "openai/gpt-6.1-terra",
  "anthropic/claude-fable-5.2",
  "moonshotai/kimi-k3",
]
const CHEAP_RE = /(^|[/_.-])(flash|lite|mini|haiku|small|turbo)([/_.-]|$)/i
const DEAR_RE = /(pro|max|opus|ultra|thinking)/i

// isListableNonChat says which non-chat model is still a real model (not an
// endpoint we cannot address): an image, video, speech, transcription,
// embedding, rerank or decision model with a proper slug.
function isListableNonChat(m) {
  if (!isObj(m) || typeof m.id !== "string" || !m.id) return false
  if (!/^[\w.-]+\/[\w.:-]+$/.test(m.id)) return false
  return Array.isArray(m.output_modalities) && m.output_modalities.length > 0
}

// probeCandidates lists the models a probe should try, best first: the
// mainstream ones that this catalogue has (and this plan serves, when known),
// then the cheapest-looking chat models. A plan that serves none of them is
// unusual, so the list is short.
function probeCandidates(models, served, limit = 6) {
  const chat = (models ?? []).filter((m) => isChatModel(m))
  const allowed = (id) => !served || served.has(id)
  const out = []
  const add = (id) => {
    if (id && !out.includes(id) && allowed(id)) out.push(id)
  }
  const present = new Set(chat.map((m) => m.id))
  for (const id of PREFERRED_PROBE) if (present.has(id)) add(id)

  const cheap = chat
    .filter((m) => !out.includes(m.id))
    .map((m) => ({
      id: m.id,
      score: CHEAP_RE.test(m.id) ? 1 : DEAR_RE.test(m.id) ? 9 : 5,
      context: Number(m.context_length) || 0,
    }))
    .sort((a, b) => a.score - b.score || a.context - b.context)
  for (const m of cheap) {
    if (out.length >= limit) break
    add(m.id)
  }
  return out.slice(0, limit)
}

// chatProbe makes one minimal request. A 200 proves the key; 429/402 say the
// key is fine but the allowance is spent; 403 naming a model means that model
// is outside the plan, so the caller can try another.
async function chatProbe(key, model, { signal } = {}) {
  const res = await fetch(`${API}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      stream: false,
    }),
    ...(signal ? { signal } : {}),
  })
  const text = await res.text().catch(() => "")
  await res.body?.cancel().catch(() => {})
  return { status: res.status, ok: res.ok, text, message: messageOf(text) }
}

// validateSubscriptionKey proves a subscription key is live without failing on
// the endpoints that answer 403 to it by design.
//
// ZenMux's answers on a chat request mean different things:
//   200            the key works
//   429 / 402      the key works, the allowance is spent
//   400/404/422    the key was accepted and the model or payload was the problem
//   403            the key (or its permission) was refused — or, when the text
//                  names a model, that model is outside this plan
//   401            no key
// So a 4xx that is not 401/403 proves the sign-in is good, even when no model
// answers 200.
async function validateSubscriptionKey(key, { signal, served, models, probeModel } = {}) {
  // Fast path: an unknown generation id is 404 and a wrong key 403, but never
  // trust a 403 here — that is also what a good subscription key gets.
  try {
    const res = await fetch(`${MANAGEMENT_API}/generation?id=gen_magpie_signin_check`, {
      method: "GET",
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      ...(signal ? { signal } : {}),
    })
    await res.body?.cancel().catch(() => {})
    if (res.status === 200 || res.status === 404 || res.status === 400) {
      return { ok: true, via: "metering" }
    }
  } catch {
    // Fall through to the chat probe, which reports network errors itself.
  }

  let catalogue = models
  if (!catalogue?.length) {
    try {
      catalogue = await fetchModels(key, { signal })
    } catch (e) {
      return {
        ok: false,
        status: e?.status,
        message: `ZenMux unreachable: ${e?.cause?.code || e?.message || "network error"}`,
        network: true,
      }
    }
  }

  const forced = typeof probeModel === "string" && probeModel.trim() ? probeModel.trim() : ""
  const candidates = forced ? [forced] : probeCandidates(catalogue, served)

  let accepted = null
  let last = null
  for (const model of candidates) {
    const res = await chatProbe(key, model, { signal })
    last = res
    if (res.status === 200) return { ok: true, via: "chat", model }
    if (res.status === 429 || res.status === 402) return { ok: true, via: "chat-throttled", model }
    if (res.status === 401) return { ok: false, status: 401, message: res.message }
    if (res.status === 403) {
      // "no model in this plan" is worth another model; a refused key is not.
      if (/model/i.test(res.message)) continue
      return { ok: false, status: 403, message: res.message }
    }
    // 400 / 404 / 422: the key got through, the model or the body did not.
    accepted = { model, status: res.status, message: res.message }
  }

  if (accepted) return { ok: true, via: "probe-inconclusive", ...accepted }
  return {
    ok: false,
    status: last?.status ?? 403,
    message: last?.message || "ZenMux refused every model this account tried",
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

export const ZenMuxBuilderAuthPlugin = async (input, pluginOptions) => {
  const options = {
    ...(isObj(input?.magpie?.options) ? input.magpie.options : {}),
    ...(isObj(input?.magpie?.option) ? input.magpie.option : {}),
    ...(isObj(pluginOptions) ? pluginOptions : {}),
  }
  const include = entries(options?.models ?? options?.include)
  const exclude = entries(options?.exclude ?? options?.notModels)
  const allModels = options?.allModels === true || options?.allModels === "true"
  const probeModelOption = typeof options?.probeModel === "string" ? options.probeModel.trim() : ""
  // Off by default: an agent picks chat models, so a video or embedding model in
  // the picker is a trap. Turn it on to see everything the plan serves.
  const includeNonChat = options?.includeNonChat === undefined ? true : options.includeNonChat === true || options.includeNonChat === "true"

  return {
    // The provider before anyone signs in. models.dev lists `zenmux` itself, so
    // its catalogue is the model list; seeding models here would overwrite the
    // catalogue's names and limits field by field. DEFAULT_MODELS is only the
    // last resort, when models.dev and ZenMux are both unavailable.
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "ZenMux",
        npm: NPM,
        api: API,
      }
    },

    auth: {
      provider: PROVIDER,

      // Switches in the provider's editor (Plugins → Installed → Options), also
      // settable with `magpie plugin options zenmux '{"includeNonChat":false}'`.
      options: [
        {
          key: "includeNonChat",
          label: "Show every model the plan serves",
          description:
            "Also list the plan's image, video, speech and embedding models. They appear in agent model pickers but a chat request to one of them fails.",
          default: true,
          filtersModels: true,
        },
        {
          key: "allModels",
          label: "Ignore the plan filter",
          description: "List every chat model ZenMux has, not only the ones your plan serves.",
          default: false,
          filtersModels: true,
        },
      ],

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

            // The subscription key. Only a real (one-token) request proves it:
            // the model lists are public and the management endpoints answer
            // 403 to a good subscription key as well.
            const verdict = await validateSubscriptionKey(key, {
              signal,
              probeModel: probeModelOption,
            })
            if (!verdict.ok) {
              const legacy = LEGACY_KEY_RE.test(key)
                ? " — this key's sk-ss-v1- / sk-mg-v1- prefix was retired on 2026-11-10: create a new key"
                : ""
              const hint = MANAGEMENT_KEY_RE.test(key)
                ? " — this looks like a Management API key: paste it into the second question, not the first"
                : verdict.status === 403 && /permission|access_denied|forbidden/i.test(verdict.message ?? "")
                  ? " — ZenMux gives this answer both for a bad key and for a key that may not make requests: check it is a subscription/pay-as-you-go key (not a Management key), created after 2026-11-10, on Starter or above (Free has no API access)"
                  : ""
              if (verdict.network) return { type: "failed", error: verdict.message }
              return {
                type: "failed",
                error: `ZenMux refused this API key (HTTP ${verdict.status})${verdict.message ? `: ${verdict.message.slice(0, 300)}` : ""}${legacy}${hint}`,
              }
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
        // models.dev's entries (the host builds them from its catalogue) are
        // the base; DEFAULT_MODELS is only for a host with no catalogue.
        const merged = isObj(provider?.models) ? provider.models : {}
        const base = Object.keys(merged).length ? merged : DEFAULT_MODELS
        // Signed out this still works: the catalogue is public, and magpie's
        // bundled models.dev list is smaller than ZenMux's (it has no qwen3.8,
        // for one). Without a key there is no plan to filter by.
        const key = keyOf(auth)

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
        if (key && !allModels) {
          const planKey = await planKeyFor(auth, options)
          if (planKey) {
            try {
              served = (await fetchPlanSets()).get(planKey) ?? null
            } catch {
              served = null
            }
          }
        }

        // models.dev's own entries, for the reasoning levels models.dev
        // names. Absent (a magpie with no snapshot yet) is fine.
        const dev = modelsDevModels()

        const build = (filter) => {
          const out = {}
          for (const m of live) {
            if (!isChatModel(m) && !includeNonChat) continue
            if (!isChatModel(m) && !isListableNonChat(m)) continue
            if (filter && !filter.has(m.id)) continue
            if (include.length && !include.some((p) => matches(m.id, p))) continue
            if (exclude.length && exclude.some((p) => matches(m.id, p))) continue
            out[m.id] = modelRow(m, base?.[m.id], {
              subscription,
              api: { id: m.id, url: API, npm: NPM },
              dev: dev[m.id],
            })
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
          if (one) {
            models[pattern] = modelRow(one, known, {
              subscription,
              api: { id: one.id, url: API, npm: NPM },
              dev: dev[one.id],
            })
          }
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
  validateSubscriptionKey,
  probeCandidates,
  isListableNonChat,
  chatProbe,
  messageOf,
  subscriptionToUsage,
  isChatModel,
  modelRow,
  modelsDevModels,
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