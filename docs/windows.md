# 把 ZenMux 订阅插件装到 Windows 上的 magpie

插件是纯 ESM 的 OpenCode provider 插件（无原生依赖、不需要编译），Windows 上按「文件夹」方式装即可。
仓库根目录就是 npm 包根（`package.json` 在根），所以 **克隆/下载整个仓库** 就是一个可加载的插件目录。

## 1) 把仓库弄到 Windows

任选一种：

**A. git clone（推荐，之后更新只要 `git pull`）**

```powershell
cd $env:USERPROFILE\magpie-plugins   # 没有就先 New-Item -ItemType Directory $env:USERPROFILE\magpie-plugins
git clone https://github.com/Hara602/magpie-zenmux.git
```

（没有 git 的话，装个 Git for Windows，或用 GitHub 网页的 **Code → Download ZIP**。）

**B. 从服务器直接拷**

```powershell
scp chr@<服务器>:/home/chr/magpie-plugin/opencode-zenmux-auth-0.1.0.zip "$env:USERPROFILE\Downloads\"
```

zip 解压后是 `opencode-zenmux-auth\` 文件夹，同样可以直接当插件目录用。

插件是「就地加载」的：**文件夹放哪就一直在哪读**，不要放临时目录，也别放需要管理员权限的 `Program Files`。

## 2) 确认 magpie 支持插件

```powershell
magpie --help | Select-String -Pattern "plugin"
```

没有 `plugin` 这一行说明 magpie 太旧，先更新：

```powershell
magpie update
```

## 3) 安装并登录

```powershell
# 用克隆下来的文件夹（路径按你的实际位置）
magpie plugin add "$env:USERPROFILE\magpie-plugins\magpie-zenmux"

# 或者直接让 magpie 从 GitHub 拉（等价，以后 magpie plugin update 可更新）
magpie plugin add github:Hara602/magpie-zenmux
```

第一次 add 时 magpie 会下载 Bun（约 100 MB，之后不再下载）。看到下面这样就算加上了：

```
✓ added ...\opencode-zenmux-auth
  zenmux (ZenMux, 102 models)  not signed in · magpie plugin login zenmux
```

在 ZenMux 拿两把钥匙（都是 2026-11-10 之后的新前缀）：

| Key | 前缀 | 在哪建 | 用途 |
| --- | --- | --- | --- |
| 订阅 API Key | `sk-subs-…` | https://zenmux.ai/platform/subscription | 聊天 |
| Management API Key | `sk-mgmt-…` | https://zenmux.ai/platform/management | 额度（可留空） |

```powershell
magpie plugin login zenmux
# 依次问：订阅 Key → 管理 Key（可空）→ 邮箱（可空，用来给账号起名）
```

## 4) 验收

```powershell
magpie plugin --json        # 找 "zenmux": models 有数、usage: true、signedIn: true
magpie provider test zenmux # 应看到 ✓ chat
magpie quota                # 5h / 7d Flows + monthly 上限 + 剩余重置换次数
```

期望输出（示例）：

```
zenmux · Builder Pro · until Dec 14 · you@example.com  subscription
  5h 10% (5.19 / 50 Flows) ↻3h16m  7d 2% (5.19 / 213 Flows) ↻6d22h
  monthly 914 Flows/month   ↺ 3 five-hour resets until Dec 14
```

App 里也可以：**Plugins → Add a plugin** 选那个文件夹，或在 Plugins → Installed 里点 provider 行的登录。
之后 agent 里模型名是 `zenmux/<vendor>/<model>`，例如 `zenmux/openai/gpt-6.1-terra`。

## 5) 更新 / 卸载

```powershell
# 克隆方式：拉最新，然后让 magpie 重新加载
cd "$env:USERPROFILE\magpie-plugins\magpie-zenmux"
git pull
magpie plugin off zenmux ; magpie plugin on zenmux

# GitHub 方式：plugin update
magpie plugin update

