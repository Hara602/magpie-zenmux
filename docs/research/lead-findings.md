# Lead 已核实的 ZenMux 事实（2026-11-14）

## 订阅（Builder Plan）
- 官方文档：https://zenmux.ai/docs/guide/subscription.html
- 四档：Free $0（仅 Studio Chat，无 API）/ Starter $20 50 Flows 5h / Max $100 300 Flows / Ultra $200 800 Flows。
- 订阅聊天 Key：前缀 `sk-ss-v1-`，在 https://zenmux.ai/platform/subscription 创建；与 PAYG Key 用法完全一致，
  走 https://zenmux.ai/api/v1（OpenAI 兼容）、/api/anthropic/v1、/api/vertex-ai。
- 额度单位 Flow，5h 滚动窗口 + 7 天滚动窗口 + 月度上限三窗口同时生效；10–15 RPM。
- 额度接口（只需 Management API Key）：
  `GET https://zenmux.ai/api/v1/management/subscription/detail`
  `Authorization: Bearer <sk-mg-v1-…>`（https://zenmux.ai/platform/management 创建；普通/订阅 Key 不接受）
  响应（success:true, data）：
  - plan: { tier: free|pro|max|ultra, amount_usd, interval:"month", expires_at }
  - currency: "usd"
  - base_usd_per_flow / effective_usd_per_flow
  - account_status: healthy|monitored|abusive|suspended|banned
  - quota_5_hour: { usage_percentage 0–1, resets_at ISO|null, remaining_resets(整数), max_flows, used_flows, remaining_flows, used_value_usd, max_value_usd }
  - quota_7_day: 同上（无 remaining_resets）
  - quota_monthly: { max_flows, max_value_usd }
- 无凭证探测：该 detail 端点无 key → 401 {"success":false,"message":"API key not provided"}；错 key → 403。
- 对照实现（社区已有人做过取额度）：
  - Anarcadia/codexbar-zenmux-patch-pack（AGENTS.md 明确端点与 Bearer 管理 Key）
  - wayyoungboy/code_bar 的 CodeBar/Providers/ZenMuxProvider.swift（字段解析齐全）
  - jorben/quotax（ZenMux 订阅额度菜单栏监控）
- 文档里没有「计划包含哪些模型」的接口；/api/v1/management/subscription/{plans,models,flow-rate} 无 key 均 302→/（即不存在）。
  候选方案：用公开 `GET https://zenmux.ai/api/v1/models`（219 个模型，已验证 200，无鉴权）过滤 output_modalities 含 text，
  或按订阅 Key 再请求一次看是否按计划过滤（待验证）；也可用插件 options 手工白名单。

## 公开模型目录
- `GET https://zenmux.ai/api/v1/models` 无鉴权可用（162KB, 219 条）。
- 每条：id(`<vendor>/<model>`), display_name, created, owned_by, input_modalities[], output_modalities[],
  capabilities{reasoning:bool}, context_length, max_tokens, pricings{prompt/completion/input_cache_read/... 数组: {value, unit perMTokens|perCount|perSecond, currency:"USD", conditions?}}, publish_time。
- 只有 capabilities.reasoning 一个能力位；没有 tool_call 位。

## 本机环境
- magpie v0.1.3913，网关 127.0.0.1:3425，二进制 /home/chr/.local/bin/magpie。
- 本机 providers 只有 remote-magpie(→10.201.164.43:3425, 远端 magpie v0.1.3605)，远端已有一个 zenmux-builder 订阅 provider
  （plan "Builder Starter"，user "API key …T2Um"，5h 5.19/50 Flows，7d 5.19/213 Flows，balance 914 Flows，until 2026-12-14）。
  → 说明「订阅 Key + 管理 Key」方案在 magpie 里可行，且 magpie 的 usage 窗口结构可映射：
  5h: used=usage_percentage*100, resetsAt, amount=used_flows, limit=max_flows, unit="Flows"
  7d: 同上
- 社区 registry.json 中没有 zenmux 条目（确认用户所说「magpie 没有 zenmux 订阅插件」）。
- 沙箱测试可行：HOME/XDG 独立后 `magpie plugin add <folder>` 成功，Bun 自动下载到沙箱 cache，
  `printf '<key>\n' | magpie plugin login <provider>` 可非交互登录。