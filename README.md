# pr-friberg

CS2 猜职业选手 + 明日方舟猜干员，一个网页小游戏。

玩 Wordle 玩腻了？来猜 CS2 职业选手吧。系统随机选一个人，你有 8 次机会猜出来，每次猜测会告诉你队伍、国家、年龄这些信息哪些对了哪些差得多。还能拉朋友一起对战。

## 玩法

- **单人模式** — 8 次机会猜出随机选手，有完整版和简单版题库
- **随机匹配** — 服务器自动配对两个在线玩家，BO3
- **自建房间** — 生成 6 位房间码，邀请朋友，可以选 BO1/BO3/BO5，还能观战
- **推理工具** — 根据已知反馈自动筛选候选、推荐下一猜
- **明日方舟版** — 同样的玩法，猜的是方舟干员

## 本地跑起来

需要 Node.js 20+。

```bash
# 复制一份环境配置
cp .env.example .env
# 编辑 .env，填上 PandaScore API Key 和管理员密码

npm start
# 打开 http://127.0.0.1:3000
```

Windows 用户也可以双击 `run-server.cmd`。

## 页面

| 路径 | 说明 |
|------|------|
| `/` | 首页，选游戏 |
| `/play` | CS2 猜选手 |
| `/tool` | CS2 推理辅助工具 |
| `/arknights` | 明日方舟猜干员 |
| `/arknights-tool` | 明日方舟干员筛选工具 |
| `/admin` | 管理后台（需要密码） |
| `/api/status` | 服务状态 |

## 部署

部署到 Linux 服务器的完整流程（systemd + Nginx + HTTPS）见 [DEPLOY_LINUX.md](DEPLOY_LINUX.md)。

## 测试

```bash
npm test
```

## 数据同步

选手数据来自 PandaScore，启动时自动同步，之后每 24 小时更新一次。同步失败会用本地缓存兜底，不会挂掉。

- `npm run sync:players` — 手动同步选手
- `npm run sync:roles` — 从 Liquipedia 同步选手位置
- `npm run sync:major` — 更新 Major 参赛记录
- `npm run sync:arknights` — 核对明日方舟干员数据

## 技术栈

纯 Node.js，零 npm 依赖。前端也是原生 JS，没用框架。

## License

Private project.
