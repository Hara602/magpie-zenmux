// Run with: node --test   (Node 20+; Bun's `bun test` runs it too)
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  AI_SDK,
  THINKING_BUDGETS,
  budgetForLevel,
  apiFor,
  collectProtocols,
  collectReasoningProtocols,
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
  variantsForProtocol,
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
  assert.deepEqual(Object.keys(plan.variants), ["low", "medium", "high", "xhigh", "max"])
  assert.equal(plan.api.npm, "n")
  assert.equal(plan.release_date, "2026-10-17")
  assert.equal(plan.cost, undefined) // a Builder Plan spends Flows

  const payg = modelRow(live, {}, { subscription: false })
  assert.deepEqual(payg.cost, { input: 0.5, output: 2 })
})

test("modelRow exposes all five fallback levels when level metadata is missing", () => {
  const live = { id: "x/y", display_name: "Y", capabilities: { reasoning: true }, output_modalities: ["text"] }
  for (const protocol of [undefined, "chat", "responses", "messages"]) {
    const row = modelRow(live, { variants: {}, id: "x/y" }, { protocol })
    assert.deepEqual(Object.keys(row.variants), ["low", "medium", "high", "xhigh", "max"])
    if (protocol === "chat" || protocol === "responses") {
      assert.equal(row.variants.xhigh.reasoningEffort, "xhigh")
      assert.equal(row.variants.max.reasoningEffort, "max")
    }
  }
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


test("resolveProtocol prefers the vendor's own protocol, then Responses, then chat", () => {
  // ZenMux's protocol-conversion doc: Chat <-> Responses pass the effort through
  // unchanged; converting to Messages maps it to a budget that stops at high.
  // The catalogue's first suitable_api is the vendor's native protocol, which
  // needs no conversion at all.
  assert.equal(resolveProtocol({ suitable_api: "chat.completions" }), "chat")
  assert.equal(resolveProtocol({ suitable_api: "chat.completions,responses" }), "chat")
  assert.equal(resolveProtocol({ suitable_api: "responses,chat.completions" }), "responses")
  assert.equal(resolveProtocol({ suitable_api: "messages" }), "messages")
  // an unexpected protocol falls back to chat, which every model speaks
  assert.equal(resolveProtocol({ suitable_api: "imagen" }), "chat")
  assert.equal(resolveProtocol({}), "chat")
  assert.equal(resolveProtocol(undefined), "chat")
})

test("resolveProtocol keeps a reasoning model off Messages unless it has nothing else", () => {
  // deepseek/deepseek-v4.1-flash: DeepSeek documents effort as low/high/max, and
  // ZenMux converts to Messages with a mapping that has no "max" row — so a
  // reasoning model stays on its native chat protocol.
  const deepseek = {
    suitable_api: "chat.completions",
    supports_reasoning: 1,
    endpoints: [{ adapters: [{ api: "chat.completions", supported_parameters: ["reasoning_effort", "thinking"] }] }],
  }
  assert.equal(resolveProtocol(deepseek, { reasoning: true }), "chat")

  // A reasoner that only has Messages still goes there; the plugin then sends an
  // explicit thinking budget instead of letting the level collapse.
  const messagesOnly = { suitable_api: "messages", supports_reasoning: 1, endpoints: [] }
  assert.equal(resolveProtocol(messagesOnly, { reasoning: true }), "messages")

  // Without the reasoning flag the narrowing does not apply.
  const both = { suitable_api: "messages", endpoints: [], supports_reasoning: 0 }
  assert.equal(resolveProtocol(both), "messages")
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
  assert.equal(map.get("b/all"), "chat")
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


test("variantsForProtocol sends the vendor's own level names verbatim", () => {
  // DeepSeek documents effort as low/high/max on its Chat and Responses APIs, so
  // "max" is offered and sent as "max": no renaming, no clamping.
  const chat = variantsForProtocol("chat", ["low", "high", "max"])
  assert.deepEqual(Object.keys(chat), ["low", "high", "max"])
  assert.equal(chat.max.reasoningEffort, "max")

  const resp = variantsForProtocol("responses", ["low", "high", "max"])
  assert.deepEqual(Object.keys(resp), ["low", "high", "max"])
  assert.equal(resp.max.reasoningEffort, "max")

  // The transport cannot invent levels that the model never declared.
  assert.equal(variantsForProtocol("responses"), undefined)
  assert.equal(variantsForProtocol("chat", []), undefined)

  // Messages has no effort names; the named levels are left alone and the
  // collapsed "adaptive" becomes a budget on the way out (see below).
  assert.equal(variantsForProtocol("messages", ["low", "high"]), undefined)
})

test("budgetForLevel follows ZenMux's own low/medium/high budgets", () => {
  // protocol-conversion maps low/medium/high to 2048/5120/10240 budget tokens.
  assert.equal(budgetForLevel("low"), 2048)
  assert.equal(budgetForLevel("medium"), 5120)
  assert.equal(budgetForLevel("high"), 10240)
  // Nothing above high is in that mapping, so a client's top level gets a real
  // budget instead of being folded back onto high.
  assert.equal(budgetForLevel("max"), 32768)
  assert.equal(budgetForLevel("xhigh"), 24576)
  assert.equal(budgetForLevel(undefined), 10240)
})

test("request rewrites magpie's collapsed adaptive thinking into a budget", async () => {
  const { request } = _internal
  const calls = []
  const restore = stubFetch((url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { status: 200, text: "{}" }
  })
  const url = "https://zenmux.ai/api/anthropic/v1/messages"
  try {
    await request(
      "tok",
      url,
      { method: "POST", body: JSON.stringify({ model: "m", max_tokens: 20480, messages: [], thinking: { type: "adaptive" } }) },
      { effort: "max" },
    )
    // Anthropic requires budget_tokens < max_tokens, so 80% of 20480 is the cap
    assert.deepEqual(calls[0].body.thinking, { type: "enabled", budget_tokens: 16384 })

    // with room for it, "max" gets its full budget
    await request(
      "tok",
      url,
      { method: "POST", body: JSON.stringify({ model: "m", max_tokens: 65536, messages: [], thinking: { type: "adaptive" } }) },
      { effort: "max" },
    )
    assert.equal(calls[1].body.thinking.budget_tokens, 32768)

    // a level the caller did send wins over the option
    await request(
      "tok",
      url,
      { method: "POST", body: JSON.stringify({ model: "m", max_tokens: 20480, messages: [], reasoning_effort: "low", thinking: { type: "adaptive" } }) },
      {},
    )
    assert.deepEqual(calls[2].body.thinking, { type: "enabled", budget_tokens: 2048 })

    // a budget the caller already set is left alone
    await request(
      "tok",
      url,
      { method: "POST", body: JSON.stringify({ model: "m", max_tokens: 20480, messages: [], thinking: { type: "enabled", budget_tokens: 4096 } }) },
      {},
    )
    assert.equal(calls[3].body.thinking.budget_tokens, 4096)

    // never more than max_tokens can hold
    await request(
      "tok",
      url,
      { method: "POST", body: JSON.stringify({ model: "m", max_tokens: 1200, messages: [], thinking: { type: "adaptive" } }) },
      { effort: "max" },
    )
    assert.equal(calls[4].body.thinking.budget_tokens, 1024)
  } finally {
    restore()
  }
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

test("validateSubscriptionKey: management endpoints cannot prove inference access", async () => {
  const { validateSubscriptionKey } = _internal
  const paths = []
  const restore = stubFetch((url) => {
    paths.push(new URL(url).pathname)
    return { status: 404, text: "{}" }
  })
  try {
    const v = await validateSubscriptionKey("sk-subs-x", { models: MODELS })
    assert.deepEqual([v.ok, v.via], [true, "probe-inconclusive"])
    assert.deepEqual(paths, ["/api/v1/chat/completions"])
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
  const row = modelRow(live, {}, { subscription: true, dev: DEV_TOGGLE, protocol: "chat" })
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
    protocol: "chat",
  })
  assert.deepEqual(row.variants, { low: { reasoningEffort: "low" } })
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
    // "max" is a level the vendor documents, so it is offered and sent as-is
    assert.deepEqual(Object.keys(known.variants), ["low", "high", "max"])
    assert.equal(known.variants.max.reasoningEffort, "max")
    assert.equal(known.name, "DeepSeek V4.1 Flash")
    assert.equal(known.limit.output, 384000)

    // a model models.dev does not know keeps the live entry and our levels
    const unknown = rows["new/model"]
    assert.ok(unknown)
    assert.equal(unknown.name, "New Model")
    // Unknown reasoning models use the five configured fallback levels.
    assert.deepEqual(Object.keys(unknown.variants), ["low", "medium", "high", "xhigh", "max"])
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
  const row = modelRow(live, {}, { dev, subscription: true, protocol: "chat" })
  assert.equal(row.reasoning, true)
  assert.deepEqual(Object.keys(row.variants), ["low", "medium", "high", "xhigh", "max"])

  // ...but an entry that names "toggle only" is an answer: no levels offered
  const toggle = { ...dev, reasoning_options: [{ type: "toggle" }] }
  assert.equal(modelRow(live, {}, { dev: toggle, protocol: "chat" }).variants, undefined)
})

test("modelRow offers only the model's declared levels on each real route", () => {
  for (const protocol of ["chat", "responses", "messages"]) {
    const row = modelRow(LIVE_DEEPSEEK, BASE_DEEPSEEK, { dev: DEV_DEEPSEEK, protocol })
    assert.deepEqual(Object.keys(row.variants), ["low", "high", "max"])
    if (protocol !== "messages") assert.equal(row.variants.max.reasoningEffort, "max")

    const toggle = modelRow(LIVE_DEEPSEEK, {}, { dev: DEV_TOGGLE, protocol })
    assert.equal(toggle.variants, undefined)

    const legacy = modelRow(LIVE_DEEPSEEK, {}, {
      dev: { reasoning: true, variants: { high: {}, max: {} } },
      protocol,
    })
    assert.deepEqual(Object.keys(legacy.variants), ["high", "max"])
  }
})

test("selected effort survives protocol translation and private headers stay local", async () => {
  const calls = []
  const restore = stubFetch((url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: new Headers(init.headers) })
    return { status: 200, text: "{}" }
  })
  try {
    for (const level of ["low", "high", "max", "xhigh"]) {
      for (const path of ["chat/completions", "responses", "messages"]) {
        await _internal.request("fake", `https://zenmux.ai/api/v1/${path}`, {
          method: "POST",
          headers: { "x-magpie-effort": level, "x-magpie-work-dir": "/private/project" },
          body: JSON.stringify({
            max_tokens: 65536,
            reasoning_effort: "high",
            reasoning: { effort: "high", summary: "auto" },
            thinking: { type: "adaptive" },
            messages: [],
          }),
        })
        const sent = calls.at(-1)
        assert.ok(![...sent.headers.keys()].some((name) => name.startsWith("x-magpie-")))
        if (path === "messages") {
          assert.equal(sent.body.thinking.budget_tokens, budgetForLevel(level))
        } else if (path === "responses") {
          assert.equal(sent.body.reasoning.effort, level)
          assert.equal(sent.body.reasoning.summary, "auto")
        } else {
          assert.equal(sent.body.reasoning_effort, level)
        }
      }
    }
  } finally {
    restore()
  }
})

test("Messages thinking stays valid for small output limits and none disables it", async () => {
  let sent
  const restore = stubFetch((_url, init) => {
    sent = JSON.parse(init.body)
    return { status: 200, text: "{}" }
  })
  try {
    for (const max of [1, 16, 1024, 1025, 1200, 65536]) {
      await _internal.request("fake", "https://zenmux.ai/api/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-magpie-effort": "max" },
        body: JSON.stringify({ max_tokens: max, thinking: { type: "adaptive" }, messages: [] }),
      })
      if (max <= 1024) assert.deepEqual(sent.thinking, { type: "disabled" })
      else assert.ok(sent.thinking.budget_tokens >= 1024 && sent.thinking.budget_tokens < max)
    }
    await _internal.request("fake", "https://zenmux.ai/api/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-magpie-effort": "none" },
      body: JSON.stringify({ max_tokens: 65536, thinking: { type: "adaptive" }, messages: [] }),
    })
    assert.deepEqual(sent.thinking, { type: "disabled" })

    await _internal.request("fake", "https://zenmux.ai/api/anthropic/v1/messages", {
      method: "POST",
      body: JSON.stringify({ max_tokens: 65536, output_config: { effort: "max" }, messages: [] }),
    })
    assert.equal(sent.thinking.budget_tokens, 32768)
  } finally {
    restore()
  }
})

