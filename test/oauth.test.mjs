// Run with: node --test   (Node 20+; Bun runs it too)
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"

import {
  authorizeUrl,
  base64Url,
  beginAuthorization,
  createPkce,
  exchangeBody,
  refreshAccessToken,
  toAuth,
  DEFAULT_CLIENT_ID,
  SCOPES,
} from "../oauth.mjs"

const fixedRandom = (n) => Buffer.alloc(n, 7)

test("createPkce builds a 48-byte verifier and its S256 challenge", () => {
  const { verifier, challenge } = createPkce(fixedRandom)
  assert.equal(verifier, base64Url(Buffer.alloc(48, 7)))
  assert.equal(challenge, base64Url(createHash("sha256").update(verifier).digest()))
  // url-safe: no +, / or =
  assert.doesNotMatch(verifier + challenge, /[+/=]/)
  assert.ok(verifier.length >= 43) // RFC 7636 wants 43..128
})

test("authorizeUrl carries the parameters ZenMux expects", () => {
  const url = new URL(
    authorizeUrl({
      origin: "https://zenmux.ai/",
      redirectUri: "http://127.0.0.1:12345/callback",
      state: "abc",
      challenge: "xyz",
    }),
  )
  assert.equal(url.origin, "https://zenmux.ai")
  assert.equal(url.pathname, "/oauth/authorize")
  assert.equal(url.searchParams.get("response_type"), "code")
  assert.equal(url.searchParams.get("client_id"), DEFAULT_CLIENT_ID)
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:12345/callback")
  assert.equal(url.searchParams.get("scope"), SCOPES)
  assert.equal(url.searchParams.get("state"), "abc")
  assert.equal(url.searchParams.get("code_challenge"), "xyz")
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
})

test("toAuth needs both tokens and defaults expires_in to two hours", () => {
  const a = toAuth({ access_token: "at", refresh_token: "rt" }, 1000)
  assert.deepEqual(a, { access: "at", refresh: "rt", expires: 1000 + 7200 * 1000 })
  const b = toAuth({ access_token: "at", refresh_token: "rt", expires_in: 60 }, 0)
  assert.equal(b.expires, 60_000)
  assert.equal(toAuth({ access_token: "at" }), undefined) // no refresh: cannot renew
  assert.equal(toAuth({ refresh_token: "rt" }), undefined)
  assert.equal(toAuth(undefined), undefined)
})

test("exchangeBody builds each grant the way the token endpoint wants", () => {
  const code = exchangeBody({
    kind: "code",
    clientId: "cid",
    code: "c0de",
    redirectUri: "http://127.0.0.1:1/callback",
    verifier: "ver",
  })
  assert.equal(code.get("grant_type"), "authorization_code")
  assert.equal(code.get("code"), "c0de")
  assert.equal(code.get("code_verifier"), "ver")
  assert.equal(code.get("redirect_uri"), "http://127.0.0.1:1/callback")
  assert.equal(code.get("client_id"), "cid")

  const refresh = exchangeBody({ kind: "refresh", clientId: "cid", refresh: "rt" })
  assert.equal(refresh.get("grant_type"), "refresh_token")
  assert.equal(refresh.get("refresh_token"), "rt")
  assert.equal(refresh.get("code"), null)
})

// A stub token endpoint: returns whatever the test asks for.
function tokenServer(responses) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") })
    const next = responses.shift() ?? { status: 500, json: {} }
    return new Response(JSON.stringify(next.json), {
      status: next.status,
      headers: { "content-type": "application/json" },
    })
  }
  return { fetchImpl, calls }
}

test("beginAuthorization completes the loopback flow and exchanges the code", async () => {
  const { fetchImpl, calls } = tokenServer([
    { status: 200, json: { access_token: "acc", refresh_token: "ref", expires_in: 3600 } },
  ])

  const flow = await beginAuthorization({
    origin: "https://zenmux.ai",
    fetchImpl,
    random: fixedRandom,
    timeoutMs: 5000,
  })

  // The URL magpie would open, with the redirect the listener actually bound.
  const url = new URL(flow.url)
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  const redirect = new URL(url.searchParams.get("redirect_uri"))
  assert.equal(redirect.hostname, "127.0.0.1")
  assert.equal(redirect.pathname, "/callback")

  const pending = flow.complete()
  // A stale state is refused without ending the sign-in.
  const bad = await fetch(`${redirect.origin}/callback?state=wrong&code=x`)
  assert.equal(bad.status, 400)

  // Then the real callback, exactly as a browser would send it.
  const state = url.searchParams.get("state")
  const good = await fetch(`${redirect.origin}/callback?state=${state}&code=the-code`)
  assert.equal(good.status, 200)
  assert.match(await good.text(), /ZenMux authorization completed/)

  const auth = await pending
  assert.deepEqual([auth.access, auth.refresh], ["acc", "ref"])
  assert.equal(typeof auth.expires, "number")
  assert.ok(auth.expires > Date.now())
  // The token request carried the code and the same redirect.
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/oauth\/token$/)
  const posted = new URLSearchParams(calls[0].body)
  assert.equal(posted.get("grant_type"), "authorization_code")
  assert.equal(posted.get("code"), "the-code")
  assert.equal(posted.get("redirect_uri"), url.searchParams.get("redirect_uri"))
})

test("beginAuthorization reports a vendor error without hanging", async () => {
  const flow = await beginAuthorization({
    origin: "https://zenmux.ai",
    fetchImpl: async () => new Response("{}", { status: 200 }),
    random: fixedRandom,
    timeoutMs: 5000,
  })
  const redirect = new URL(flow.url).searchParams.get("redirect_uri")
  const pending = flow.complete().catch((e) => e)
  const res = await fetch(`${redirect}?error=access_denied`)
  assert.equal(res.status, 400)
  assert.match((await pending).message, /access_denied/)
})

test("beginAuthorization times out and frees the port", async () => {
  const flow = await beginAuthorization({ random: fixedRandom, timeoutMs: 40 })
  await assert.rejects(flow.complete(), /not completed in five minutes/)
})

test("refreshAccessToken rotates the pair, and refuses a dead sign-in", async () => {
  const ok = tokenServer([
    { status: 200, json: { access_token: "acc2", refresh_token: "ref2", expires_in: 60 } },
  ])
  const next = await refreshAccessToken(
    { type: "oauth", access: "acc", refresh: "ref" },
    { fetchImpl: ok.fetchImpl, now: () => 0 },
  )
  assert.deepEqual(next, { access: "acc2", refresh: "ref2", expires: 60_000 })
  assert.equal(new URLSearchParams(ok.calls[0].body).get("grant_type"), "refresh_token")

  const dead = tokenServer([{ status: 400, json: { error: "invalid_grant" } }])
  await assert.rejects(
    refreshAccessToken({ type: "oauth", access: "acc", refresh: "ref" }, { fetchImpl: dead.fetchImpl }),
    (e) => e.signIn === "expired",
  )

  // An API-key account has nothing to refresh.
  assert.equal(await refreshAccessToken({ type: "api", key: "sk-subs-x" }), undefined)
})