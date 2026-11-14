// Pure helpers for the ZenMux Builder Plan plugin. No network here: everything
// that talks to ZenMux lives in index.mjs, so this file is easy to unit-test.

export const PROVIDER = "zenmux"
export const API = "https://zenmux.ai/api/v1"
export const MANAGEMENT_API = "https://zenmux.ai/api/v1/management"
// The public pricing APIs live beside /api/v1, not under it.
export const PUBLIC_API = "https://zenmux.ai/api"
export const NPM = "@ai-sdk/openai-compatible"

// The reasoning levels offered for a model whose own metadata says it reasons.
// models.dev (which magpie merges for the `zenmux` provider id) usually gives a
// better per-model list; this is only the fallback for a model it doesn't know.
export const EFFORTS = Object.freeze({
  low: Object.freeze({}),
  medium: Object.freeze({}),
  high: Object.freeze({}),
})

// ZenMux renamed its key prefixes on 2026-11-10: subscription keys are
// sk-subs-…, pay-as-you-go keys sk-payg-…, Management API keys sk-mgmt-….
// The older sk-ss-v1- / sk-ai-v1- / sk-mg-v1- keys were disabled that day
// (ZenMux answers 403 "Legacy keys have been disabled since November 10, 2026").
export const SUBSCRIPTION_KEY_RE = /^sk-(subs-|ss-v1-)/
export const MANAGEMENT_KEY_RE = /^sk-mgmt-/
export const ANY_KEY_RE = /^sk-[A-Za-z0-9._-]{8,}$/
export const LEGACY_KEY_RE = /^sk-(ss-v1-|ai-v1-|mg-v1-)/

export function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

export function num(v) {
  const n = typeof v === "string" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : undefined
}

export function round2(v) {
  return Math.round(v * 100) / 100
}

// trimNum keeps 5.19 as 5.19 and 50 as 50, for "5.19 / 50 Flows".
export function trimNum(v) {
  const n = num(v)
  if (n === undefined) return String(v)
  return Number.isInteger(n) ? String(n) : String(round2(n))
}

export function cap(s) {
  const t = String(s ?? "").trim()
  return t ? t[0].toUpperCase() + t.slice(1) : ""
}

export function isSubscriptionKey(key) {
  return SUBSCRIPTION_KEY_RE.test(String(key ?? ""))
}

export function keyOf(auth) {
  const a = isObj(auth) ? auth : {}
  const key = typeof a.key === "string" ? a.key.trim() : ""
  if (key) return key
  return ""
}