test("login cannot succeed on server failures, network errors or an empty catalogue", async () => {
  for (const failure of [500, 502, 503, "network", "empty"]) {
    const restore = stubFetch((url) => {
      if (url.endsWith("/models")) {
        return { status: 200, text: JSON.stringify({ data: failure === "empty" ? [] : MODELS }) }
      }
      if (failure === "network") throw new TypeError("fetch failed")
      return { status: failure, text: '{"error":{"message":"upstream unavailable"}}' }
    })
    try {
      const plugin = await ZenMuxBuilderAuthPlugin({}, {})
      const result = await plugin.auth.methods[0].authorize({ key: "sk-subs-review-fake-key" })
      assert.equal(result.type, "failed", String(failure))
      assert.doesNotMatch(result.error, /refused this API key/i)
    } finally {
      restore()
    }
  }
})

test("login retries another model after a transient inference failure", async () => {
  let calls = 0
  const restore = stubFetch(() => {
    calls++
    return { status: calls === 1 ? 503 : 200, text: "{}" }
  })
  try {
    const result = await _internal.validateSubscriptionKey("fake", {
      models: [...MODELS, { id: "review/another", output_modalities: ["text"] }],
    })
    assert.equal(result.ok, true)
    assert.equal(result.via, "chat")
    assert.equal(calls, 2)
  } finally {
    restore()
  }
})

