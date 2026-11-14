// Run with: node --test   (Node 20+; Bun's `bun test` runs it too)
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  AI_SDK,
  apiFor,
  collectProtocols,
  costOf,
  entries,
  isChatModel,
  matches,
  modelRow,
  modelsDevCachePaths,
  modelsDevLevels,
  modelsDevVariants,
  planModelSets,
  protocolMap,
  resolveProtocol,
  subscriptionToUsage,
} from "../zenmux.mjs"
import { ZenMuxBuilderAuthPlugin, _internal } from "../index.mjs"

// The response body from
// https://zenmux.ai/docs/api/platform/subscription-detail.html
const SAMPLE = {
  plan: { tier: "ultra", amount_usd: 200, interval: "month", expires_at: "2026-04-12T08:26:56.000Z" },
  currency: "usd",
  base_usd_per_flow: 0.03283,
  effective_usd_per_flow: 0.03283,
  account_status: "healthy",
  quota_5_hour: {
    usage_percentage: 0.0715,
    resets_at: "2026-03-24T08:35:09.000Z",
    remaining_resets: 1,
    max_flows: 800,
    used_flows: 57.2,
    remaining_flows: 742.8,
    used_value_usd: 1.88,
    max_value_usd: 26.27,
  },
  quota_7_day: {
    usage_percentage: 0.0673,
    resets_at: "2026-03-26T02:15:05.000Z",
    max_flows: 6182,
    used_flows: 416.11,
    remaining_flows: 5765.89,
    used_value_usd: 13.66,
    max_value_usd: 202.99,
  },
  quota_monthly: { max_flows: 34560, max_value_usd: 1134.33 },
}

test("subscriptionToUsage maps the documented payload", () => {
  const u = subscriptionToUsage(SAMPLE)
  assert.equal(u.plan, "Builder Ultra")
  assert.equal(u.until, "2026-04-12T08:26:56.000Z")

  const five = u.windows.find((w) => w.name === "5 hours")
  assert.equal(five.used, 7.15) // percentage, 0-100
  assert.equal(five.resetsAt, "2026-03-24T08:35:09.000Z")
  assert.equal(five.span, 18000)
  assert.equal(five.amount, 57.2)
  assert.equal(five.limit, 800)
  assert.equal(five.unit, "Flows")
  assert.equal(five.display, "57.2 / 800 Flows")

  const week = u.windows.find((w) => w.name === "7 days")
  assert.equal(week.used, 6.73)
  assert.equal(week.span, 604800)
  assert.equal(week.limit, 6182)

  const monthly = u.windows.find((w) => w.name === "monthly")
  assert.equal(monthly.aside, true)
  assert.equal(monthly.display, "34560 Flows/month ($1134.33)")
  assert.equal(monthly.used, undefined)

  assert.deepEqual(u.resets, { count: 1, byWindow: true, fiveHour: 1, until: "2026-04-12T08:26:56.000Z" })
})

test("subscriptionToUsage leaves used out when the vendor doesn't say", () => {
  const u = subscriptionToUsage({
    plan: { tier: "pro" },
    quota_5_hour: { max_flows: 50, used_flows: 0 },
  })
  const five = u.windows.find((w) => w.name === "5 hours")
  assert.equal(five.used, 0) // 0 of 50 is knowably 0
  const noPct = subscriptionToUsage({ quota_5_hour: { max_flows: 0, used_flows: 0 } })
  assert.equal(noPct.windows.length, 0)
})

test("subscriptionToUsage reports a suspended account and hides its windows", () => {
  const u = subscriptionToUsage({ ...SAMPLE, account_status: "suspended" })
  assert.equal(u.windows.length, 0)
  assert.match(u.error, /suspended/)
})

test("subscriptionToUsage survives an empty body", () => {
  assert.deepEqual(subscriptionToUsage(undefined), { windows: [] })
  assert.deepEqual(subscriptionToUsage({}), { windows: [] })
})

test("planModelSets dedupes the endpoints of a plan", () => {
  const sets = planModelSets([
    {
      planKey: "Ultra",
      models: [
        { model_slug: "openai/gpt-6.1-terra", endpoint_slug: "a" },
        { model_slug: "openai/gpt-6.1-terra", endpoint_slug: "b" },
        { model_slug: "deepseek/deepseek-v4.1-flash" },
      ],
    },
    { planKey: "free", models: [{ model_slug: "deepseek/deepseek-v4-flash" }] },
  ])
  assert.deepEqual([...sets.get("ultra")].sort(), ["deepseek/deepseek-v4.1-flash", "openai/gpt-6.1-terra"])
  assert.deepEqual([...sets.get("free")], ["deepseek/deepseek-v4-flash"])
  assert.equal(sets.get("nope"), undefined)
})

