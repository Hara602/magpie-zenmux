import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const providerId = 'zenmux';
export const productionOAuthOrigin = 'https://zenmux.ai';
export const productionOAuthClientId = 'zpc_w3HpDNWorRuWEE6uIJxDSr5r';
export const oauthCompletionUrl = 'https://zenmux.ai/platform/oauth-completed?client=opencode';

export function renderOAuthCompletionPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ZenMux authorization completed</title>
  <style>
    html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; }
    body { overflow: hidden; }
    iframe { display: block; }
  </style>
</head>
<body>
  <iframe src="${oauthCompletionUrl}" title="ZenMux authorization completed"></iframe>
</body>
</html>`;
}

const modelCacheSchemaVersion = 1;
const refreshSkewMs = 2 * 60 * 1000;
const protocolPriority = ['anthropic-messages', 'openai-responses', 'openai-completions'];
const protocolAliases = new Map([
  ['anthropic', 'anthropic-messages'],
  ['anthropic-messages', 'anthropic-messages'],
  ['messages', 'anthropic-messages'],
  ['openai-responses', 'openai-responses'],
  ['responses', 'openai-responses'],
  ['chat.completions', 'openai-completions'],
  ['chat-completions', 'openai-completions'],
  ['openai-completions', 'openai-completions'],
]);

export function resolveRuntimeConfig(env = process.env, homeDir = homedir()) {
  const portalOrigin = (env.ZENMUX_OAUTH_ORIGIN || productionOAuthOrigin).replace(/\/$/, '');
  const apiBaseUrl = (env.ZENMUX_API_BASE_URL || `${portalOrigin}/api/v1`).replace(/\/$/, '');
  const anthropicBaseUrl = (
    env.ZENMUX_ANTHROPIC_BASE_URL || `${new URL(apiBaseUrl).origin}/api/anthropic/v1`
  ).replace(/\/$/, '');
  const modelCatalogUrl = env.ZENMUX_MODEL_CATALOG_URL
    || `${new URL(apiBaseUrl).origin}/api/frontend/model/available/list`;
  const configRoot = env.XDG_CONFIG_HOME || env.APPDATA || join(homeDir, '.config');
  const cacheRoot = env.XDG_CACHE_HOME || env.LOCALAPPDATA || join(homeDir, '.cache');

  return {
    portalOrigin,
    apiBaseUrl,
    anthropicBaseUrl,
    modelCatalogUrl,
    clientCachePath: join(configRoot, 'opencode', 'zenmux-oauth-clients.json'),
    modelCachePath: join(cacheRoot, 'opencode', 'zenmux', 'models.json'),
    configuredClientId: env.ZENMUX_OAUTH_CLIENT_ID || '',
  };
}

function base64Url(buffer) {
  return buffer.toString('base64url');
}

function createPkce() {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function collectModelProtocols(model) {
  const protocols = [];
  const append = (value) => {
    if (Array.isArray(value)) {
      value.forEach(append);
    } else if (typeof value === 'string') {
      value.split(',').forEach((item) => protocols.push(item.trim().toLowerCase()));
    }
  };

  append(model.api);
  append(model.protocols);
  append(model.supported_endpoint_types);
  append(model.capabilities?.protocols);
  for (const endpoint of model.endpoints ?? []) {
    append(endpoint.api);
    append(endpoint.suitable_api);
    for (const adapter of endpoint.adapters ?? []) append(adapter.api);
  }
  return protocols;
}

export function resolveOpenCodeProtocol(model) {
  const supported = new Set(
    collectModelProtocols(model).map((protocol) => protocolAliases.get(protocol)).filter(Boolean),
  );
  return protocolPriority.find((protocol) => supported.has(protocol));
}

function protocolApi(protocol, config) {
  if (protocol === 'anthropic-messages') {
    return { npm: '@ai-sdk/anthropic', url: config.anthropicBaseUrl };
  }
  if (protocol === 'openai-responses') {
    return { npm: '@ai-sdk/openai', url: config.apiBaseUrl };
  }
  return { npm: '@ai-sdk/openai-compatible', url: config.apiBaseUrl };
}

function endpointValues(model, field) {
  return (model.endpoints ?? [])
    .map((endpoint) => Number(endpoint?.[field]))
    .filter(Number.isFinite);
}

function minimumEndpointValue(model, field, fallback = 0) {
  const values = endpointValues(model, field);
  return values.length ? Math.min(...values) : fallback;
}

function maximumEndpointValue(model, field, fallback = 0) {
  const values = endpointValues(model, field);
  return values.length ? Math.max(...values) : fallback;
}

function supportsParameter(model, parameter) {
  return (model.endpoints ?? []).some((endpoint) =>
    (endpoint.adapters ?? []).some((adapter) =>
      (adapter.supported_parameters ?? []).includes(parameter),
    ),
  );
}

export function toOpenCodeModel(model, config) {
  const id = model.slug || model.id;
  const protocol = resolveOpenCodeProtocol(model);
  if (!id || !protocol) return undefined;

  const input = Array.isArray(model.input_modalities) ? model.input_modalities : ['text'];
  const output = Array.isArray(model.output_modalities) ? model.output_modalities : ['text'];
  const reasoning = model.capabilities?.reasoning === true
    || (model.endpoints ?? []).some((endpoint) => Number(endpoint.supports_reasoning) > 0);
  const toolcall = (model.endpoints ?? []).some(
    (endpoint) => endpoint.supports_tool_parameters === true
      || Number(endpoint.supports_tool_parameters) > 0,
  ) || supportsParameter(model, 'tools');

  return {
    id,
    providerID: providerId,
    name: model.display_name || model.name || id,
    family: 'zenmux',
    api: {
      id,
      ...protocolApi(protocol, config),
    },
    status: 'active',
    headers: {},
    options: {},
    cost: {
      input: minimumEndpointValue(model, 'pricing_prompt'),
      output: minimumEndpointValue(model, 'pricing_completion'),
      cache: {
        read: minimumEndpointValue(model, 'pricing_input_cache_read'),
        write: minimumEndpointValue(model, 'pricing_input_cache_write'),
      },
    },
    limit: {
      context: Number(model.context_length)
        || maximumEndpointValue(model, 'context_length')
        || 128000,
      output: Number(model.max_completion_tokens)
        || maximumEndpointValue(model, 'max_completion_tokens')
        || 16384,
    },
    capabilities: {
      temperature: supportsParameter(model, 'temperature'),
      reasoning,
      attachment: input.includes('image') || input.includes('pdf'),
      toolcall,
      input: {
        text: input.includes('text'),
        audio: input.includes('audio'),
        image: input.includes('image'),
        video: input.includes('video'),
        pdf: input.includes('pdf'),
      },
      output: {
        text: output.includes('text'),
        audio: output.includes('audio'),
        image: output.includes('image'),
        video: output.includes('video'),
        pdf: output.includes('pdf'),
      },
      interleaved: false,
    },
    release_date: model.release_date || '',
  };
}

export function createModelCacheEntry(models, config, checkedAt = Date.now()) {
  return {
    schemaVersion: modelCacheSchemaVersion,
    oauthOrigin: config.portalOrigin,
    apiBaseUrl: config.apiBaseUrl,
    anthropicBaseUrl: config.anthropicBaseUrl,
    modelCatalogUrl: config.modelCatalogUrl,
    models,
    checkedAt,
  };
}

export function restoreCachedModels(entry, config) {
  if (
    entry?.schemaVersion !== modelCacheSchemaVersion
    || entry.oauthOrigin !== config.portalOrigin
    || entry.apiBaseUrl !== config.apiBaseUrl
    || entry.anthropicBaseUrl !== config.anthropicBaseUrl
    || entry.modelCatalogUrl !== config.modelCatalogUrl
    || typeof entry.models !== 'object'
    || entry.models === null
    || Array.isArray(entry.models)
  ) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(entry.models).filter(([id, model]) =>
      Boolean(id) && model?.id === id && model.providerID === providerId,
    ),
  );
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

export function createZenMuxOAuthPlugin(options = {}) {
  const config = resolveRuntimeConfig(options.env, options.homeDir);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const serverFactory = options.createServer || createServer;
  let clientId = config.configuredClientId;

  async function getClientId() {
    if (clientId) return clientId;

    const cached = await readJson(config.clientCachePath, {});
    if (typeof cached[config.portalOrigin] === 'string' && cached[config.portalOrigin]) {
      clientId = cached[config.portalOrigin];
      return clientId;
    }

    if (config.portalOrigin === productionOAuthOrigin) {
      clientId = productionOAuthClientId;
      return clientId;
    }

    const response = await fetchImpl(`${config.portalOrigin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ZenMux for OpenCode',
        application_type: 'native',
        token_endpoint_auth_method: 'none',
        redirect_uris: ['http://127.0.0.1/callback'],
        scope: 'inference:invoke offline_access',
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.client_id) {
      throw new Error(
        payload.error_description || payload.error || `ZenMux client registration failed (${response.status})`,
      );
    }

    clientId = payload.client_id;
    await writeJsonAtomic(config.clientCachePath, { ...cached, [config.portalOrigin]: clientId });
    return clientId;
  }

  async function exchangeToken(body, signal) {
    const response = await fetchImpl(`${config.portalOrigin}/oauth/token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      signal,
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(
        payload.error_description || payload.error || `ZenMux token request failed (${response.status})`,
      );
    }
    return payload;
  }

  async function beginAuthorization() {
    const currentClientId = await getClientId();
    const { verifier, challenge } = createPkce();
    const state = base64Url(randomBytes(32));
    let redirectUri = '';
    let settled = false;
    let resolveCallback;
    let rejectCallback;
    const callbackPromise = new Promise((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });

    const server = serverFactory((request, response) => {
      if (!redirectUri || settled) {
        response.writeHead(409).end('OAuth callback is no longer active');
        return;
      }
      const requestUrl = new URL(request.url || '/', redirectUri);
      if (requestUrl.pathname !== '/callback') {
        response.writeHead(404).end('Not found');
        return;
      }
      const returnedState = requestUrl.searchParams.get('state');
      const code = requestUrl.searchParams.get('code');
      const oauthError = requestUrl.searchParams.get('error');
      if (oauthError || returnedState !== state || !code) {
        settled = true;
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('ZenMux authorization failed. You can close this window.');
        server.close();
        rejectCallback(new Error(oauthError || 'OAuth callback state mismatch'));
        return;
      }
      settled = true;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(renderOAuthCompletionPage());
      server.close();
      resolveCallback(code);
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Unable to determine the OAuth callback port');
    }

    redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const authorizeUrl = new URL(`${config.portalOrigin}/oauth/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', currentClientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', 'inference:invoke offline_access');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      rejectCallback(new Error('ZenMux OAuth callback timed out after 5 minutes'));
    }, 5 * 60 * 1000);
    timeout.unref();

    return {
      url: authorizeUrl.toString(),
      async complete() {
        try {
          const code = await callbackPromise;
          const tokens = await exchangeToken(new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: currentClientId,
            code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
          }));
          if (!tokens.refresh_token) throw new Error('ZenMux did not return a refresh token');
          return {
            access: tokens.access_token,
            refresh: tokens.refresh_token,
            expires: now() + Number(tokens.expires_in || 7200) * 1000,
          };
        } finally {
          clearTimeout(timeout);
          server.close();
        }
      },
    };
  }

  async function discoverModels() {
    const response = await fetchImpl(config.modelCatalogUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json();
    if (!response.ok || !Array.isArray(payload.data)) {
      throw new Error(`ZenMux model discovery failed (${response.status})`);
    }

    return Object.fromEntries(
      payload.data
        .map((model) => toOpenCodeModel(model, config))
        .filter(Boolean)
        .map((model) => [model.id, model]),
    );
  }

  async function cachedModels() {
    return restoreCachedModels(await readJson(config.modelCachePath, undefined), config);
  }

  return async function ZenMuxOAuthPlugin(input) {
    return {
      provider: {
        id: providerId,
        async models(provider) {
          const cached = await cachedModels();
          try {
            const discovered = await discoverModels();
            if (!Object.keys(discovered).length) {
              return { ...provider.models, ...cached };
            }
            await writeJsonAtomic(
              config.modelCachePath,
              createModelCacheEntry(discovered, config, now()),
            ).catch(() => {});
            return { ...provider.models, ...discovered };
          } catch {
            return { ...provider.models, ...cached };
          }
        },
      },
      auth: {
        provider: providerId,
        async loader(getAuth) {
          const initialAuth = await getAuth();
          if (initialAuth?.type !== 'oauth') return {};
          let refreshPromise;
          return {
            apiKey: 'zenmux-oauth',
            async fetch(requestInput, init) {
              let auth = await getAuth();
              if (auth?.type !== 'oauth') return fetchImpl(requestInput, init);
              if (!auth.expires || auth.expires - now() <= refreshSkewMs) {
                if (!refreshPromise) {
                  refreshPromise = (async () => {
                    const currentClientId = await getClientId();
                    const tokens = await exchangeToken(new URLSearchParams({
                      grant_type: 'refresh_token',
                      client_id: currentClientId,
                      refresh_token: auth.refresh,
                    }), init?.signal);
                    if (!tokens.refresh_token) throw new Error('ZenMux refresh token rotation failed');
                    const updated = {
                      type: 'oauth',
                      access: tokens.access_token,
                      refresh: tokens.refresh_token,
                      expires: now() + Number(tokens.expires_in || 7200) * 1000,
                    };
                    await input.client.auth.set({ path: { id: providerId }, body: updated });
                    return updated;
                  })().finally(() => {
                    refreshPromise = undefined;
                  });
                }
                auth = await refreshPromise;
              }

              const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined);
              if (init?.headers) {
                const additions = init.headers instanceof Headers
                  ? init.headers.entries()
                  : Array.isArray(init.headers)
                    ? init.headers
                    : Object.entries(init.headers);
                for (const [key, value] of additions) {
                  if (value !== undefined) headers.set(key, String(value));
                }
              }
              headers.set('authorization', `Bearer ${auth.access}`);
              return fetchImpl(requestInput, { ...init, headers });
            },
          };
        },
        methods: [
          {
            type: 'oauth',
            label: 'ZenMux OAuth (PKCE)',
            async authorize() {
              const authorization = await beginAuthorization();
              return {
                url: authorization.url,
                instructions: 'Complete ZenMux authorization in your browser.',
                method: 'auto',
                async callback() {
                  try {
                    const tokens = await authorization.complete();
                    return { type: 'success', provider: providerId, ...tokens };
                  } catch {
                    return { type: 'failed' };
                  }
                },
              };
            },
          },
          {
            type: 'api',
            label: 'Manually enter ZenMux API key',
          },
        ],
      },
    };
  };
}