test("a Management key in the inference field is rejected before making requests", async () => {
  const restore = stubFetch(() => { assert.fail("must not send a Management key as an inference key") })
  try {
    const plugin = await ZenMuxBuilderAuthPlugin({}, {})
    const method = plugin.auth.methods[0]
    assert.match(method.prompts[0].validate("sk-mgmt-review-fake-key"), /next field/)
    const result = await method.authorize({ key: "sk-mgmt-review-fake-key" })
    assert.equal(result.type, "failed")
    assert.match(result.error, /next field/)
  } finally {
    restore()
  }
})

test("model filters keep exclusions, plan limits and empty results authoritative", async () => {
  const live = [
    { id: "review/allowed", output_modalities: ["text"] },
    { id: "review/excluded", output_modalities: ["text"] },
    { id: "review/image", output_modalities: ["image"] },
  ]
  const restore = stubFetch((url) => ({
    status: 200,
    text: JSON.stringify({
      data: url.endsWith("/models") ? live : [
        { planKey: "review-plan", models: [{ model_slug: "review/allowed" }] },
        { planKey: "review-empty", models: [] },
      ],
    }),
  }))
  const base = { models: { "review/allowed": { id: "review/allowed" } } }
  const cases = [
    [{ models: ["review/allowed", "review/excluded"], exclude: ["review/excluded"] }, ["review/allowed"]],
    [{ exclude: ["*"] }, []],
    [{ models: ["missing/model"] }, []],
    [{ includeNonChat: false, models: ["review/allowed", "review/image"] }, ["review/allowed"]],
    [{ plan: "review-plan", models: ["review/excluded"] }, []],
    [{ plan: "review-empty" }, []],
    [{ plan: "review-plan" }, ["review/allowed"]],
    [{ plan: "review-plan", allModels: true, includeNonChat: false }, ["review/allowed", "review/excluded"]],
  ]
  try {
    for (const [options, expected] of cases) {
      const plugin = await ZenMuxBuilderAuthPlugin({}, { ...options, protocol: "chat" })
      const rows = await plugin.provider.models(base, { auth: { type: "api", key: "sk-subs-fake" } })
      assert.deepEqual(Object.keys(rows), expected, JSON.stringify(options))
    }
    const signedOut = await ZenMuxBuilderAuthPlugin({}, { plan: "review-plan", protocol: "chat" })
    assert.deepEqual(Object.keys(await signedOut.provider.models(base)), ["review/allowed"])
  } finally {
    restore()
  }
})

