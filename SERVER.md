# 独立服务器部署

项目只需要 Node.js 20 或更高版本，不需要 GitHub、数据库或第三方 npm 包。

## Windows 快速启动

1. 在项目根目录新建 `.env`。
2. 填入一个已经重新生成的 PandaScore Key：

```env
PANDASCORE_API_KEY=your_new_key
HOST=127.0.0.1
PORT=3000
```

3. 双击 `run-server.cmd`。
4. 浏览器打开 `http://127.0.0.1:3000`。

服务启动后会立即同步一次，此后每 24 小时同步一次。成功结果保存在 `data/players.json`；同步失败时继续使用最后一次缓存。

## Linux / 云服务器

```bash
PANDASCORE_API_KEY="your_new_key" HOST=0.0.0.0 PORT=3000 node server.mjs
```

生产环境建议使用 systemd、PM2 或 Docker 保持进程常驻，并在前面配置 Nginx HTTPS 反向代理。不要直接向公网暴露没有 HTTPS 的 3000 端口。

## 环境变量

| 名称 | 默认值 | 说明 |
|---|---:|---|
| `PANDASCORE_API_KEY` | 无 | PandaScore 密钥；未配置时只使用缓存或内置数据 |
| `HOST` | `127.0.0.1` | 监听地址；容器或公网部署可设为 `0.0.0.0` |
| `PORT` | `3000` | HTTP 端口 |
| `SYNC_INTERVAL_MS` | `86400000` | 同步间隔，最低允许 1 小时 |

## 状态检查

```text
GET /api/status
```

会返回当前数据来源、选手数量、最近同步时间、同步错误和密钥是否已配置，但不会返回密钥。

```text
GET /api/players
```

返回服务器当前使用的选手资料。

## 安全策略

- API Key 只由 Node 服务读取，通过 Bearer 请求头发送给 PandaScore。
- `.env` 已加入 `.gitignore`。
- 网页加载的是服务器动态生成的数据脚本，不包含 API Key。
- 同步结果少于 50 位或字段不完整时拒绝替换现有缓存。
