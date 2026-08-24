---
name: local-port-manager
version: 1.1.0
description: 本地 localhost 项目端口注册表、launchd 自启动、端口分配和导航页助手。用于部署/注册/修复本地服务，或检查 localhost 服务是否真实可打开。
metadata:
  requires:
    bins: ["node", "npm", "curl"]
---

# Local Port Manager Skill

你负责使用本机的 Local Port Manager 管理本地项目端口、服务注册表和 macOS `launchd` 自启动。

## 固定信息

- Manager 项目路径：`/Users/bytedance/codes/fun/all_port_manager`
- 默认 API Base URL：`http://127.0.0.1:17321`
- 默认可视化主页：`http://127.0.0.1:17321`
- 注册表文件：`/Users/bytedance/codes/fun/all_port_manager/data/registry.json`
- launchd plist 目录：`~/Library/LaunchAgents`
- launchd label 前缀：`com.bytedance.lpm.`
- 默认推荐端口范围：`3000-9999`

## 强制工作流

### 1. 先确保 Manager 可用

每次使用本 Skill，先健康检查：

```bash
curl -sS "http://127.0.0.1:17321/api/health"
```

如果连接失败或 Manager 未启动，启动它：

```bash
npm --prefix "/Users/bytedance/codes/fun/all_port_manager" start
```

在 Agent 工具环境中，优先用后台进程启动；启动后再次请求 `/api/health` 验证。

### 2. 部署前先推荐端口

```bash
curl -sS "http://127.0.0.1:17321/api/ports/suggest?start=3000&end=9999&count=1"
```

如果用户指定端口，先检查端口：

```bash
curl -sS "http://127.0.0.1:17321/api/ports/check?port=3000"
```

判断规则：

- `available: true`：可以使用。
- `registered: true`：已被注册表中的项目占用，不要直接复用，除非用户明确要求。
- `listening: true`：系统已有进程监听，不要直接复用。

### 3. 本地服务默认启用 launchd 自启动

注册本地服务时，默认设置：

```json
"autostart": true
```

如果明确知道启动命令，传入 `startupCommand`。如果没有传，Manager 会尽量根据项目结构自动推断：

- `package.json` 有 `start`：`npm --prefix <path> start`
- Next/Vite/Astro 有 `dev`：自动附加注册端口和 localhost host 参数
- 目录里有 HTML：`python3 -m http.server <port> --bind 127.0.0.1 --directory <path>`

示例：

```bash
curl -sS -X POST "http://127.0.0.1:17321/api/services" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-app",
    "path": "/absolute/project/path",
    "port": 3001,
    "host": "127.0.0.1",
    "protocol": "http",
    "status": "running",
    "autostart": true,
    "startupCommand": "npm --prefix /absolute/project/path run dev -- --host 127.0.0.1 --port 3001",
    "tags": ["local"],
    "description": "local dev service"
  }'
```

`launchd` 不支持 shell 风格的内联环境变量放在 `ProgramArguments` 里。可以在 `startupCommand` 前面写 `KEY=value command ...`，Manager 会自动提取到 plist 的 `EnvironmentVariables`。

### 4. 写入后必须验证真实可用

写入、更新或修复服务后，必须至少验证：

```bash
launchctl list | rg "com\\.bytedance\\.lpm"
lsof -nP -iTCP:<port> -sTCP:LISTEN
curl -sS --max-time 5 -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:<port>/"
```

涉及页面可打开性时，优先用 Playwright 做浏览器实测。例如：

```bash
npm exec --yes playwright -- screenshot --timeout=60000 "http://127.0.0.1:<port>/" "/tmp/lpm-check-<port>.png"
```

如果本机 Playwright 浏览器缺失，可执行：

```bash
npm exec --yes playwright -- install chromium
```

`launchctl list` 中出现 PID 才代表进程仍在运行；`- 78` 或类似非零状态只表示加载过但失败退出，不能当作成功。

### 5. 更新或删除服务

更新服务：

```bash
curl -sS -X PATCH "http://127.0.0.1:17321/api/services/<id>" \
  -H "Content-Type: application/json" \
  -d '{"autostart":true,"startupCommand":"npm --prefix /path start"}'
```

删除服务：

```bash
curl -sS -X DELETE "http://127.0.0.1:17321/api/services/<id>"
```

删除或关闭 `autostart` 会自动卸载并移除对应 plist。

## 常用排障

- plist 已生成但服务打不开：先看 `launchctl list | rg com.bytedance.lpm`，如果是 `- 78`，看 `~/Library/Logs/com.bytedance.lpm.<name>.error.log`。
- `EADDRINUSE`：端口已有旧进程。用 `lsof -nP -iTCP:<port> -sTCP:LISTEN` 确认 PID；如果确实是同一服务旧进程，可停止旧 PID 后 `launchctl kickstart -k gui/$(id -u)/<label>`。
- `npm` 找不到：Manager 生成 plist 时会使用本机绝对 npm 路径 `/Users/bytedance/.local/bin/node/bin/npm`，不要手写依赖交互 shell 的 PATH。
- Vite/Next/Astro 默认端口不等于注册端口：启动命令必须显式传 `--port <port>`，并绑定 `127.0.0.1`。

## 输出要求

最终汇报必须说明：

- 修改或注册了哪些服务。
- 是否生成并加载了 launchd plist。
- 实际验证命令和结果，特别是 Playwright 浏览器验证是否通过。
