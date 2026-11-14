// Run with: node --test   (Node 20+; Bun's `bun test` runs it too)
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  costOf,
  entries,
  isChatModel,
  matches,
  modelRow,
  planModelSets,
  subscriptionToUsage,
} from "../zenmux.mjs"
import { _internal } from "../index.mjs"

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