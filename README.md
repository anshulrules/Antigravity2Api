# Antigravity2Api

本服务将 Antigravity 代理出来，转换为标准的 Claude API 和 Gemini API 接口，

* 完整适配CC
* WORK-AROUND for MCP
* function_calling
* subagent
* 结构化输出
* 流式思考
* 完整的交错思考签名验证（thoughtsignature）
* 大香蕉生图
* web_search（Antigravity内置的flash2.5模型）
* token计算 count_tokens
* Gemini端点支持geminicli(没严格测试)
* 账号切换等等。

特性：

- **Thought Signatures（思考签名）**：按 Gemini 官方规范透传 `thoughtSignature`，在 thinking / 工具调用等场景中确保下一轮请求能原样带回签名，避免 `missing thought_signature` 类校验错误。
- **工具调用（Tool Use）**：支持 Claude `tool_use` / `tool_result` 与 Gemini `functionCall` / `functionResponse` 的互转，兼容需要工具调用的客户端/工作流。

已知问题：
在使用MCP时，claude转为antigravity的v1internal接口所使用的gemini格式后，v1internal内部判断当前model是claude，会将request转回claude格式，但是其内部接口又不能使用claude的一些字段，所以MCP会有各种奇奇怪怪的问题，这也是使用原生Antigravity时会出现各种MCP问题的原因。只能看google后续会不会去修Antigravity的MCP，或者你也可以试用下如下WORK-AROUND FOR MCP方案

### WORK-AROUND FOR MCP 折中方案（实验性）

虽然 Antigravity 内部的 MCP 兼容性问题无法从外部彻底修复，但本项目提供一个“切换到 Gemini 执行 MCP”的折中方案，避免 Claude 模型直接触发 MCP 导致异常。

**原理（简述）**

- Claude 段：当检测到请求里存在 `mcp__*` 工具时，会在 system 中注入强提示：**严禁直接调用 MCP 工具**，需要通过输出特殊字符串 `AG2API_SWITCH_TO_MCP_MODEL` 通知服务端切换。
- 服务端：如果在首轮流式输出中检测到 `AG2API_SWITCH_TO_MCP_MODEL`（或仍然出现 `mcp__*` 的 `tool_use`），会丢弃这次输出并用 `AG2API_SWITCH_TO_MCP_MODEL` 指定的 `gemini-*` 模型重发本轮请求，让 Gemini 来完成 MCP 工具调用。
- 会话隔离：进入 Gemini（MCP）段后，后续相关 `tool_result` 回合继续路由到该 Gemini 模型；回到 Claude 段时会折叠 MCP 段历史，避免跨模型携带 thought/signature 导致 `Corrupted thought signature` 等报错。

**使用方法**

1) 在 `.env` 配置 `AG2API_SWITCH_TO_MCP_MODEL`（为空/不配置则完全关闭该功能）：

```bash
# 推荐示例（仅示例，必须显式配置才会启用）
AG2API_SWITCH_TO_MCP_MODEL=gemini-3-flash
```

2) 重启服务后，Claude Code/客户端正常使用 `mcp__*` 工具场景即可（触发时服务端会自动切换并重试）。

> **推荐启动方式**：在项目根目录运行 `npm run start`（或 `node src/server.js`）。本项目会以当前工作目录（`process.cwd()`）定位 `.env`、`auths/`、`log/`；如果你在 `src/` 目录运行，则对应路径会变成 `src/.env`、`src/auths/`、`src/log/`。

启动后可直接访问管理界面：`http://localhost:3000/`（端口以 `AG2API_PORT` 为准，默认 3000）。

## 1. 环境准备