test("isChatModel keeps chat models and drops image, video and audio ones", () => {
  const keep = (id, out = ["text"]) => isChatModel({ id, output_modalities: out })
  assert.equal(keep("deepseek/deepseek-v4.1-flash"), true)
  assert.equal(keep("openai/gpt-6.1-terra"), true)
  assert.equal(keep("google/gemini-4-hydrogen"), true)
  assert.equal(keep("openai/gpt-image-2.6-flare", ["image"]), false)
  assert.equal(keep("alibaba/wan3.0-video", ["video"]), false)
  assert.equal(keep("qwen/qwen-audio-3.1-tts-next", ["audio"]), false)
  assert.equal(keep("openai/text-embedding-4"), false)
  assert.equal(isChatModel({ id: "broken" }), false)
  assert.equal(isChatModel(undefined), false)
})

test("isListableNonChat accepts images and videos, rejects junk", () => {
  const { isListableNonChat } = _internal
  assert.equal(isListableNonChat({ id: "openai/gpt-image-2.6-flare", output_modalities: ["image"] }), true)
  assert.equal(isListableNonChat({ id: "alibaba/wan3.0-video", output_modalities: ["video"] }), true)
  assert.equal(isListableNonChat({ id: "qwen/text-embedding-4", output_modalities: ["embeddings"] }), true)
  assert.equal(isListableNonChat({ id: "broken", output_modalities: ["image"] }), false)
  assert.equal(isListableNonChat({ id: "x/y", output_modalities: [] }), false)
  assert.equal(isListableNonChat(null), false)
})

test("costOf reads ZenMux's pricings into magpie's per-million cost", () => {
  const c = costOf({
    pricings: {
      prompt: [{ value: 1.5, unit: "perMTokens", currency: "USD" }],
      completion: [{ value: 7.5, unit: "perMTokens", currency: "USD" }],
      input_cache_read: [{ value: 0.075, unit: "perMTokens", currency: "USD" }],
      input_cache_write: [{ value: 1.875, unit: "perMTokens", currency: "USD" }],
      web_search: [{ value: 0.014, unit: "perCount", currency: "USD" }],
    },
  })
  assert.deepEqual(c, { input: 1.5, output: 7.5, cache: { read: 0.075, write: 1.875 } })
  assert.equal(costOf({ pricings: {} }), undefined)
})

test("modelRow keeps capabilities nested and drops dollars for a plan", () => {
  const live = {
    id: "deepseek/deepseek-v4.1-flash",
    display_name: "DeepSeek: DeepSeek V4.1 Flash",
    context_length: 1000000,
    max_tokens: 384000,
    capabilities: { reasoning: true },
    input_modalities: ["text", "image", "file"],
    output_modalities: ["text"],
    publish_time: "2026-10-17",
    pricings: { prompt: [{ value: 0.5 }], completion: [{ value: 2 }] },
  }
  const plan = modelRow(live, {}, { subscription: true, api: { id: live.id, url: "x", npm: "n" } })
  assert.equal(plan.name, "DeepSeek: DeepSeek V4.1 Flash")
  assert.equal(plan.limit.context, 1000000)
  assert.equal(plan.limit.output, 384000)
  assert.equal(plan.capabilities.reasoning, true)
  assert.equal(plan.capabilities.toolcall, true)
  assert.equal(plan.capabilities.attachment, true)
  assert.equal(plan.capabilities.input.file, true)
  assert.deepEqual(Object.keys(plan.variants), ["low", "medium", "high"])
  assert.equal(plan.api.npm, "n")
  assert.equal(plan.release_date, "2026-10-17")
  assert.equal(plan.cost, undefined) // a Builder Plan spends Flows

  const payg = modelRow(live, {}, { subscription: false })
  assert.deepEqual(payg.cost, { input: 0.5, output: 2 })
})

