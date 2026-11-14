// Pure helpers for the ZenMux Builder Plan plugin. No network here: everything
// that talks to ZenMux lives in index.mjs, so this file is easy to unit-test.

import { homedir } from "node:os"

export const PROVIDER = "zenmux"
export const API = "https://zenmux.ai/api/v1"
export const MANAGEMENT_API = "https://zenmux.ai/api/v1/management"
// The public pricing APIs live beside /api/v1, not under it.
export const PUBLIC_API = "https://zenmux.ai/api"
export const NPM = "@ai-sdk/openai-compatible"

// The reasoning levels offered for a model whose own metadata says it reasons
// but whose models.dev entry names no level. models.dev (which magpie merges
// for the `zenmux` provider id) usually gives a better per-model list; this is
// the fallback for a model it doesn't know.
export const EFFORTS = Object.freeze({
  low: Object.freeze({}),
  medium: Object.freeze({}),
  high: Object.freeze({}),
})

// A level an agent can pick is a plain word; anything else in a vendor's list
// is a sentence, not a level, and does not belong in a model picker.
const LEVEL_RE = /^[A-Za-z][A-Za-z0-9_-]*$/

// modelsDevLevels lists the effort levels a models.dev entry names, in the
// entry's own order. `reasoning_options` is where models.dev says them: a
// toggle for thinking on/off, an effort list for the levels the model takes.
export function modelsDevLevels(dev) {
  const levels = []
  const options = Array.isArray(dev?.reasoning_options) ? dev.reasoning_options : []
  for (const option of options) {
    if (!isObj(option) || option.type !== "effort") continue
    for (const value of Array.isArray(option.values) ? option.values : []) {
      const level = typeof value === "string" ? value.trim() : ""
      if (!LEVEL_RE.test(level) || levels.includes(level)) continue
      levels.push(level)
    }
  }
  return levels
}

// modelsDevVariants is the variants map models.dev implies for a model: its
// effort levels, or the variants an older models.dev catalogue carried.
// Undefined is a real answer — models.dev knows the model but names no level
// (a toggle only), so the vendor's default is all an agent should pick.
export function modelsDevVariants(dev) {
  if (!isObj(dev)) return undefined
  const levels = modelsDevLevels(dev)
  if (levels.length) return Object.fromEntries(levels.map((level) => [level, {}]))
  if (isObj(dev.variants) && Object.keys(dev.variants).length) return dev.variants
  return undefined
}

// MODALITY_KINDS are the kinds magpie's capabilities name, in its order.
const MODALITY_KINDS = ["text", "image", "audio", "video", "pdf"]

// modalityMap is a models.dev modalities list as capabilities says it: each
// kind true or false, text when the list is empty (magpie's own reading).
function modalityMap(list) {
  const said = Array.isArray(list) ? list : []
  return Object.fromEntries(MODALITY_KINDS.map((kind) => [kind, said.includes(kind) || (kind === "text" && !said.length)]))
}

// saidKinds is whether a capabilities.input/output is someone's answer: an
// object of booleans that is more than a bare { text: true }, the value the
// host writes for a model nobody said anything about.
function saidKinds(caps) {
  if (!isObj(caps)) return false
  const keys = Object.keys(caps).filter((key) => typeof caps[key] === "boolean")
  if (!keys.length) return false
  return keys.length > 1 || keys[0] !== "text" || caps.text !== true
}

// positive keeps a stated limit; a zero there is models.dev's "not said" (the
// internal Model defaults it to 0), so the live catalogue can fill it in.
function positive(value) {
  const n = num(value)
  return n !== undefined && n > 0 ? n : undefined
}

// joinPath joins path pieces with "/", which every OS Node runs on accepts,
// trimming the separators the pieces already carry.
function joinPath(...parts) {
  return parts
    .filter((part) => typeof part === "string" && part.trim())
    .map((part, index) => (index === 0 ? part.trim().replace(/[\\/]+$/, "") : part.trim().replace(/^[\\/]+|[\\/]+$/g, "")))
    .join("/")
}

const text = (value) => (typeof value === "string" ? value.trim() : "")

// modelsDevCachePaths are the places magpie may keep its models.dev snapshot,
// in the order magpie itself would look: Go's os.UserCacheDir for the running
// platform, then models.json in magpie's folder there. magpie leaves a link at
// the old place when its data is moved, so the default places keep working.
export function modelsDevCachePaths(env = process.env, platform = process.platform, home = homedir()) {
  const candidates = []
  const cache = (dir) => {
    const base = text(dir)
    if (base) candidates.push(joinPath(base, "magpie", "models.json"))
  }
  if (platform === "win32") {
    cache(text(env?.LOCALAPPDATA))
    if (text(home)) cache(joinPath(text(home), "AppData", "Local"))
  } else if (platform === "darwin") {
    if (text(home)) cache(joinPath(text(home), "Library", "Caches"))
  } else {
    cache(text(env?.XDG_CACHE_HOME))
    if (text(home)) cache(joinPath(text(home), ".cache"))
  }
  // Windows spells the same place C:\… or C:/…; one candidate is enough.
  return [...new Set(candidates.map((path) => path.replace(/\\/g, "/")))]
}

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