test("catalogue outages preserve known models but still apply explicit filters", async () => {
  const restore = stubFetch(() => { throw new TypeError("fetch failed") })
  try {
    const plugin = await ZenMuxBuilderAuthPlugin({}, { exclude: ["review/excluded"] })
    const rows = await plugin.provider.models({
      models: {
        "review/allowed": { id: "review/allowed" },
        "review/excluded": { id: "review/excluded" },
      },
    })
    assert.deepEqual(Object.keys(rows), ["review/allowed"])
    assert.equal(rows[Symbol.for("magpie.fellBack")], true)
  } finally {
    restore()
  }
})

test("a successful empty catalogue stays empty", async () => {
  const restore = stubFetch(() => ({ status: 200, text: '{"data":[]}' }))
  try {
    const plugin = await ZenMuxBuilderAuthPlugin({}, {})
    assert.deepEqual(await plugin.provider.models({ models: { "review/old": {} } }), {})
  } finally {
    restore()
  }
})

test("model, quota, protocol and plan requests all receive cancellation signals", async () => {
  const controller = new AbortController()
  const calls = []
  const restore = stubFetch((url, init) => {
    calls.push({ url, signal: init.signal })
    const data = url.endsWith("/models") ? MODELS
      : url.includes("/subscription/detail") ? { plan: { tier: "review-plan" } }
      : url.includes("/get_all_plans") ? [{ planKey: "review-plan", models: [{ model_slug: MODELS[0].id }] }]
      : []
    return { status: 200, text: JSON.stringify({ success: true, data }) }
  })
  try {
    const { ZenMuxBuilderAuthPlugin: SignalPlugin } = await import("../index.mjs?cancellation-regression")
    const plugin = await SignalPlugin({}, {})
    const auth = { type: "api", key: "sk-subs-fake", metadata: { managementKey: "sk-mgmt-fake" } }
    await plugin.provider.models({ models: {} }, { auth, signal: controller.signal })
    await plugin.auth.usage(async () => auth, {}, { signal: controller.signal })
    assert.ok(calls.some((call) => call.url.includes("/get_all_plans")))
    assert.ok(calls.some((call) => call.url.includes("/frontend/model/available/list")))
    assert.ok(calls.every((call) => call.signal instanceof AbortSignal))
    controller.abort()
    assert.ok(calls.every((call) => call.signal.aborted))
  } finally {
    restore()
  }
})