确保已安装 [Node.js](https://nodejs.org/) (建议版本 v18 或更高)。

## 2. 安装依赖

在项目根目录执行一次即可：

```bash
npm install
```

> 本项目核心逻辑可零依赖运行；但如果你启用了代理（`AG2API_PROXY_ENABLED=true`），建议执行一次 `npm install` 以确保代理对 `fetch` 生效（依赖包含 `undici` / `node-fetch` / `*-proxy-agent` 等）。

> **注意**：如果在 PowerShell 中遇到“无法加载文件...npm.ps1”的错误，请尝试使用 CMD 运行，或者使用以下命令绕过策略：
> ```bash
> cmd /c npm install
> ```

## 3. 配置文件 (.env)

在项目根目录下创建 `.env`（建议从 `.env.example` 复制），通过环境变量配置服务。

**示例 `.env`：**

```bash
AG2API_HOST=0.0.0.0
AG2API_PORT=3000
AG2API_API_KEYS=sk-your-secret-key-1,sk-your-secret-key-2
AG2API_PROXY_ENABLED=false
AG2API_PROXY_URL=
AG2API_DEBUG=false
AG2API_LOG_RETENTION_DAYS=3
AG2API_SWITCH_TO_MCP_MODEL=
AG2API_UPDATE_REPO=znlsl/Antigravity2Api
```

**配置项说明：**

- `AG2API_HOST`：监听地址
- `AG2API_PORT`：监听端口
- `AG2API_API_KEYS`：API Key（逗号分隔或 JSON 数组字符串；为空表示不校验）
- `AG2API_PROXY_ENABLED`：是否启用代理（true/false）
- `AG2API_PROXY_URL`：代理地址
- `AG2API_DEBUG`：是否开启 debug（true/false）
- `AG2API_LOG_RETENTION_DAYS`：日志保留天数（默认 3；设为 0 表示不自动清理）
- `AG2API_SWITCH_TO_MCP_MODEL`：MCP 折中方案开关；为空/不配置表示关闭，配置为 `gemini-*`（如 `gemini-3-flash`）表示在检测到 `AG2API_SWITCH_TO_MCP_MODEL` 信号或 `mcp__*` 工具调用时自动切换并重试
- `AG2API_UPDATE_REPO`：管理界面版本检查的 GitHub 仓库（默认 `znlsl/Antigravity2Api`，用于获取 latest release）

Google OAuth Client（可选覆盖）：

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`

## 4. 启动服务

运行以下命令启动服务器：

```bash
npm run start
```

启动后打开管理界面添加/删除账号：

- 管理界面：`http://localhost:3000/`
- OAuth 添加账号：点击页面中的 “OAuth 添加账号” 按钮

如果你仍然希望用命令行方式添加账号，也可以运行：

```bash
npm run add
```

> `npm run add`（或 `node src/server.js --add`）授权成功后会继续启动服务（同 `npm run start`），无需再手动重启。

## 5. Web 管理界面

管理界面提供：

- 查看已加载账号（脱敏信息）
- OAuth 添加账号（写入 `auths/*.json`）
- 删除账号（删除对应 `auths/*.json`）
- 版本更新提醒：页面底部会显示本地版本，并尝试从 GitHub latest release 获取最新版本；如发现更新会提示跳转到 Release 页面（网络不可用/被墙时会自动忽略）

如果你设置了 `AG2API_API_KEYS`，页面会要求你输入 Key 才能调用管理接口（Key 仅保存在浏览器本地）。

> OAuth 回调默认使用：`http://localhost:<port>/oauth-callback`（`<port>` 取 `AG2API_PORT`，默认 3000）。
> 若你是在远程机器访问本服务，授权完成后浏览器可能会跳转到 `localhost`，请把地址栏里的 `localhost:<port>` 改成当前服务地址再回车即可。
> 如果你不方便改地址，也可以直接复制地址栏里的完整回调链接（或仅复制 `code`），粘贴到管理页 “提交” 输入框中完成授权入库。

## 6. Docker 部署

推荐直接使用已发布的 GHCR 镜像：`ghcr.io/znlsl/antigravity2api:latest`（`linux/amd64` + `linux/arm64`）。

### 6.1 使用 GHCR 镜像（推荐）

1) 复制环境变量文件并修改（不要提交 `.env`）：

```bash
cp .env.example .env
```

2) 启动（拉取 GHCR 镜像）：

```bash
docker compose -f docker-compose.ghcr.yml up -d
```

> 私有仓库/私有镜像需要先登录：`docker login ghcr.io`

### 6.2 本地构建（可选）

本地构建适合你要改代码/调试 Dockerfile 的情况。

用 compose 构建并启动：

```bash
docker compose up -d --build
```

或手动 build + run：

构建镜像：

```bash
docker build -t antigravity2api:latest .
```

启动容器（使用 `.env` 传配置）：

```bash
docker run -d --name antigravity2api \
  -p 3000:3000 \
  --env-file .env \
  -v "$(pwd)/auths:/app/auths" \
  -v "$(pwd)/log:/app/log" \
  antigravity2api:latest
```

数据持久化：

- `./auths`（账号凭证）
- `./log`（日志）

### 6.3 GitHub Actions 自动构建 GHCR 镜像

已提供工作流：`.github/workflows/release.yml`：

- 每次 push 到 `main` 会自动构建并推送：

- `ghcr.io/znlsl/antigravity2api:latest`
- 平台：`linux/amd64` + `linux/arm64`（multi-arch）

- 每次 push tag（任意 tag，例如 `v1.2.3` / `2025.12.27-t020612`）会自动：
  - 创建 GitHub Release（自动生成 Release Notes）
  - 构建并推送镜像：`ghcr.io/znlsl/antigravity2api:<tag>` + `:latest`

### 6.4 服务器更新镜像（升级）

如果你使用的是 GHCR 镜像部署（`docker-compose.ghcr.yml`），当仓库有新提交并且 GitHub Actions 构建完成后，在服务器执行：

```bash
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

如果你使用的是本地构建（`docker-compose.yml` 的 `build:`），更新代码后需要重新构建：

```bash
docker compose up -d --build
```

## 7. 客户端连接 (如 CherryStudio)

在客户端中添加自定义提供商（Claude）：

*   **API 地址 (Endpoint)**: `http://localhost:3000` (或 `http://<本机IP>:3000`)
    *   Claude 兼容路径: `http://localhost:3000/v1/messages`
    *   Gemini 原生路径: `http://localhost:3000/v1beta`
*   **API 密钥 (API Key)**: 填写你在 `AG2API_API_KEYS` 中配置的任意一个 Key。
    *   支持的传递方式：`Authorization: Bearer <key>` / `x-api-key` / `anthropic-api-key` / `x-goog-api-key`

## 8. 常见问题

*   **401 Unauthorized**: 检查客户端填写的 API Key 是否与 `AG2API_API_KEYS` 中的一致。
*   **Proxy 错误 / 超时**:
    *   确保已运行 `npm install` 安装依赖。
    *   检查 `AG2API_PROXY_URL` 是否正确且代理软件已开启。
    *   如果是 SOCKS5 代理，确保 `socks-proxy-agent` 已安装。

*   **OAuth 回调打不开**:
    *   授权完成后若跳到 `http://localhost:<port>/oauth-callback`，请把 `localhost:<port>` 改成当前服务地址再访问。
    *   或者复制地址栏里的完整回调链接（或仅复制 `code`），粘贴到管理页输入框中点击 “提交”。
