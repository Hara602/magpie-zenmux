// OAuth 2.0 Authorization Code + PKCE for ZenMux, in the shape magpie's `auth`
// hook wants. This is the same flow ZenMux's official OpenCode and DSH plugins
// use: a public native client, a loopback redirect on 127.0.0.1, S256 PKCE, and
// refresh-token rotation.
//
// ZenMux's own words: https://github.com/ZenMux/opencode-plugin (MIT)
//   GET  {origin}/oauth/authorize?response_type=code&client_id=…
//        &redirect_uri=http://127.0.0.1:<port>/callback&scope=inference:invoke offline_access
//        &state=…&code_challenge=…&code_challenge_method=S256
//   POST {origin}/oauth/token  (form)  grant_type=authorization_code|refresh_token
//        &client_id=…&code=…&redirect_uri=…&code_verifier=…  (or &refresh_token=…)
//
// Kept free of magpie types so it can be unit-tested on its own.

import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"

export const DEFAULT_ORIGIN = "https://zenmux.ai"
// ZenMux ships one public native client for OpenCode; magpie reuses it, which is
// what a public client is for (there is no client secret to leak).
export const DEFAULT_CLIENT_ID = "zpc_w3HpDNWorRuWEE6uIJxDSr5r"
export const SCOPES = "inference:invoke offline_access"
export const COMPLETION_URL = "https://zenmux.ai/platform/oauth-completed?client=magpie"
export const CALLBACK_PATH = "/callback"
export const AUTH_TIMEOUT_MS = 5 * 60 * 1000

export function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url")
}

// createPkce builds the S256 pair: a 48-byte random verifier and its SHA-256
// digest. Injecting the random source keeps it testable.
export function createPkce(random = (n) => randomBytes(n)) {
  const verifier = base64Url(random(48))
  const challenge = base64Url(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

export function authorizeUrl({
  origin = DEFAULT_ORIGIN,
  clientId = DEFAULT_CLIENT_ID,
  redirectUri,
  state,
  challenge,
  scope = SCOPES,
}) {
  const url = new URL(`${String(origin).replace(/\/+$/, "")}/oauth/authorize`)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", clientId)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", scope)
  url.searchParams.set("state", state)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  return url.toString()
}

// toAuth turns a token endpoint response into what magpie saves. A refresh
// token is required: without one the account could not be renewed, and magpie
// would keep a sign-in that dies in two hours.
export function toAuth(tokens, now = Date.now()) {
  if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token) return undefined
  if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token) return undefined
  const expiresIn = Number(tokens.expires_in)
  const seconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 7200
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: now + seconds * 1000,
  }
}

export function exchangeBody({ kind, clientId, code, redirectUri, verifier, refresh }) {
  const form = new URLSearchParams()
  form.set("grant_type", kind === "refresh" ? "refresh_token" : "authorization_code")
  form.set("client_id", clientId)
  if (kind === "refresh") form.set("refresh_token", refresh)
  else {
    form.set("code", code)
    form.set("redirect_uri", redirectUri)
    form.set("code_verifier", verifier)
  }
  return form
}

export function completionPage(completionUrl = COMPLETION_URL) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ZenMux authorization completed</title>
<style>html,body,iframe{width:100%;height:100%;margin:0;border:0}body{overflow:hidden}iframe{display:block}</style></head>
<body><iframe src="${completionUrl}" title="ZenMux authorization completed"></iframe></body>
</html>`
}

// exchangeToken posts a form to ZenMux's token endpoint. It returns the parsed
// JSON whatever the status, so the caller decides what an error means.
export async function exchangeToken(
  origin,
  body,
  { fetchImpl = fetch, signal, timeoutMs = 30_000 } = {},
) {
  const signalOrTimeout = signal ?? AbortSignal.timeout(timeoutMs)
  const res = await fetchImpl(`${String(origin).replace(/\/+$/, "")}/oauth/token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: signalOrTimeout,
  })
  const text = await res.text().catch(() => "")
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = undefined
  }
  return { ok: res.ok, status: res.status, payload, text }
}

