# Local Port Manager PRD

Local Port Manager 是一个本地服务注册表 + 端口分配中心 + 可视化导航页。它解决多项目本地部署时端口冲突、项目入口分散、Agent/Skill 无法统一查询当前端口占用的问题。

## 目标

- **防冲突**：部署前先通过 API 查询端口是否已被注册或系统监听占用。
- **注册表**：记录每个本地项目的名称、路径、端口、协议、状态、标签和备注。
- **可视化导航**：浏览器打开主页即可看到本地已部署项目，并一键访问服务地址。
- **Agent 友好 API**：Skill 或部署 Agent 可通过简单 HTTP API 获取推荐端口、注册服务、查看服务列表。
- **零数据库依赖**：使用本地 JSON 文件持久化，适合个人开发机长期运行。

## 非目标

- 不负责真正启动/停止业务项目进程。
- 不替代 Docker Compose、PM2 或系统级端口扫描工具。
- 不做多用户权限管理；默认只监听本地回环地址。

## 使用场景

1. 部署前查询可用端口：`GET /api/ports/suggest?start=3000&end=9999`
2. 部署后注册服务：`POST /api/services`
3. 打开 `http://127.0.0.1:17321` 查看当前本地项目导航。
4. 后续 Agent/Skill 按项目名、端口或路径查询，避免重复占用端口。

## 数据模型

```json
{
  "id": "generated-id",
  "name": "My App",
  "path": "/Users/me/codes/my-app",
  "port": 3000,
  "host": "127.0.0.1",
  "protocol": "http",
  "status": "running",
  "tags": ["react", "demo"],
  "description": "local frontend app",
  "createdAt": "2026-05-16T00:00:00.000Z",
  "updatedAt": "2026-05-16T00:00:00.000Z"
}
```

## API 设计

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/services` | 获取注册服务列表，支持 `?q=&tag=&status=` |
| `POST` | `/api/services` | 注册服务；端口冲突会返回 `409` |
| `PATCH` | `/api/services/:id` | 更新服务信息 |
| `DELETE` | `/api/services/:id` | 删除服务注册 |
| `GET` | `/api/ports/check?port=3000` | 检查端口是否可用 |
| `GET` | `/api/ports/suggest?start=3000&end=9999&count=1` | 推荐可用端口 |
| `GET` | `/api/stats` | 获取统计信息 |

## Agent/Skill 推荐接入流程

```bash
# 1. 部署前拿一个推荐端口
curl "http://127.0.0.1:17321/api/ports/suggest?start=3000&end=3999"

# 2. 使用返回端口启动项目
# npm run dev -- --port 3001

# 3. 注册项目
curl -X POST "http://127.0.0.1:17321/api/services" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app","path":"/Users/me/codes/my-app","port":3001,"tags":["frontend"]}'
```

## 项目结构

```text
.
├── data/registry.json      # 本地注册表数据
├── public/                 # 可视化导航页静态资源
├── src/server.js           # HTTP API 与静态页面服务
├── package.json            # 启动脚本
└── README.md               # PRD 与使用说明
```

## 本地启动

```bash
# 首次运行前，用示例文件初始化本地注册表（真实数据不入库）
cp data/registry.example.json data/registry.json

npm install
npm start
```

默认监听：`http://127.0.0.1:17321`

> `data/registry.json` 是本地运行时数据（含绝对路径、端口，可能含密钥），已在
> `.gitignore` 中忽略，不会提交。仓库只跟踪脱敏模板 `data/registry.example.json`；
> 若未手动拷贝，服务首次启动也会自动生成一个空的 `{"services": []}`。

## 许可

[MIT](./LICENSE)


