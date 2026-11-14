# Research notes

The research behind this plugin, kept for anyone maintaining it. Nothing here is part
of the package (`package.json` `files` leaves it out).

| File | What it is |
| --- | --- |
| `lead-findings.md` | First-hand ZenMux facts: Builder Plan, the two keys, quota fields, the local remote-magpie comparison |
| `zenmux-api.md` | Deep dive by the API researcher: key prefix migration (2026-11-10), every endpoint, error semantics, plan tiers |
| `magpie-spec.md` | magpie v0.1.3913 plugin contract, verified against the binary's recovered host.js: hook shapes, `X-Magpie-Sign-In`, `x-magpie-*` headers, options, sandbox recipe |
| `verification.md` | Output of the sandbox run: `quota`, `provider test`, `plugin --json`, `node --test` |
| `mock-zenmux.py` | A stand-in ZenMux API (models, subscription detail, chat + SSE) for testing without a real key |
| `zenmux-models-probe.json`, `probe-get_all_plans.json` | Public API responses the mock replays |
| `registry.json` | Snapshot of magpie-community's plugin registry |

Run the mock:

```sh
python3 docs/research/mock-zenmux.py 3599
```

then point the plugin at it with `ZENMUX_API_BASE`, `ZENMUX_MANAGEMENT_API_BASE`,
`ZENMUX_PUBLIC_API_BASE` (see `docs/zh-CN.md`).

## Third-party material

`zenmux-opencode-plugin/` is ZenMux's official OpenCode OAuth plugin (MIT,
<https://github.com/ZenMux/opencode-plugin>), and `zenmux-provider.swift` is CodeBar's ZenMux
quota reader (MIT, <https://github.com/wayyoungboy/code_bar>). They are kept as references for
the OAuth and quota work, with their licenses intact; neither is part of this package.