test("modelRow falls back to our levels when models.dev's are empty", () => {
  const live = { id: "x/y", display_name: "Y", capabilities: { reasoning: true }, output_modalities: ["text"] }
  const row = modelRow(live, { variants: {}, id: "x/y" })
  assert.deepEqual(Object.keys(row.variants), ["low", "medium", "high"])
})

test("matches understands exact ids, globs and vendor prefixes", () => {
  assert.equal(matches("openai/gpt-6.1-terra", "openai/gpt-6.1-terra"), true)
  assert.equal(matches("openai/gpt-6.1-terra", "openai/"), true)
  assert.equal(matches("openai/gpt-6.1-terra", "openai/*"), true)
  assert.equal(matches("openai/gpt-6.1-terra", "anthropic/"), false)
  assert.equal(matches("deepseek/deepseek-v4.1-flash", "deepseek/*flash"), true)
})

test("entries accepts arrays, strings and objects", () => {
  assert.deepEqual(entries(["a/b", " c/d "]), ["a/b", "c/d"])
  assert.deepEqual(entries("a/b, c/d"), ["a/b", "c/d"])
  assert.deepEqual(entries({ "a/b": true }), ["a/b"])
  assert.deepEqual(entries(null), [])
})


test("resolveProtocol prefers Messages, then Responses, then chat", () => {
  // ZenMux's own OpenCode plugin uses this order: cache_control lives only in
  // the Anthropic protocol, then Responses adds reasoning state, chat last.
  assert.equal(resolveProtocol({ suitable_api: "chat.completions" }), "chat")
  assert.equal(resolveProtocol({ suitable_api: "chat.completions,responses" }), "responses")
  assert.equal(resolveProtocol({ suitable_api: "chat.completions,messages,responses" }), "messages")
  assert.equal(resolveProtocol({ suitable_api: "responses,messages,chat.completions" }), "messages")
  assert.equal(resolveProtocol({ suitable_api: "messages" }), "messages")
  assert.equal(resolveProtocol({ suitable_api: "responses" }), "responses")
  // an unexpected protocol (imagen, videos, …) falls back to chat
  assert.equal(resolveProtocol({ suitable_api: "imagen" }), "chat")
  assert.equal(resolveProtocol({}), "chat")
  assert.equal(resolveProtocol(undefined), "chat")
})

test("collectProtocols reads every place a protocol is named", () => {
  const fromEndpoints = collectProtocols({
    endpoints: [
      { suitable_api: "chat.completions" },
      { adapters: [{ api: "openai-responses" }] },
    ],
  })
  assert.deepEqual([...fromEndpoints].sort(), ["chat", "responses"])

  const spread = collectProtocols({ protocols: ["anthropic"], capabilities: { protocols: "messages" } })
  assert.deepEqual([...spread], ["messages"])
  assert.equal(collectProtocols(null).size, 0)
})

test("apiFor maps a protocol to the package and base that serve it", () => {
  const bases = { chatApi: "https://z/api/v1", anthropicApi: "https://z/api/anthropic/v1" }
  assert.deepEqual(apiFor("messages", bases), { url: bases.anthropicApi, npm: AI_SDK.messages })
  assert.deepEqual(apiFor("responses", bases), { url: bases.chatApi, npm: AI_SDK.responses })
  assert.deepEqual(apiFor("chat", bases), { url: bases.chatApi, npm: AI_SDK.chat })
})

test("protocolMap collapses the catalogue by slug and keeps the first protocol", () => {
  const map = protocolMap([
    { slug: "a/chat-only", suitable_api: "chat.completions" },
    { slug: "b/all", suitable_api: "chat.completions,messages,responses" },
    { model_slug: "c/resp", suitable_api: "responses" },
    { slug: "" },
  ])
  assert.equal(map.get("a/chat-only"), "chat")
  assert.equal(map.get("b/all"), "messages")
  assert.equal(map.get("c/resp"), "responses")
  assert.equal(map.size, 3)
  assert.equal(protocolMap(undefined).size, 0)
})

test("modelRow's own api wins over models.dev's (routing regression)", () => {
  // models.dev entries carry their own api {npm,url}; if that survived, the
  // plugin's protocol routing would be silently ignored for every known model.
  const live = { id: "a/b", display_name: "B", capabilities: { reasoning: false }, output_modalities: ["text"] }
  const base = {
    id: "a/b",
    api: { id: "a/b", url: "https://models.dev/v1", npm: "@ai-sdk/openai-compatible" },
    limit: { context: 1000, output: 100 },
  }
  const routed = modelRow(live, base, {
    api: { id: "a/b", url: "https://zenmux.ai/api/anthropic/v1", npm: "@ai-sdk/anthropic" },
  })
  assert.equal(routed.api.npm, "@ai-sdk/anthropic")
  assert.equal(routed.api.url, "https://zenmux.ai/api/anthropic/v1")
})

