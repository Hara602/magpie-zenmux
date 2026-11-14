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

## 说明

- 插件在服务器上用 magpie v0.1.3913 + 隔离沙箱（独立 `HOME`）+ 本地 mock 验证过；Windows 走同一份纯 JS 代码，没有平台差异。
- 插件只向 `zenmux.ai` 发请求（`/api/v1` 聊天、`/api/v1/management` 额度、`/api` 公开计划表），
  不读本地文件、不跑厂商 CLI；magpie 加的 `x-magpie-*` 内部请求头在转发前会被删掉。