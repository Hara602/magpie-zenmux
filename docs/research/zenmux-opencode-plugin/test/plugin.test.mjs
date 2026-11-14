import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createModelCacheEntry,
  createZenMuxOAuthPlugin,
  oauthCompletionUrl,
  productionOAuthClientId,
  renderOAuthCompletionPage,
  resolveOpenCodeProtocol,
  resolveRuntimeConfig,
  restoreCachedModels,
  toOpenCodeModel,
} from '../src/core.mjs';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function catalogModel(overrides = {}) {
  return {
    id: 'internal-id',
    slug: 'example/model',
    name: 'Example Model',
    context_length: 262144,
    max_completion_tokens: 65536,
    input_modalities: ['text', 'image'],
    output_modalities: ['text'],
    endpoints: [{
      context_length: 262144,
      max_completion_tokens: 65536,
      pricing_prompt: '0.5',
      pricing_completion: '1.5',
      pricing_input_cache_read: '0.05',
      pricing_input_cache_write: '0.1',
      supports_reasoning: 1,
      supports_tool_parameters: true,
      adapters: [
        { api: 'responses', supported_parameters: ['temperature', 'tools'] },
        { api: 'messages', supported_parameters: ['temperature', 'tools'] },
        { api: 'chat.completions', supported_parameters: ['temperature'] },
      ],
    }],
    ...overrides,
  };
}

test('the package entry exports exactly one OpenCode plugin function', async () => {
  const entry = await import('../index.mjs');
  assert.deepEqual(Object.keys(entry), ['ZenMuxOAuthPlugin']);
  assert.equal(typeof entry.ZenMuxOAuthPlugin, 'function');
});

test('uses stable production defaults', () => {
  const config = resolveRuntimeConfig({}, '/tmp/example-home');
  assert.equal(config.portalOrigin, 'https://zenmux.ai');
  assert.equal(config.apiBaseUrl, 'https://zenmux.ai/api/v1');
  assert.equal(config.anthropicBaseUrl, 'https://zenmux.ai/api/anthropic/v1');
  assert.equal(config.modelCatalogUrl, 'https://zenmux.ai/api/frontend/model/available/list');
  assert.equal(productionOAuthClientId, 'zpc_w3HpDNWorRuWEE6uIJxDSr5r');
});

test('renders the OpenCode completion page in a full-screen iframe', () => {
  const html = renderOAuthCompletionPage();
  assert.equal(oauthCompletionUrl, 'https://zenmux.ai/platform/oauth-completed?client=opencode');
  assert.match(html, /<iframe src="https:\/\/zenmux\.ai\/platform\/oauth-completed\?client=opencode"/);
  assert.match(html, /html, body, iframe \{ width: 100%; height: 100%; margin: 0; border: 0; \}/);
});

test('prefers Messages, then Responses, then Chat Completions', () => {
  assert.equal(resolveOpenCodeProtocol(catalogModel()), 'anthropic-messages');
  assert.equal(
    resolveOpenCodeProtocol(catalogModel({
      endpoints: [{ adapters: [{ api: 'responses' }, { api: 'chat.completions' }] }],
    })),
    'openai-responses',
  );
  assert.equal(
    resolveOpenCodeProtocol(catalogModel({
      endpoints: [{ adapters: [{ api: 'chat.completions' }] }],
    })),
    'openai-completions',
  );
  assert.equal(resolveOpenCodeProtocol({ endpoints: [{ adapters: [{ api: 'videos' }] }] }), undefined);
});

test('maps the rich catalog to a protocol-specific OpenCode model', () => {
  const config = resolveRuntimeConfig({}, '/tmp/example-home');
  const model = toOpenCodeModel(catalogModel(), config);

  assert.equal(model.id, 'example/model');
  assert.equal(model.providerID, 'zenmux');
  assert.equal(model.api.npm, '@ai-sdk/anthropic');
  assert.equal(model.api.url, 'https://zenmux.ai/api/anthropic/v1');
  assert.deepEqual(model.cost, {
    input: 0.5,
    output: 1.5,
    cache: { read: 0.05, write: 0.1 },
  });
  assert.deepEqual(model.limit, { context: 262144, output: 65536 });
  assert.equal(model.capabilities.reasoning, true);
  assert.equal(model.capabilities.toolcall, true);
  assert.equal(model.capabilities.attachment, true);
  assert.equal(model.variants, undefined);
});