# 卸载
magpie plugin rm opencode-zenmux-auth
```

## 6) 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `unknown command "plugin"` | magpie 版本太旧，`magpie update` |
| add 之后行尾是 `failed: …` | 看报错；常见是 Bun 下载失败（代理/网络）。magpie 的代理在 Settings → 网关/代理，或设 `HTTPS_PROXY` 后重试 |
| 登录报 “ZenMux refused this API key (HTTP 403)” + legacy 文案 | 用了旧前缀 Key（`sk-ss-v1-` / `sk-mg-v1-` 已停用），去控制台建 `sk-subs-…` / `sk-mgmt-…` |
| 登录成功但 `magpie quota` 没有额度 | 登录时 Management Key 留空了；`magpie plugin logout zenmux` 后重新 `login`，把 `sk-mgmt-…` 填上 |
| `provider test` 里 `anthropic`/`gemini` 是 404 | 正常：该命令按 `/api/v1` 探测所有协议，ZenMux 的 Anthropic/Vertex 端点在 `/api/anthropic/v1`、`/api/vertex-ai`；agent 走 chat，不影响 |
| 之前装过官方 `@zenmux/opencode-oauth` | 两者都签 `zenmux`，只一个生效。先 `magpie plugin rm @zenmux/opencode-oauth`，或 `magpie plugin use opencode-zenmux-auth zenmux` 指定 |
| 路径报错 / 找不到插件 | PowerShell 路径要带引号；别用 `Program Files` 等需要管理员权限的位置 |

<a id="dsh-web-search"></a>
### dsh 聊天正常，但网页搜索报 `no web_search_tool_result blocks`

如果使用 **DeepSeek Harness（dsh）→ Magpie → 本插件 → ZenMux** 聊天，dsh 的内置
`web-search-deepseek` 仍会另外发送一次搜索请求。它有独立的 Messages API base URL、
模型和凭据配置，不会因为聊天接通就自动获得搜索能力。本插件只提供 ZenMux 的模型、
鉴权与额度查询，没有实现或配置 dsh 的搜索提供方。

报错例如：

```text
DeepSeek returned no web_search_tool_result blocks;
the request may not have triggered native web search
The web request used endpoint "http://127.0.0.1:3425/v1/messages".
```

这表示 dsh 收到了可解析的响应，但其中没有它要求的原生搜索结果块。dsh 发送的是
`web_search_20250305` 服务端工具，并且只从 `web_search_tool_result` 中读取来源：
普通 `text`（即使包含链接）或普通函数调用 `tool_use` 都不能替代它。一个内容为空的
`web_search_tool_result` 也能通过解析，所以这条错误并不是“没有搜到网页”。

按下面顺序排查：

1. 在 **dsh 自己的界面**打开报错所指的 **Plugins → Built-in plugin settings → Web search**，
   核对 **Messages API base URL**，并在修改后保存。新版页面可能叫 **Web search and fetch**，
   Messages 搜索对应 **DeepSeek (legacy)**。搜索模型从实际部署配置或下述请求事件中核对；
   部分版本的设置页不提供模型编辑字段。报错里的
   `http://127.0.0.1:3425/v1/messages` 是当次实际请求的地址；基址字段由 dsh
   自动追加 `/messages`，不要把完整的请求地址再填进去。
2. 如果搜索也要经过本机 Magpie，需要核对搜索模型的完整 ID，以及 **Magpie 自己的**
   **Settings → Models → Web search**。Magpie 可以转发上游的原生搜索，也可以用其他
   已配置的来源代搜，再编码成 `web_search_tool_result`；因此不要求聊天模型本身
   一定能搜索。聊天测试通过、模型支持普通工具调用、或改成完整模型 ID，都不能
   单独证明搜索可用。在 Magpie 的 **Routing** 页确认搜索实际走了哪个来源。
3. 如果决定让搜索使用其他端点，请由你选择信任且支持该搜索协议的端点，并配置该
   端点接受的凭据。不要把 ZenMux 的订阅 Key 当作 DeepSeek 直连凭据。若设置页不可用，
   对应的部署配置项是 `web-search-deepseek.baseURL`；环境变量回退项是
   `DEEPSEEK_SEARCH_BASE_URL`，已有显式 `baseURL` 时环境变量不会覆盖它。

**为什么接入 ChatGPT Plus 时搜索能用？** Magpie 对 ChatGPT/Codex 账号有专门的搜索
适配：可以使用 ChatGPT 后端搜索，也可以让该账号替其他模型代搜。若 Plus 是通过
Magpie 接入，这就能解释它与单独接入 ZenMux 时的差别；实际来源仍以 Routing 为准。
可以保留已登录且启用的 ChatGPT/Codex 账号，在 Magpie 的 Web search 页面将它选为
**Searches for other models**，同时继续使用 ZenMux 的聊天模型。仅切换聊天模型，
不会自动证明 ZenMux 那条上游也能执行同样的搜索。

Magpie 上游 [issue #2726](https://github.com/yetone/magpie/issues/2726) 还记录过相同
错误：某些版本会把 dsh 搜索指向网关，即使网关没有可用搜索来源；返回普通文本后
dsh 就会报缺少结果块。不要仅凭错误里的地址认定是用户填错了配置，需要结合实际
版本、搜索来源和请求日志判断。

进一步定位时，提供 dsh 版本、搜索基址、搜索模型，以及搜索响应中 `content[].type`
的列表即可；不要贴 API Key、Authorization 请求头或完整凭据文件。dsh 的
`web/deepseek-search-llm-request` 会话事件记录实际搜索端点和请求体，可用于核对请求
是否符合预期，但它不是上游响应日志。

参考：dsh 官方
[搜索提供方说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web-search-deepseek/README.md)
和
[请求与响应解析实现](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web-search-deepseek/src/provider.ts)，
以及 [Magpie 搜索说明](https://usemagpie.ai/docs/web-search)。

## 说明

- 插件在服务器上用 magpie v0.1.3913 + 隔离沙箱（独立 `HOME`）+ 本地 mock 验证过；Windows 走同一份纯 JS 代码，没有平台差异。
- 插件只向 `zenmux.ai` 发请求（`/api/v1` 聊天、`/api/v1/management` 额度、`/api` 公开计划表），
  不读本地文件、不跑厂商 CLI；magpie 加的 `x-magpie-*` 内部请求头在转发前会被删掉。