test("probeCandidates prefers mainstream models, then cheap ones", () => {
  const { probeCandidates } = _internal
  const models = [
    { id: "openai/gpt-6.1-terra", context_length: 1050000, output_modalities: ["text"] },
    { id: "anthropic/claude-fable-5.2", context_length: 200000, output_modalities: ["text"] },
    { id: "deepseek/deepseek-v4.1-flash", context_length: 1000000, output_modalities: ["text"] },
    { id: "openai/gpt-image-2.6-flare", context_length: 32000, output_modalities: ["image"] },
  ]
  const list = probeCandidates(models)
  assert.equal(list[0], "deepseek/deepseek-v4.1-flash") // the first preferred one present
  assert.ok(!list.includes("openai/gpt-image-2.6-flare")) // never a non-chat model

  // A plan that serves only the Anthropic model: nothing else is worth trying.
  const served = new Set(["anthropic/claude-fable-5.2"])
  assert.deepEqual(probeCandidates(models, served), ["anthropic/claude-fable-5.2"])
  assert.deepEqual(probeCandidates([], served), [])
})

// validateSubscriptionKey against a stubbed ZenMux, so every status is covered.
function stubFetch(handler) {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = await handler(String(url), init)
    return new Response(body.text ?? "", { status: body.status, headers: { "content-type": "application/json" } })
  }
  return () => {
    globalThis.fetch = original
  }
}

const MODELS = [{ id: "deepseek/deepseek-v4.1-flash", context_length: 1000000, output_modalities: ["text"] }]
const mgmt403 = { status: 403, text: '{"success":false,"message":"Invalid API key"}' }

test("validateSubscriptionKey: a 200 chat request proves the key", async () => {
  const { validateSubscriptionKey } = _internal
  const restore = stubFetch((url) => {
    if (url.includes("/management/generation")) return mgmt403
    return { status: 200, text: "{}" }
  })
  try {
    const v = await validateSubscriptionKey("sk-subs-x", { models: MODELS })
    assert.equal(v.ok, true)
    assert.equal(v.via, "chat")
  } finally {
    restore()
  }
})

test("validateSubscriptionKey: the management metering 404 is a fast yes", async () => {
  const { validateSubscriptionKey } = _internal
  const restore = stubFetch(() => ({ status: 404, text: "{}" }))
  try {
    const v = await validateSubscriptionKey("sk-subs-x", { models: MODELS })
    assert.deepEqual([v.ok, v.via], [true, "metering"])
  } finally {
    restore()
  }
})

test("validateSubscriptionKey: a 403 about the key is a no", async () => {
  const { validateSubscriptionKey } = _internal
  const restore = stubFetch(() => ({
    status: 403,
    text: '{"error":{"code":"403","type":"access_denied","message":"You have no permission to access this resource (api_key_source: subscription)"}}',
  }))
  try {
    const v = await validateSubscriptionKey("sk-subs-x", { models: MODELS })
    assert.equal(v.ok, false)
    assert.equal(v.status, 403)
    assert.match(v.message, /no permission/)
  } finally {
    restore()
  }
})

test("validateSubscriptionKey: 404 on every model still means the key got through", async () => {
  const { validateSubscriptionKey } = _internal
  const restore = stubFetch((url) => {
    if (url.includes("/management/generation")) return mgmt403
    return { status: 404, text: '{"error":{"message":"Server encountered an unexpected error."}}' }
  })
  try {
    const v = await validateSubscriptionKey("sk-subs-x", { models: MODELS })
    assert.equal(v.ok, true)
    assert.equal(v.via, "probe-inconclusive")
  } finally {
    restore()
  }
})

test("validateSubscriptionKey: a spent allowance (429) is still a good key", async () => {
  const { validateSubscriptionKey } = _internal
  const restore = stubFetch((url) => {
    if (url.includes("/management/generation")) return mgmt403
    return { status: 429, text: '{"error":{"message":"rate limited"}}' }
  })
  try {
    const v = await validateSubscriptionKey("sk-subs-x", { models: MODELS })
    assert.deepEqual([v.ok, v.via], [true, "chat-throttled"])
  } finally {
    restore()
  }
})

