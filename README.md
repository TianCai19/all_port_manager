# Local Port Manager

一个跑在本机的 **服务注册表 + 端口分配中心 + 可视化导航页**，专门解决「本地跑了一大堆项目，端口记不住、入口找不到、机器一重启全没了」的问题。零数据库依赖，只用一个本地 JSON 文件持久化，适合个人开发机长期常驻。

![Local Port Manager 导航页](./docs/demo.png)

> 上图为使用脱敏示例数据（`data/registry.example.json`）运行的导航页效果。

## 背景：为什么需要它（Code Agent 时代）

自从用 AI / code agent 干活之后，本地会同时冒出**特别多**临时跑起来的项目：一个前端 demo、一个 LiteLLM 代理、一个 Astro 笔记站、一个 Python `http.server`、几个一次性小工具……每个都占一个 localhost 端口。随之而来的痛点：

- **端口冲突、记不住**：3000 是哪个？8123 又是哪个？下一个空端口是几？下次部署经常和已有服务撞端口。
- **入口分散、找不到**：项目散落在各个目录，URL 只存在于某次对话或某个终端里，关掉窗口就再也找不回来。
- **忘了自己在哪部署过**：agent 帮你「跑起来了」，但你根本不知道它把服务放在哪个路径、监听哪个端口，过几天完全对不上号。
- **重启即消失**：Mac 一重启或终端一关，前台起的进程全没了，第二天打开导航页一片 502，还得手动一个个重新拉起来。

Local Port Manager 就是这堆本地服务的**单一事实来源（single source of truth）**：谁在跑、跑在哪、占哪个端口、用什么命令启动，全部登记在册；配合 macOS `launchd` 自启动，重启后自动把它们再拉起来，不用手动救火。

## 能做什么

- **防冲突**：部署前先查端口是否已被注册或被系统进程监听，并能推荐下一个可用端口。
- **注册表**：记录每个本地/远程项目的名称、路径、端口、协议、状态、标签、备注和启动命令。
- **可视化导航**：浏览器打开主页即可看到所有已部署项目，一键访问、一键用 VS Code / 终端打开项目目录。
- **开机自启（launchd）**：本地服务默认生成 `launchd` plist，重启后自动恢复，解决「重启即消失」。
- **Agent 友好 API**：Skill 或部署 Agent 可通过简单 HTTP API 拿推荐端口、注册服务、查询列表——让 agent 自己登记它跑起来的东西。

## 典型使用场景

1. **Agent 部署后自动登记**：agent 跑起一个新服务后，调用 `POST /api/services` 把名称/路径/端口/启动命令登记进来，你之后随时能找回。
2. **部署前要个空端口**：`GET /api/ports/suggest?start=3000&end=3999`，避免和已注册项目撞端口。
3. **一个页面回看所有本地项目**：打开 `http://127.0.0.1:17321`，所有 localhost 项目一览无遗，点一下就能访问或打开源码目录。
4. **重启后自动恢复**：注册时带 `autostart: true`，Manager 会写好 launchd plist，Mac 重启后服务自动回来。
5. **审计当前占用**：结合 `lsof` 核对「注册表说在跑，但实际没监听」的漂移状态。

## 非目标

- 不负责真正编排/构建业务项目（不替代 Docker Compose、PM2）。
- 不做多用户权限管理；默认只监听本地回环地址 `127.0.0.1`。
- 不做系统级全端口扫描，只管理你主动登记的服务。

## 本地启动

前置要求：Node.js `>= 20`（内置模块实现，无第三方依赖）。

```bash
git clone https://github.com/TianCai19/all_port_manager.git
cd all_port_manager

# 首次运行前，用示例文件初始化本地注册表（真实数据不入库）
cp data/registry.example.json data/registry.json

npm start
```

默认监听：`http://127.0.0.1:17321`

> `data/registry.json` 是本地运行时数据（含绝对路径、端口，可能含密钥），已在 `.gitignore`
> 中忽略，不会提交。仓库只跟踪脱敏模板 `data/registry.example.json`；若未手动拷贝，服务
> 首次启动也会自动生成一个空的 `{"services": []}`。

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LPM_HOST` | `127.0.0.1` | 监听地址 |
| `LPM_PORT` | `17321` | 监听端口 |
| `LPM_DATA_FILE` | `<repo>/data/registry.json` | 注册表数据文件路径 |
| `LPM_LABEL_PREFIX` | `local.lpm.` | 生成 launchd plist 时的 label 前缀，可设为 `com.<yourname>.lpm.` 做机器级命名空间隔离 |

## 开机自启（macOS launchd）

给本地服务传 `autostart: true` 后，Manager 会在 `~/Library/LaunchAgents` 下生成
`<LPM_LABEL_PREFIX><name>-<id8>.plist` 并 `launchctl load`，使其 `RunAtLoad` + `KeepAlive`，
重启后自动恢复。关闭 `autostart` 或删除服务会自动卸载并移除对应 plist。

想让 Manager **自身**也开机自启，可以照同样的方式给它写一份 plist（用绝对 Node 路径指向
`src/server.js`），或用系统自带方式常驻。

## 数据模型

```json
{
  "id": "generated-id",
  "kind": "local",
  "name": "My App",
  "path": "/absolute/path/to/my-app",
  "port": 3000,
  "host": "127.0.0.1",
  "protocol": "http",
  "status": "running",
  "autostart": true,
  "startupCommand": "npm --prefix /absolute/path/to/my-app run dev -- --host 127.0.0.1 --port 3000",
  "tags": ["react", "demo"],
  "description": "local frontend app",
  "remoteUrl": "",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

## API 设计

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查（返回端口、数据文件、label 前缀） |
| `GET` | `/api/services` | 获取注册服务列表，支持 `?q=&tag=&status=&kind=` |
| `POST` | `/api/services` | 注册服务；端口冲突返回 `409` |
| `PATCH` | `/api/services/:id` | 更新服务信息 |
| `DELETE` | `/api/services/:id` | 删除服务注册（并卸载 plist） |
| `GET` | `/api/ports/check?port=3000` | 检查端口是否可用 |
| `GET` | `/api/ports/suggest?start=3000&end=9999&count=1` | 推荐可用端口 |
| `GET` | `/api/stats` | 获取统计信息 |

## Agent / Skill 推荐接入流程

```bash
# 1. 部署前拿一个推荐端口
curl "http://127.0.0.1:17321/api/ports/suggest?start=3000&end=3999"

# 2. 使用返回端口启动项目
# npm run dev -- --port 3001

# 3. 注册项目（agent 应主动登记自己跑起来的服务）
curl -X POST "http://127.0.0.1:17321/api/services" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-app",
    "path": "/absolute/path/to/my-app",
    "port": 3001,
    "autostart": true,
    "startupCommand": "npm --prefix /absolute/path/to/my-app run dev -- --host 127.0.0.1 --port 3001",
    "tags": ["frontend"]
  }'
```

配套的 agent 操作规范见 [`SKILL.md`](./SKILL.md)。

## 项目结构

```text
.
├── data/registry.example.json  # 脱敏示例数据（仓库跟踪）
├── data/registry.json          # 本地运行时数据（gitignore）
├── public/                     # 可视化导航页静态资源
├── src/server.js               # HTTP API 与静态页面服务（零第三方依赖）
├── SKILL.md                    # Agent/Skill 操作规范
├── package.json                # 启动脚本
└── README.md                   # 本文档
```

## 许可

[MIT](./LICENSE)