test('scopes cached models to the complete runtime endpoint configuration', () => {
  const config = resolveRuntimeConfig({}, '/tmp/example-home');
  const model = toOpenCodeModel(catalogModel(), config);
  const models = { [model.id]: model };
  const entry = createModelCacheEntry(models, config, 1234);

  assert.equal(entry.checkedAt, 1234);
  assert.deepEqual(restoreCachedModels(entry, config), models);
  assert.deepEqual(
    restoreCachedModels(entry, { ...config, portalOrigin: 'https://pre.zenmux.ai' }),
    {},
  );
  assert.deepEqual(
    restoreCachedModels(entry, { ...config, apiBaseUrl: 'https://pre.zenmux.ai/api/v1' }),
    {},
  );
});

test('writes a non-empty catalog and restores it when discovery fails', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'opencode-zenmux-cache-'));
  const modelPayload = catalogModel();

  try {
    const onlinePlugin = createZenMuxOAuthPlugin({
      env: {},
      homeDir,
      now: () => 1234,
      fetchImpl: async () => jsonResponse({ data: [modelPayload] }),
    });
    const onlineHooks = await onlinePlugin({ client: { auth: { set: async () => {} } } });
    const onlineModels = await onlineHooks.provider.models({ models: {} });
    assert.deepEqual(Object.keys(onlineModels), ['example/model']);

    const config = resolveRuntimeConfig({}, homeDir);
    const stored = JSON.parse(await readFile(config.modelCachePath, 'utf8'));
    assert.equal(stored.checkedAt, 1234);
    assert.deepEqual(Object.keys(stored.models), ['example/model']);

    const offlinePlugin = createZenMuxOAuthPlugin({
      env: {},
      homeDir,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    const offlineHooks = await offlinePlugin({ client: { auth: { set: async () => {} } } });
    const offlineModels = await offlineHooks.provider.models({ models: {} });
    assert.deepEqual(offlineModels, onlineModels);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('does not replace a valid model cache with an empty catalog', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'opencode-zenmux-empty-'));

  try {
    const firstPlugin = createZenMuxOAuthPlugin({
      env: {},
      homeDir,
      now: () => 100,
      fetchImpl: async () => jsonResponse({ data: [catalogModel()] }),
    });
    const firstHooks = await firstPlugin({ client: { auth: { set: async () => {} } } });
    await firstHooks.provider.models({ models: {} });

    const emptyPlugin = createZenMuxOAuthPlugin({
      env: {},
      homeDir,
      now: () => 200,
      fetchImpl: async () => jsonResponse({ data: [] }),
    });
    const emptyHooks = await emptyPlugin({ client: { auth: { set: async () => {} } } });
    const models = await emptyHooks.provider.models({ models: {} });
    assert.deepEqual(Object.keys(models), ['example/model']);

    const config = resolveRuntimeConfig({}, homeDir);
    const stored = JSON.parse(await readFile(config.modelCachePath, 'utf8'));
    assert.equal(stored.checkedAt, 100);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('refreshes an expired OAuth token once and persists the rotated pair', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'opencode-zenmux-auth-'));
  const expired = {
    type: 'oauth',
    access: 'old-access',
    refresh: 'old-refresh',
    expires: 1,
  };
  const calls = [];
  const saved = [];

  try {
    const plugin = createZenMuxOAuthPlugin({
      env: {},
      homeDir,
      now: () => 1_000_000,
      fetchImpl: async (input, init = {}) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === 'https://zenmux.ai/oauth/token') {
          return jsonResponse({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 7200,
          });
        }
        return jsonResponse({ ok: true });
      },
    });
    const hooks = await plugin({
      client: {
        auth: {
          async set(value) {
            saved.push(value);
          },
        },
      },
    });
    const loader = await hooks.auth.loader(async () => expired);

    assert.equal(loader.baseURL, undefined);
    await Promise.all([
      loader.fetch('https://zenmux.ai/api/v1/chat/completions'),
      loader.fetch('https://zenmux.ai/api/v1/responses'),
    ]);

    const tokenCalls = calls.filter((call) => call.url.endsWith('/oauth/token'));
    const inferenceCalls = calls.filter((call) => !call.url.endsWith('/oauth/token'));
    assert.equal(tokenCalls.length, 1);
    assert.equal(new URLSearchParams(tokenCalls[0].init.body).get('client_id'), productionOAuthClientId);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].body.access, 'new-access');
    assert.equal(saved[0].body.refresh, 'new-refresh');
    for (const call of inferenceCalls) {
      assert.equal(new Headers(call.init.headers).get('authorization'), 'Bearer new-access');
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('keeps manual API-key login available', async () => {
  const plugin = createZenMuxOAuthPlugin({ env: {}, homeDir: '/tmp/example-home' });
  const hooks = await plugin({ client: { auth: { set: async () => {} } } });
  assert.deepEqual(
    hooks.auth.methods.map((method) => [method.type, method.label]),
    [
      ['oauth', 'ZenMux OAuth (PKCE)'],
      ['api', 'Manually enter ZenMux API key'],
    ],
  );
});
