=== magpie quota ===
zenmux · Builder Ultra · until Dec 14 · qa@example.com  subscription  5h 10% (5.19 / 50 Flows) ↻3h16m 18:05  7d 2% (5.19 / 213 Flows) ↻6d22h Nov 21 13:05  monthly 914 Flows/month ($30)  ↺ 3 five-hour resets until Dec 14 13:02
  % is how much of a window is used · ↻ when it starts again · --json for scripts, or GET /v1/magpie/quotas on the gateway

=== magpie provider test zenmux ===
  ✓ chat       4 ms · google/gemini-4-hydrogen
  ✗ responses  404 · no such route: /api/v1/responses
  ✗ anthropic  404 · no such route: /api/v1/messages

=== magpie plugin --json (summary) ===
{'id': 'zenmux', 'name': 'ZenMux', 'models': 169, 'usage': True, 'signedIn': True, 'methods': ['api']}

=== node --test ===
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 95.189769
