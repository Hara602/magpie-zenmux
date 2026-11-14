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

// ZenMux's own effort vocabulary, per protocol:
//   chat.completions: minimal / low / medium / high
//   responses:        none / minimal / low / medium / high / xhigh
//   messages:         Anthropic thinking budgets, not effort names
// magpie only translates low/medium/high for these protocols, so a client
// asking for its own top level ("max", "ultra", "xhigh") is clamped back to
// high. Declaring the variants with the vendor's own parameter keeps the top
// level intact instead of round-tripping it into a budget.
export const PROTOCOL_EFFORTS = Object.freeze({
  chat: ["minimal", "low", "medium", "high"],
  responses: ["none", "minimal", "low", "medium", "high", "xhigh"],
})

// variantsForProtocol builds the variants map a model should declare: each
// level name is what the client picks, and the value is the exact parameter
// ZenMux must receive. Levels the protocol cannot express are left out, so a
// picker never offers something that silently degrades.
// Anthropic thinking budgets, in tokens, for each level a client may pick. The
// Messages protocol has no effort names: a budget is the only way to say how
// hard to think, and ZenMux passes budget_tokens to the model as it is.
export const THINKING_BUDGETS = Object.freeze({
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 32768,
  ultra: 32768,
})

// budgetForLevel turns a level name into a thinking budget. A name we do not
// know gets the highest we have rather than nothing: a client that asked for
// its top level did not ask for adaptive.
export function budgetForLevel(level) {
  const l = String(level ?? "").trim().toLowerCase()
  if (THINKING_BUDGETS[l]) return THINKING_BUDGETS[l]
  return THINKING_BUDGETS.high
}

// A client's own top level ("max", "ultra") has no name upstream, and magpie
// clamps any name it does not know back to high — which is how a "max" pick
// ended up as "high". Renaming the top level to the vendor's own word keeps the
// intensity and only changes the label: Responses tops out at xhigh, chat at
// high (ZenMux's chat completions have no level above it).
const TOP_LEVEL = Object.freeze({ responses: "xhigh", chat: "high" })
const CLIENT_TOPS = Object.freeze(["max", "ultra", "xhigh"])