test("cancelled model and quota requests propagate cancellation rather than falling back", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (_url, { signal }) => {
    signal.throwIfAborted()
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  }
  try {
    const plugin = await ZenMuxBuilderAuthPlugin({}, {})
    const auth = { key: "fake", metadata: { managementKey: "fake" } }
    for (const call of [
      (signal) => plugin.provider.models({ models: {} }, { auth, signal }),
      (signal) => plugin.auth.usage(async () => auth, {}, { signal }),
      (signal) => plugin.auth.methods[0].authorize({ key: "sk-subs-review-fake-key" }, { signal }),
    ]) {
      const controller = new AbortController()
      const pending = call(controller.signal)
      await new Promise((resolve) => setImmediate(resolve))
      controller.abort()
      await assert.rejects(pending, { name: "AbortError" })
      await assert.rejects(call(controller.signal), { name: "AbortError" })
    }
  } finally {
    globalThis.fetch = original
  }
})

test("request deadlines remain active alongside a host signal", async () => {
  const controller = new AbortController()
  const signal = _internal.requestSignal(controller.signal, 5)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(signal.aborted, true)
  assert.equal(signal.reason.name, "TimeoutError")
  assert.equal(controller.signal.aborted, false)
})

test("Management quota reads never change the independent inference sign-in", async () => {
  for (const failure of [null, 401, 403, 503, "network"]) {
    const restore = stubFetch(() => {
      if (failure === "network") throw new TypeError("fetch failed")
      return {
        status: failure ?? 200,
        text: JSON.stringify(failure ? { success: false, message: "unavailable" } : { success: true, data: SAMPLE }),
      }
    })
    try {
      const plugin = await ZenMuxBuilderAuthPlugin({}, {})
      const usage = await plugin.auth.usage(async () => ({
        type: "api", key: "fake-inference", metadata: { managementKey: "fake-management" },
      }))
      assert.equal(usage.signIn, "kept")
      if (failure === null) assert.equal(usage.plan, "Builder Ultra")
      else assert.equal(usage.windows.length, 0)
    } finally {
      restore()
    }
  }
})