// modelRow turns one GET /api/v1/models entry into an OpenCode Model.
//
// For a model models.dev knows, the row is models.dev's answer: magpie hands
// the models hook a Model built from its catalogue (that is `base`), and `dev`
// is the catalogue entry itself, which still carries the reasoning levels
// models.dev names for the model. The live ZenMux entry only fills what
// models.dev leaves unsaid. A model models.dev does not know is built from the
// live entry, with our three fallback levels when it reasons.
export function modelRow(m, base = {}, { subscription = false, api, dev } = {}) {
  const b = isObj(base) ? base : {}
  const d = isObj(dev) ? dev : undefined
  const known = d !== undefined
  const { cost: baseCost, ...rest } = b
  const caps = isObj(b.capabilities) ? b.capabilities : {}

  const liveInputs = Array.isArray(m.input_modalities) && m.input_modalities.length ? m.input_modalities : ["text"]
  const liveOutputs = Array.isArray(m.output_modalities) && m.output_modalities.length ? m.output_modalities : ["text"]
  const liveName = typeof m.display_name === "string" && m.display_name ? m.display_name : undefined
  const baseName = typeof b.name === "string" && b.name ? b.name : undefined
  const devName = typeof d?.name === "string" && d.name ? d.name : undefined
  const name = known ? baseName ?? devName ?? liveName ?? m.id : liveName ?? baseName ?? m.id

  const reasoning =
    typeof caps.reasoning === "boolean"
      ? caps.reasoning
      : typeof b.reasoning === "boolean"
        ? b.reasoning
        : known
          ? d.reasoning === true
          : m?.capabilities?.reasoning === true
  const toolcall =
    typeof caps.toolcall === "boolean"
      ? caps.toolcall
      : typeof b.tool_call === "boolean"
        ? b.tool_call
        : known && typeof d.tool_call === "boolean"
          ? d.tool_call
          : true
  const attachment =
    typeof caps.attachment === "boolean"
      ? caps.attachment
      : typeof b.attachment === "boolean"
        ? b.attachment
        : known && typeof d.attachment === "boolean"
          ? d.attachment
          : liveInputs.includes("image")
  const temperature =
    typeof caps.temperature === "boolean"
      ? caps.temperature
      : typeof b.temperature === "boolean"
        ? b.temperature
        : known && typeof d.temperature === "boolean"
          ? d.temperature
          : undefined

  const baseLimit = isObj(b.limit) ? b.limit : {}
  const devLimit = isObj(d?.limit) ? d.limit : {}
  const context = positive(baseLimit.context) ?? positive(devLimit.context) ?? num(m.context_length)
  const output = positive(baseLimit.output) ?? positive(devLimit.output) ?? num(m.max_tokens)
  const limitInput = num(baseLimit.input) ?? num(devLimit.input)

  // models.dev says which kinds a model takes and gives; the live entry fills
  // that in only when models.dev said nothing (a model it does not know).
  const devInput = Array.isArray(d?.modalities?.input) ? modalityMap(d.modalities.input) : undefined
  const devOutput = Array.isArray(d?.modalities?.output) ? modalityMap(d.modalities.output) : undefined
  const inputCaps = saidKinds(caps.input)
    ? { ...caps.input, text: true }
    : saidKinds(devInput)
      ? { ...devInput, text: true }
      : { text: true, ...Object.fromEntries(liveInputs.map((kind) => [kind, true])) }
  // Output keeps models.dev's answer as it is: an image model gives images,
  // and saying text too would tell an agent it can chat with it.
  const outputCaps = saidKinds(caps.output)
    ? { ...caps.output }
    : saidKinds(devOutput)
      ? { ...devOutput }
      : Object.fromEntries(liveOutputs.map((kind) => [kind, true]))
  const modalities = known
    ? {
        input: MODALITY_KINDS.filter((kind) => inputCaps[kind] === true),
        output: MODALITY_KINDS.filter((kind) => outputCaps[kind] === true),
      }
    : { input: liveInputs, output: liveOutputs }

  // A variants map the config already carries (the user's, or one magpie
  // normalised) wins; then models.dev's levels; then our fallback, for a model
  // models.dev does not know — or for one whose entry predates the
  // reasoning_options field, when it says nothing of levels at all.
  const baseVariants = isObj(b.variants) && Object.keys(b.variants).length ? b.variants : undefined
  const levelsSaid = known && Array.isArray(d.reasoning_options)
  const variants = baseVariants ?? modelsDevVariants(d) ?? (reasoning && !levelsSaid ? EFFORTS : undefined)

  // A Builder Plan draws Flows, not dollars: leave cost off for subscription
  // keys so magpie doesn't price the plan in USD. For a pay-as-you-go key,
  // models.dev's price wins, else ZenMux's own pricings.
  const liveCost = subscription ? undefined : costOf(m)
  const cost = subscription ? undefined : isObj(baseCost) ? baseCost : liveCost

  return {
    ...rest,
    id: m.id,
    name,
    ...(context !== undefined || limitInput !== undefined || output !== undefined
      ? {
          limit: {
            ...(context !== undefined ? { context } : {}),
            ...(limitInput !== undefined ? { input: limitInput } : {}),
            ...(output !== undefined ? { output } : {}),
          },
        }
      : {}),
    reasoning,
    tool_call: !!toolcall,
    modalities,
    ...(api && !isObj(b?.api) ? { api } : {}),
    ...(!b?.release_date && typeof m.publish_time === "string" && m.publish_time
      ? { release_date: m.publish_time }
      : {}),
    capabilities: {
      ...caps,
      reasoning,
      toolcall: !!toolcall,
      attachment,
      ...(temperature !== undefined ? { temperature } : {}),
      input: inputCaps,
      output: outputCaps,
    },
    ...(variants ? { variants } : {}),
    ...(cost ? { cost } : {}),
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