test("validateSubscriptionKey: a 403 naming a model tries the next one", async () => {
  const { validateSubscriptionKey } = _internal
  let calls = 0
  const restore = stubFetch((url) => {
    if (url.includes("/management/generation")) return mgmt403
    calls++
    if (calls === 1) return { status: 403, text: '{"error":{"message":"model not available in your plan"}}' }
    return { status: 200, text: "{}" }
  })
  try {
    const v = await validateSubscriptionKey("sk-subs-x", {
      models: [
        { id: "deepseek/deepseek-v4.1-flash", context_length: 1000000, output_modalities: ["text"] },
        { id: "openai/gpt-6.1-terra", context_length: 1000000, output_modalities: ["text"] },
      ],
    })
    assert.deepEqual([v.ok, v.via], [true, "chat"])
  } finally {
    restore()
  }
})

test("isKeyRefusal marks a dead key but not a model outside the plan", () => {
  const { isKeyRefusal } = _internal
  assert.equal(
    isKeyRefusal(403, '{"error":{"code":"403","type":"access_denied","message":"You have no permission to access this resource (api_key_source: subscription)"}}'),
    true,
  )
  assert.equal(isKeyRefusal(403, '{"error":{"message":"Invalid API key"}}'), true)
  assert.equal(isKeyRefusal(403, '{"error":{"message":"model not_available: this model is not in your plan"}}'), false)
  assert.equal(isKeyRefusal(401, ""), true)
  assert.equal(isKeyRefusal(429, "slow down"), false)
})
// ---- models.dev alignment ----------------------------------------------------
//
// models.dev's provider-scoped entry for a model: `reasoning_options` is where
// models.dev names the reasoning levels, which the live ZenMux catalogue never
// says. magpie hands the models hook the entry as a Model (base below); the
// levels only survive in the raw entry (dev).
const DEV_DEEPSEEK = {
  id: "deepseek/deepseek-v4.1-flash",
  name: "DeepSeek V4.1 Flash",
  description: "DeepSeek V4.1 Flash model for reasoning and agentic coding",
  family: "deepseek-flash",
  attachment: true,
  reasoning: true,
  reasoning_options: [
    { type: "toggle" },
    { type: "effort", values: ["low", "high", "max"] },
  ],
  tool_call: true,
  interleaved: { field: "reasoning_content" },
  structured_output: true,
  temperature: true,
  release_date: "2026-09-10",
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 1000000, output: 384000 },
  cost: { input: 0.075, output: 0.3, cache_read: 0.0015 },
}

const BASE_DEEPSEEK = {
  id: "deepseek/deepseek-v4.1-flash",
  providerID: "zenmux",
  name: "DeepSeek V4.1 Flash",
  family: "deepseek-flash",
  api: { id: "deepseek/deepseek-v4.1-flash", url: "https://zenmux.ai/api/v1", npm: "@ai-sdk/openai-compatible" },
  status: "active",
  headers: {},
  options: {},
  cost: { input: 0.075, output: 0.3, cache: { read: 0.0015, write: 0 } },
  limit: { context: 1000000, output: 384000 },
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, image: true, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: { field: "reasoning_content" },
  },
  release_date: "2026-09-10",
  variants: {},
}

const LIVE_DEEPSEEK = {
  id: "deepseek/deepseek-v4.1-flash",
  object: "model",
  display_name: "DeepSeek: DeepSeek V4.1 Flash 1017",
  input_modalities: ["image", "text", "file"],
  output_modalities: ["text"],
  capabilities: { reasoning: true },
  context_length: 1000000,
  max_tokens: 384000,
  pricings: { prompt: [{ value: 0.15 }], completion: [{ value: 0.6 }] },
  publish_time: "2026-10-17",
}

const DEV_KIMI = {
  id: "moonshotai/kimi-k3",
  name: "Kimi K3",
  attachment: true,
  reasoning: true,
  reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["max"] }],
  tool_call: true,
  temperature: false,
  release_date: "2026-07-16",
  modalities: { input: ["text", "image", "video"], output: ["text"] },
  limit: { context: 1048576, output: 131072 },
  cost: { input: 3, output: 15, cache_read: 0.3 },
}