export function managementKeyOf(auth) {
  const a = isObj(auth) ? auth : {}
  const meta = isObj(a.metadata) ? a.metadata : {}
  for (const k of ["managementKey", "management_key", "mgmtKey"]) {
    const v = meta[k]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return ""
}

// subscriptionToUsage maps GET /management/subscription/detail's data object to
// magpie's auth.usage result. Flows are the vendor's own unit, so each window
// carries both its percent and its "used / max Flows" count.
export function subscriptionToUsage(data) {
  const d = isObj(data) ? data : {}
  const plan = isObj(d.plan) ? d.plan : {}
  const tier = typeof plan.tier === "string" ? plan.tier.trim() : ""
  const until = typeof plan.expires_at === "string" && plan.expires_at ? plan.expires_at : undefined

  const monthlyMax = num(d.quota_monthly?.max_flows)
  const monthlyUsd = num(d.quota_monthly?.max_value_usd)
  const windows = []
  const addWindow = (q, name, span) => {
    if (!isObj(q)) return
    const max = num(q.max_flows)
    const usedFlows = num(q.used_flows)
    const pct = num(q.usage_percentage)
    let used
    if (pct !== undefined) used = round2(pct * 100)
    else if (max !== undefined && max > 0 && usedFlows !== undefined) used = round2((usedFlows / max) * 100)
    if (used === undefined && !(max !== undefined && max > 0)) return
    windows.push({
      name,
      ...(used !== undefined ? { used } : {}),
      ...(typeof q.resets_at === "string" && q.resets_at ? { resetsAt: q.resets_at } : {}),
      span,
      ...(usedFlows !== undefined && max !== undefined
        ? { display: `${trimNum(usedFlows)} / ${trimNum(max)} Flows`, amount: usedFlows, limit: max, unit: "Flows" }
        : {}),
    })
  }
  addWindow(d.quota_5_hour, "5 hours", 5 * 3600)
  addWindow(d.quota_7_day, "7 days", 7 * 24 * 3600)

  // The monthly cap is a ceiling the plan is sized at, not a live count, so it
  // is an aside window: shown, never read for routing.
  if (monthlyMax !== undefined && monthlyMax > 0) {
    windows.push({
      name: "monthly",
      display: `${trimNum(monthlyMax)} Flows/month${monthlyUsd !== undefined ? ` ($${trimNum(monthlyUsd)})` : ""}`,
      aside: true,
    })
  }

  const resetsLeft = num(d.quota_5_hour?.remaining_resets)
  const status = typeof d.account_status === "string" ? d.account_status.trim() : ""

  const usage = {
    ...(tier ? { plan: `Builder ${cap(tier)}` } : {}),
    ...(until ? { until } : {}),
    windows,
    ...(resetsLeft !== undefined && resetsLeft > 0
      ? {
          resets: {
            count: resetsLeft,
            byWindow: true,
            fiveHour: resetsLeft,
            ...(until ? { until } : {}),
          },
        }
      : {}),
  }

  if (status === "suspended" || status === "banned") {
    return { ...usage, windows: [], error: `ZenMux says this account is ${status}` }
  }
  return usage
}

// isChatModel keeps the models an agent can chat with: text out, and not one of
// ZenMux's image / video / audio / embedding endpoints.
const NON_CHAT_RE = /(^|[/_.-])(image|imagen|video|tts|speech|transcri|embed|rerank|audio)/i

export function isChatModel(m) {
  if (!isObj(m) || typeof m.id !== "string" || !m.id) return false
  if (!/^[\w.-]+\/[\w.:-]+$/.test(m.id)) return false
  const out = Array.isArray(m.output_modalities) ? m.output_modalities : ["text"]
  if (!out.includes("text")) return false
  if (NON_CHAT_RE.test(m.id)) return false
  return true
}

// modelRow turns one GET /api/v1/models entry into an OpenCode Model, keeping
// whatever models.dev already knew about that id (variants, interleaving, …).
export function modelRow(m, base = {}, { subscription = false, api } = {}) {
  const b = isObj(base) ? base : {}
  const { cost: baseCost, ...rest } = b
  const liveCost = subscription ? undefined : costOf(m)
  const inputs = Array.isArray(m.input_modalities) ? m.input_modalities : ["text"]
  const outputs = Array.isArray(m.output_modalities) ? m.output_modalities : ["text"]
  const image = inputs.includes("image")
  const reasoning =
    m?.capabilities?.reasoning === true || b?.capabilities?.reasoning === true || b?.reasoning === true
  const toolcall = b?.capabilities?.toolcall ?? b?.tool_call ?? true
  const context = num(m.context_length) ?? num(b?.limit?.context)
  const output = num(m.max_tokens) ?? num(b?.limit?.output)
  // models.dev sometimes carries an empty variants map; that is "no levels
  // known", not "a model with no reasoning", so fall back to ours.
  const knownVariants = isObj(b?.variants) && Object.keys(b.variants).length ? b.variants : undefined
  const variants = knownVariants ?? (reasoning ? EFFORTS : undefined)

  const inputCaps = Object.fromEntries(inputs.map((t) => [t, true]))
  const outputCaps = Object.fromEntries(outputs.map((t) => [t, true]))

  return {
    ...rest,
    id: m.id,
    name: typeof m.display_name === "string" && m.display_name ? m.display_name : b?.name ?? m.id,
    ...(context !== undefined || output !== undefined
      ? { limit: { ...(context !== undefined ? { context } : {}), ...(output !== undefined ? { output } : {}) } }
      : {}),
    reasoning,
    tool_call: !!toolcall,
    modalities: { input: inputs, output: outputs },
    ...(api && !isObj(b?.api) ? { api } : {}),
    ...(!b?.release_date && typeof m.publish_time === "string" && m.publish_time
      ? { release_date: m.publish_time }
      : {}),
    capabilities: {
      ...(isObj(b?.capabilities) ? b.capabilities : {}),
      reasoning,
      toolcall: !!toolcall,
      attachment: image || b?.capabilities?.attachment === true,
      input: { ...(isObj(b?.capabilities?.input) ? b.capabilities.input : {}), text: true, ...inputCaps },
      output: { ...(isObj(b?.capabilities?.output) ? b.capabilities.output : {}), ...outputCaps },
    },
    ...(variants ? { variants } : {}),
    // A Builder Plan draws Flows, not dollars: leave cost off for subscription
    // keys so magpie doesn't price the plan in USD. For a pay-as-you-go key,
    // models.dev's price wins, else ZenMux's own pricings.
    ...(baseCost && !subscription ? { cost: baseCost } : {}),
    ...(liveCost ? { cost: liveCost } : {}),
  }
}

// costOf turns GET /api/v1/models' pricings into magpie's per-million-token
// cost. Only pay-as-you-go keys see dollars; a Builder Plan spends Flows.
export function costOf(m) {
  const p = isObj(m?.pricings) ? m.pricings : {}
  const value = (k) => {
    const arr = Array.isArray(p[k]) ? p[k] : []
    for (const item of arr) {
      const v = num(item?.value)
      if (v !== undefined) return v
    }
    return undefined
  }
  const input = value("prompt")
  const output = value("completion")
  const cacheRead = value("input_cache_read")
  const cacheWrite = value("input_cache_write")
  if (input === undefined && output === undefined) return undefined
  return {
    input: input ?? 0,
    output: output ?? 0,
    ...(cacheRead !== undefined || cacheWrite !== undefined
      ? {
          cache: {
            ...(cacheRead !== undefined ? { read: cacheRead } : {}),
            ...(cacheWrite !== undefined ? { write: cacheWrite } : {}),
          },
        }
      : {}),
  }
}

// planModelSets reads GET /api/subscription/public/get_all_plans into a map of
// planKey (free / starter / pro / max / ultra) to the model slugs that plan
// serves. The same slug appears once per endpoint, so a Set is what we want.
export function planModelSets(plans) {
  const out = new Map()
  if (!Array.isArray(plans)) return out
  for (const p of plans) {
    const key = typeof p?.planKey === "string" ? p.planKey.trim().toLowerCase() : ""
    if (!key) continue
    const set = new Set()
    for (const m of Array.isArray(p.models) ? p.models : []) {
      const slug = typeof m?.model_slug === "string" ? m.model_slug : typeof m?.slug === "string" ? m.slug : ""
      if (slug) set.add(slug)
    }
    out.set(key, set)
  }
  return out
}

// entries turns a plugin option into a list of strings, accepting an array, a
// comma/space separated string or an object whose keys are model ids.
export function entries(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === "string") return v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)
  if (isObj(v)) return Object.keys(v)
  return []
}

// matches reports whether a model id matches one pattern: an exact id, a glob
// with *, or a bare vendor ("openai/") prefix.
export function matches(id, pattern) {
  const p = String(pattern ?? "").trim()
  if (!p) return false
  if (p === "*") return true
  if (!p.includes("*")) return p.endsWith("/") ? id.startsWith(p) : id === p
  const re = new RegExp(`^${p.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)
  return re.test(id)
}