// The Messages protocol has no effort name at all, but magpie always sends its
// thinking field as {type:"adaptive"} for it, and ZenMux passes an explicit
// budget straight to the model. So a budget is the only level a Messages model
// can honour, and it is expressed with the Anthropic-native parameter.
export function variantsForProtocol(protocol, levels) {
  // Messages has no effort name; magpie only forwards the levels a client can
  // pick, and our request rewrite turns magpie's collapsed "adaptive" into a
  // real budget, so the levels named for the model stay as they are.
  if (protocol === "messages") return undefined
  const allowed = PROTOCOL_EFFORTS[protocol]
  if (!allowed) return undefined // messages without levels: nothing to say
  const top = TOP_LEVEL[protocol] ?? allowed[allowed.length - 1]
  const wanted = Array.isArray(levels) && levels.length ? levels : allowed
  // A level the vendor cannot express is dropped rather than offered and
  // silently degraded; a client's top level becomes the vendor's top.
  const out = {}
  const seen = new Set()
  for (const level of wanted) {
    const l = String(level).trim().toLowerCase()
    const name = l
    // A client's top level keeps its own name (so a picker still offers "max")
    // but is sent as the vendor's top level; a vendor level the protocol cannot
    // express is dropped instead of being offered and silently clamped.
    const sent = CLIENT_TOPS.includes(l) ? top : l
    if (!allowed.includes(sent) || seen.has(name)) continue
    seen.add(name)
    // Both chat and Responses take reasoning_effort; chat also takes a thinking
    // budget, which is the finer control and the one ZenMux documents for
    // subscriptions (see reasoning.html). Send the effort name — it is what
    // magpie and the vendor agree on.
    out[name] = { reasoningEffort: sent }
  }
  // ZenMux's chat adapters also accept a thinking budget. Offer the top level as
  // a budget too, so a client that asks for the maximum does not have to rely on
  // the vendor's own rounding of "high".
  // The highest level this protocol can express gets an explicit budget too, so
  // the vendor is told how hard to think instead of inferring it from max_tokens.
  for (const name of Object.keys(out)) {
    const budget = THINKING_BUDGETS[name] ?? THINKING_BUDGETS[top]
    if (out[name].reasoningEffort === top) {
      out[name] = { reasoningEffort: top, thinking: { type: "enabled", budget_tokens: budget } }
    }
  }
  return Object.keys(out).length ? out : undefined
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

// modelsDevCachePaths are the places magpie may keep its models.dev snapshot.
// magpie keeps its cache in ~/.cache/magpie on every platform, Windows and
// macOS included (its `sync` command names the file), unless XDG_CACHE_HOME
// points elsewhere; the platform's own cache folder is checked too, for a
// build that follows Go's os.UserCacheDir. magpie leaves a link at the old
// place when its data is moved, so the default places keep working.
export function modelsDevCachePaths(env = process.env, platform = process.platform, home = homedir()) {
  const candidates = []
  const cache = (dir) => {
    const base = text(dir)
    if (base) candidates.push(joinPath(base, "magpie", "models.json"))
  }
  cache(text(env?.XDG_CACHE_HOME))
  if (text(home)) cache(joinPath(text(home), ".cache"))
  if (platform === "win32") {
    cache(text(env?.LOCALAPPDATA))
    if (text(home)) cache(joinPath(text(home), "AppData", "Local"))
  } else if (platform === "darwin") {
    if (text(home)) cache(joinPath(text(home), "Library", "Caches"))
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

// bearerOf is the token a request is signed with, whichever way the account
// signed in: an API key verbatim, or an OAuth account's access token.
export function bearerOf(auth) {
  const a = isObj(auth) ? auth : {}
  const key = keyOf(a)
  if (key) return key
  if (a.type === "oauth" && typeof a.access === "string") return a.access.trim()
  return ""
}

export function isOAuth(auth) {
  return isObj(auth) && auth.type === "oauth"
}

// managementKeyOf reads the Management API key an account carries. A sign-in
// keeps it either inside `metadata` (api method) or beside the tokens (oauth
// method stores every extra field next to refresh/access).
export function managementKeyOf(auth) {
  const a = isObj(auth) ? auth : {}
  const meta = isObj(a.metadata) ? a.metadata : {}
  for (const k of ["managementKey", "management_key", "mgmtKey"]) {
    const v = meta[k]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  for (const k of ["managementKey", "management_key", "mgmtKey"]) {
    const v = a[k]
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
export function modelRow(m, base = {}, { subscription = false, api, dev, protocol } = {}) {
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
  // The levels the vendor names, in magpie's spelling, before we translate them
  // to what the protocol under this model can actually be sent.
  const named = baseVariants ? Object.keys(baseVariants) : undefined
  const devLevels = known ? modelsDevLevels(d) : []
  const levels = named ?? (devLevels.length ? devLevels : undefined)
  // magpie swaps a level for the vendor parameter only when the variant says
  // so; without it, "xhigh"/"max" get clamped to high on the way out.
  const protocolVariants = reasoning ? variantsForProtocol(protocol, levels) : undefined
  const variants =
    protocolVariants ??
    baseVariants ??
    modelsDevVariants(d) ??
    (reasoning && !levelsSaid ? EFFORTS : undefined)

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
    // Our routing wins over models.dev's own api entry: the protocol this model
    // is asked on (and so the base it is asked at) is what this plugin decides.
    ...(api ? { api } : {}),
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

// Which API a model is asked on. ZenMux's rich catalogue
// (/api/frontend/model/available/list) lists each model's `suitable_api`, and
// its own OpenCode plugin picks in this order — Anthropic Messages first,
// because that is the only protocol that carries cache_control breakpoints, so
// prompt caching actually works; then OpenAI Responses for the models that
// want its reasoning summaries and conversation state; chat completions last,
// which is the only protocol every model speaks.
export const PROTOCOLS = Object.freeze(["messages", "responses", "chat"])

// Routing order, which is not the same thing: magpie forwards the effort on
// Responses (reasoning.effort) and on chat completions (reasoning_effort as it
// came), but rewrites every Messages request's thinking field to {adaptive},
// which drops the level entirely. So a model is asked on Responses first, then
// chat, and only on Messages when that is all it has.
export const ROUTING_ORDER = Object.freeze(["responses", "chat", "messages"])

const PROTOCOL_ALIASES = new Map([
  ["anthropic", "messages"],
  ["anthropic-messages", "messages"],
  ["messages", "messages"],
  ["openai-responses", "responses"],
  ["responses", "responses"],
  ["chat", "chat"],
  ["chat.completions", "chat"],
  ["chat-completions", "chat"],
  ["openai-completions", "chat"],
])

// toApi is what magpie needs per model: the AI SDK package decides the protocol
// (and so the path after the base), the url is where that protocol lives.
export const AI_SDK = Object.freeze({
  messages: "@ai-sdk/anthropic",
  responses: "@ai-sdk/openai",
  chat: "@ai-sdk/openai-compatible",
})

export function apiFor(protocol, { chatApi, anthropicApi }) {
  if (protocol === "messages") return { url: anthropicApi, npm: AI_SDK.messages }
  if (protocol === "responses") return { url: chatApi, npm: AI_SDK.responses }
  return { url: chatApi, npm: AI_SDK.chat }
}

// collectProtocols gathers every place ZenMux names a protocol for a model:
// the rich catalogue entry spells it `suitable_api`, and its endpoints may each
// carry their own api/adapters.
export function collectProtocols(entry) {
  const out = new Set()
  const add = (v) => {
    if (Array.isArray(v)) {
      for (const x of v) add(x)
      return
    }
    if (typeof v !== "string") return
    for (const part of v.split(",")) {
      const key = PROTOCOL_ALIASES.get(part.trim().toLowerCase())
      if (key) out.add(key)
    }
  }
  if (!isObj(entry)) return out
  add(entry.suitable_api)
  add(entry.api)
  add(entry.protocols)
  add(entry.supported_endpoint_types)
  add(entry.capabilities?.protocols)
  for (const ep of Array.isArray(entry.endpoints) ? entry.endpoints : []) {
    add(ep?.suitable_api)
    add(ep?.api)
    for (const adapter of Array.isArray(ep?.adapters) ? ep.adapters : []) add(adapter?.api)
  }
  return out
}

// collectReasoningProtocols says which protocols a model's adapters actually
// accept a reasoning control on. Plenty of models list a Messages endpoint that
// carries no thinking parameter at all: routing one of those to Messages throws
// the effort away before the request even leaves magpie.
const REASONING_PARAMS = ["reasoning_effort", "reasoning", "thinking", "enable_thinking", "thinking_budget"]

export function collectReasoningProtocols(entry) {
  const out = new Set()
  if (!isObj(entry)) return out
  const consider = (api, params) => {
    const protocol = PROTOCOL_ALIASES.get(String(api ?? "").trim().toLowerCase())
    if (!protocol) return
    if (Array.isArray(params) && params.some((p) => REASONING_PARAMS.includes(String(p)))) out.add(protocol)
  }
  for (const ep of Array.isArray(entry.endpoints) ? entry.endpoints : []) {
    for (const adapter of Array.isArray(ep?.adapters) ? ep.adapters : []) {
      consider(adapter?.api, adapter?.supported_parameters)
    }
    consider(ep?.api, ep?.supported_parameters)
  }
  return out
}

// resolveProtocol picks one protocol the model speaks, best first.
//
// Order of business:
//  1. a model that reasons goes on a protocol whose adapter takes a reasoning
//     parameter — otherwise the level is silently lost (the "max became high"
//     bug: deepseek/deepseek-v4.1-flash lists messages and responses endpoints
//     that carry no thinking parameter, and only chat.completions does);
//  2. otherwise every protocol it lists is fine;
//  3. within that, the catalogue's own preference first, then our order.
export function resolveProtocol(entry, { reasoning = false } = {}) {
  const supported = collectProtocols(entry)
  if (!supported.size) return "chat"

  let pool = supported
  if (reasoning) {
    const withReasoning = collectReasoningProtocols(entry)
    const narrowed = new Set([...supported].filter((p) => withReasoning.has(p)))
    if (narrowed.size) pool = narrowed
  }

  for (const protocol of ROUTING_ORDER) if (pool.has(protocol)) return protocol
  return "chat"
}

// protocolMap collapses the rich catalogue into model slug → protocol.
export function protocolMap(entries) {
  const out = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    const slug = entry?.slug ?? entry?.model_slug
    if (typeof slug !== "string" || !slug) continue
    out.set(slug, resolveProtocol(entry, { reasoning: reasoningOf(entry) }))
  }
  return out
}

// reasoningOf is whether the catalogue says this model reasons.
export function reasoningOf(entry) {
  if (!isObj(entry)) return false
  if (entry.supports_reasoning === true || Number(entry.supports_reasoning) > 0) return true
  for (const ep of Array.isArray(entry.endpoints) ? entry.endpoints : []) {
    if (ep?.supports_reasoning === true || Number(ep?.supports_reasoning) > 0) return true
  }
  return false
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