const BASE_KIMI = {
  ...BASE_DEEPSEEK,
  id: "moonshotai/kimi-k3",
  name: "Kimi K3",
  family: "kimi-k3",
  api: { id: "moonshotai/kimi-k3", url: "https://zenmux.ai/api/v1", npm: "@ai-sdk/openai-compatible" },
  cost: { input: 3, output: 15, cache: { read: 0.3, write: 0 } },
  limit: { context: 1048576, output: 131072 },
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, image: true, audio: false, video: true, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
  },
}

const LIVE_KIMI = {
  id: "moonshotai/kimi-k3",
  display_name: "MoonshotAI: Kimi K3",
  input_modalities: ["text", "image", "video"],
  output_modalities: ["text"],
  capabilities: { reasoning: true },
  context_length: 1048576,
  max_tokens: 262144,
  pricings: { prompt: [{ value: 3 }], completion: [{ value: 15 }] },
  publish_time: "2026-07-17",
}

const DEV_TOGGLE = {
  id: "x/toggle-only",
  name: "Toggle Only",
  reasoning: true,
  reasoning_options: [{ type: "toggle" }],
  tool_call: true,
  modalities: { input: ["text"], output: ["text"] },
  limit: { context: 128000, output: 8192 },
}

test("modelsDevLevels reads models.dev's reasoning_options in order", () => {
  assert.deepEqual(modelsDevLevels(DEV_DEEPSEEK), ["low", "high", "max"])
  assert.deepEqual(modelsDevLevels(DEV_KIMI), ["max"])
  assert.deepEqual(modelsDevLevels({ reasoning_options: [{ type: "toggle" }] }), [])
  assert.deepEqual(modelsDevLevels({ reasoning_options: [{ type: "effort", values: ["low", "low", " "] }] }), ["low"])
  assert.deepEqual(modelsDevLevels(undefined), [])
})

test("modelsDevVariants maps levels to variants and keeps 'none named' distinct", () => {
  assert.deepEqual(modelsDevVariants(DEV_KIMI), { max: {} })
  assert.deepEqual(modelsDevVariants({ variants: { low: {}, high: {} } }), { low: {}, high: {} })
  // models.dev knows the model but names no level: no favourites, not a fallback
  assert.equal(modelsDevVariants({ reasoning: true, reasoning_options: [{ type: "toggle" }] }), undefined)
  assert.equal(modelsDevVariants(undefined), undefined)
})

test("modelRow takes models.dev's answer for a model it knows", () => {
  const row = modelRow(LIVE_DEEPSEEK, BASE_DEEPSEEK, {
    subscription: true,
    api: { id: LIVE_DEEPSEEK.id, url: "x", npm: "n" },
    dev: DEV_DEEPSEEK,
  })
  // models.dev's name, levels and price, not the live catalogue's.
  assert.equal(row.name, "DeepSeek V4.1 Flash")
  assert.deepEqual(Object.keys(row.variants), ["low", "high", "max"])
  assert.equal(row.reasoning, true)
  assert.equal(row.capabilities.toolcall, true)
  assert.equal(row.capabilities.attachment, true)
  // input kinds are models.dev's (no live "file"), with text kept
  assert.deepEqual(row.capabilities.input, { text: true, image: true, audio: false, video: false, pdf: false })
  // a plan draws Flows: no dollars
  assert.equal(row.cost, undefined)
  assert.equal(row.release_date, "2026-09-10")
})

test("modelRow takes models.dev's limits and price over the live catalogue", () => {
  const row = modelRow(LIVE_KIMI, BASE_KIMI, {
    subscription: false,
    api: { id: LIVE_KIMI.id, url: "x", npm: "n" },
    dev: DEV_KIMI,
  })
  assert.equal(row.name, "Kimi K3") // not "MoonshotAI: Kimi K3"
  assert.deepEqual(row.variants, { max: {} }) // models.dev's only level
  assert.equal(row.limit.output, 131072) // models.dev's, not the live 262144
  assert.equal(row.limit.context, 1048576)
  assert.equal(row.capabilities.temperature, false) // models.dev says it takes none
  assert.deepEqual(row.cost, { input: 3, output: 15, cache: { read: 0.3, write: 0 } })
  assert.deepEqual(row.modalities.input, ["text", "image", "video"])
})