// beginAuthorization starts the loopback listener and builds the URL magpie
// opens. complete() resolves with the token result; close() always frees the
// port. A user who never finishes (or cancels) times out after five minutes.
export async function beginAuthorization({
  origin = DEFAULT_ORIGIN,
  clientId = DEFAULT_CLIENT_ID,
  redirectHost = "127.0.0.1",
  serverFactory = createServer,
  fetchImpl = fetch,
  scope = SCOPES,
  timeoutMs = AUTH_TIMEOUT_MS,
  random = (n) => randomBytes(n),
  completionHtml = completionPage(),
  signal,
} = {}) {
  const { verifier, challenge } = createPkce(random)
  const state = base64Url(random(32))

  let settleResolve
  let settleReject
  const settled = new Promise((resolve, reject) => {
    settleResolve = resolve
    settleReject = reject
  })
  settled.catch(() => {}) // observed below; a cancel must not surface as unhandled

  let done = false
  const finish = (fn, value) => {
    if (done) return false
    done = true
    clearTimeout(timer)
    fn(value)
    return true
  }

  const server = serverFactory((request, response) => {
    let pathname = ""
    let params
    try {
      const url = new URL(String(request.url ?? "/"), `http://${redirectHost}`)
      pathname = url.pathname
      params = url.searchParams
    } catch {
      response.writeHead(400).end("bad request")
      return
    }
    if (pathname !== CALLBACK_PATH) {
      response.writeHead(404).end("not found")
      return
    }
    if (done) {
      response.writeHead(409).end("this sign-in is over")
      return
    }
    if (params.get("error")) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
      response.end("ZenMux authorization failed. You can close this window.")
      finish(settleReject, new Error(`ZenMux returned ${params.get("error")}`))
      close()
      return
    }
    if (params.get("state") !== state) {
      // A stale or forged callback: answer 400 but keep listening, because the
      // real browser redirect may still arrive.
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
      response.end("state mismatch")
      return
    }
    const code = params.get("code")
    if (!code) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
      response.end("no authorization code")
      return
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(completionHtml)
    finish(settleResolve, { code, redirectUri })
    close()
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, redirectHost, resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("could not work out the OAuth callback port")
  }
  const redirectUri = `http://${redirectHost}:${address.port}${CALLBACK_PATH}`

  const close = () => {
    try {
      server.close()
    } catch {
      // already closed
    }
  }

  const timer = setTimeout(() => {
    finish(settleReject, new Error("ZenMux authorization was not completed in five minutes"))
    close()
  }, timeoutMs)
  timer.unref?.()

  const onAbort = () => {
    finish(settleReject, new Error("ZenMux authorization was cancelled"))
    close()
  }
  signal?.addEventListener?.("abort", onAbort, { once: true })

  return {
    url: authorizeUrl({ origin, clientId, redirectUri, state, challenge, scope }),
    redirectUri,
    state,
    close,
    async complete() {
      try {
        const { code } = await settled
        const res = await exchangeToken(
          origin,
          exchangeBody({ kind: "code", clientId, code, redirectUri, verifier }),
          { fetchImpl, signal },
        )
        const auth = toAuth(res.payload)
        if (!auth) {
          const why = res.payload?.error_description || res.payload?.error || `HTTP ${res.status}`
          throw new Error(`ZenMux did not return a usable token pair: ${why}`)
        }
        return auth
      } finally {
        close()
      }
    },
  }
}

// refreshAccessToken renews an account. ZenMux rotates the refresh token, so the
// new pair must be saved; a response without one means the sign-in is dead.
export async function refreshAccessToken(
  auth,
  { origin = DEFAULT_ORIGIN, clientId = DEFAULT_CLIENT_ID, fetchImpl = fetch, signal, now = Date.now() } = {},
) {
  if (!auth || auth.type !== "oauth" || typeof auth.refresh !== "string" || !auth.refresh) return undefined
  const res = await exchangeToken(
    origin,
    exchangeBody({ kind: "refresh", clientId, refresh: auth.refresh }),
    { fetchImpl, signal },
  )
  const next = toAuth(res.payload, typeof now === "function" ? now() : now)
  if (!next) {
    throw Object.assign(
      new Error(
        `ZenMux did not renew this sign-in${
          res.payload?.error_description || res.payload?.error ? `: ${res.payload.error_description || res.payload.error}` : ` (HTTP ${res.status})`
        }`,
      ),
      { signIn: "expired" },
    )
  }
  return next
}