test("modelRow gives no levels where models.dev names none", () => {
  const live = {
    id: "x/toggle-only",
    display_name: "Toggle Live",
    input_modalities: ["text"],
    output_modalities: ["text"],
    capabilities: { reasoning: true },
    context_length: 64000,
    max_tokens: 2048,
  }
  const row = modelRow(live, {}, { subscription: true, dev: DEV_TOGGLE })
  assert.equal(row.reasoning, true)
  assert.equal(row.variants, undefined) // a toggle has no levels to pick
  assert.equal(row.name, "Toggle Only")
  assert.equal(row.limit.context, 128000) // models.dev's, since the live said 64000
  assert.equal(row.limit.output, 8192)
})

test("modelRow keeps the config's own variants over models.dev's", () => {
  const row = modelRow(LIVE_KIMI, { ...BASE_KIMI, variants: { low: {} } }, {
    subscription: true,
    dev: DEV_KIMI,
  })
  assert.deepEqual(row.variants, { low: {} })
})

test("modelsDevCachePaths finds magpie's models.dev snapshot", () => {
  // magpie's cache is ~/.cache/magpie on every platform (its sync says so)
  assert.deepEqual(modelsDevCachePaths({ XDG_CACHE_HOME: "/x/cache" }, "linux", "/home/u"), [
    "/x/cache/magpie/models.json",
    "/home/u/.cache/magpie/models.json",
  ])
  assert.deepEqual(modelsDevCachePaths({}, "linux", "/home/u"), ["/home/u/.cache/magpie/models.json"])
  // Windows keeps it under the user profile; %LocalAppData% is a fallback
  assert.deepEqual(modelsDevCachePaths({}, "win32", "C:\\Users\\u"), [
    "C:/Users/u/.cache/magpie/models.json",
    "C:/Users/u/AppData/Local/magpie/models.json",
  ])
  assert.deepEqual(
    modelsDevCachePaths({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u"),
    ["C:/Users/u/.cache/magpie/models.json", "C:/Users/u/AppData/Local/magpie/models.json"],
  )
  // macOS: magpie's cache first, then Go's own cache folder
  assert.deepEqual(modelsDevCachePaths({}, "darwin", "/Users/u"), [
    "/Users/u/.cache/magpie/models.json",
    "/Users/u/Library/Caches/magpie/models.json",
  ])
})

test("modelsDevModels reads magpie's models.dev snapshot", async () => {
  const { modelsDevModels } = _internal
  const root = await mkdtemp(join(tmpdir(), "magpie-models-dev-"))
  // Hide the real ~/.cache/magpie/models.json this machine may have.
  const savedHome = process.env.HOME
  process.env.HOME = join(root, "home")
  try {
    const cache = join(root, "cache")
    await mkdir(join(cache, "magpie"), { recursive: true })
    await writeFile(
      join(cache, "magpie", "models.json"),
      JSON.stringify({
        deepseek: { id: "deepseek", models: {} },
        zenmux: { id: "zenmux", models: { [DEV_DEEPSEEK.id]: DEV_DEEPSEEK } },
      }),
    )
    const models = modelsDevModels({ XDG_CACHE_HOME: cache })
    assert.equal(models[DEV_DEEPSEEK.id].name, "DeepSeek V4.1 Flash")
    assert.deepEqual(models[DEV_DEEPSEEK.id].reasoning_options[1].values, ["low", "high", "max"])

    // no snapshot and a broken snapshot both read as none, not an error
    assert.deepEqual(modelsDevModels({ XDG_CACHE_HOME: join(root, "empty") }), {})
    const broken = join(root, "broken")
    await mkdir(join(broken, "magpie"), { recursive: true })
    await writeFile(join(broken, "magpie", "models.json"), "{ not json")
    assert.deepEqual(modelsDevModels({ XDG_CACHE_HOME: broken }), {})
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    await rm(root, { recursive: true, force: true })
  }
})

test("models hook aligns every row with models.dev", async () => {
  const root = await mkdtemp(join(tmpdir(), "magpie-models-hook-"))
  const cache = join(root, "cache")
  await mkdir(join(cache, "magpie"), { recursive: true })
  await writeFile(
    join(cache, "magpie", "models.json"),
    JSON.stringify({ zenmux: { id: "zenmux", models: { [DEV_DEEPSEEK.id]: DEV_DEEPSEEK } } }),
  )
  const liveOnly = {
    id: "new/model",
    display_name: "New Model",
    input_modalities: ["text"],
    output_modalities: ["text"],
    capabilities: { reasoning: true },
    context_length: 200000,
    max_tokens: 8192,
  }
  const saved = { HOME: process.env.HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME }
  process.env.HOME = join(root, "home")
  process.env.XDG_CACHE_HOME = cache
  const restore = stubFetch(() => ({ status: 200, text: JSON.stringify({ data: [LIVE_DEEPSEEK, liveOnly] }) }))
  try {
    const plugin = await ZenMuxBuilderAuthPlugin({}, {})
    const rows = await plugin.provider.models(
      { models: { [BASE_DEEPSEEK.id]: BASE_DEEPSEEK } },
      { auth: { key: "sk-subs-x" } },
    )
    const known = rows[LIVE_DEEPSEEK.id]
    assert.ok(known)
    assert.deepEqual(Object.keys(known.variants), ["low", "high", "max"])
    assert.equal(known.name, "DeepSeek V4.1 Flash")
    assert.equal(known.limit.output, 384000)

    // a model models.dev does not know keeps the live entry and our levels
    const unknown = rows["new/model"]
    assert.ok(unknown)
    assert.equal(unknown.name, "New Model")
    assert.deepEqual(Object.keys(unknown.variants), ["low", "medium", "high"])
  } finally {
    restore()
    if (saved.HOME === undefined) delete process.env.HOME
    else process.env.HOME = saved.HOME
    if (saved.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = saved.XDG_CACHE_HOME
    await rm(root, { recursive: true, force: true })
  }
})

test("config hook declares the provider but leaves the models to models.dev", async () => {
  const plugin = await ZenMuxBuilderAuthPlugin({}, {})
  const cfg = { provider: {} }
  await plugin.config(cfg)
  assert.deepEqual(cfg.provider.zenmux, {
    name: "ZenMux",
    npm: "@ai-sdk/openai-compatible",
    api: "https://zenmux.ai/api/v1",
  })

  // a provider entry the user already has is left alone, models and all
  const own = { provider: { zenmux: { api: "https://example.test/v1", models: { "own/model": { name: "Own" } } } } }
  await plugin.config(own)
  assert.deepEqual(own.provider.zenmux, { api: "https://example.test/v1", models: { "own/model": { name: "Own" } } })
})

test("modelRow never says an image model gives text", () => {
  const dev = {
    id: "x/image",
    name: "Image",
    reasoning: false,
    tool_call: false,
    modalities: { input: ["text"], output: ["image"] },
    limit: { context: 10240, output: 0 },
  }
  const live = {
    id: "x/image",
    display_name: "Image",
    input_modalities: ["text"],
    output_modalities: ["image"],
    context_length: 10240,
  }
  const row = modelRow(live, {}, { dev })
  assert.deepEqual(row.capabilities.output, { text: false, image: true, audio: false, video: false, pdf: false })
  assert.deepEqual(row.modalities.output, ["image"])
  assert.deepEqual(row.capabilities.input, { text: true, image: false, audio: false, video: false, pdf: false })

  // a live-only model the same way: no text output invented
  const only = modelRow({ ...live }, {}, {})
  assert.equal(only.capabilities.output.text, undefined)
  assert.deepEqual(only.modalities.output, ["image"])
})

test("modelRow keeps our levels when a models.dev entry predates reasoning_options", () => {
  const live = {
    id: "x/old-entry",
    display_name: "Old Entry",
    input_modalities: ["text"],
    output_modalities: ["text"],
    capabilities: { reasoning: true },
    context_length: 128000,
    max_tokens: 8192,
  }
  // a snapshot from before models.dev named levels: the entry exists, says it
  // reasons, and says nothing of which levels
  const dev = { id: "x/old-entry", name: "Old Entry", reasoning: true, tool_call: true }
  const row = modelRow(live, {}, { dev, subscription: true })
  assert.equal(row.reasoning, true)
  assert.deepEqual(Object.keys(row.variants), ["low", "medium", "high"])

  // ...but an entry that names "toggle only" is an answer: no levels offered
  const toggle = { ...dev, reasoning_options: [{ type: "toggle" }] }
  assert.equal(modelRow(live, {}, { dev: toggle }).variants, undefined)
})
