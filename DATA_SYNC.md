# 选手与 Major 数据同步

## 日常选手同步

`scripts/sync-pandascore.mjs` 从 PandaScore 查询当前日期前 365 天到未来 120 天的 S、A、B 级 Counter-Strike 赛事，再批量读取参赛队伍的现役阵容。

这种方式不会遍历 PandaScore 中 5,500 多名“现役”记录。本次实际同步覆盖 104 个职业赛事、150 支队伍和 603 名职业选手，只消耗 4 次 API 请求。未命中近期赛事的旧选手仍会保留，退役传奇不会消失。

手动执行：

```bash
npm run sync:players
```

服务器管理员后台的自动同步和“立即同步”使用同一套逻辑。

## Major 数据

Major 统计使用 Liquipedia 的 [Player Database](https://liquipedia.net/counterstrike/Majors/Player_Database) 作为权威来源，通过其公开 MediaWiki API 读取完整页面数据：

- 每位选手的 Major 表格中，每一行代表一届正式 Major；同一届只计一次；
- `majorApps` 是去重后的正式 Major 参赛次数；
- `majorWins` 是名次为 `1` 的 Major 次数；
- 结果写入 `data/major-records.json`，并包含来源、API、定义、更新时间、赛事明细、国籍、生日、位置和选手状态；
- 选手同步时直接覆盖 `majorApps` / `majorWins`，没有记录的选手明确记为 `0`，不会继续叠加旧值；
- PandaScore 当前职业阵容中不存在的历史 Major 参赛者，也会从 Liquipedia 资料生成题库记录；同名选手使用国家后缀消歧；
- 同步完成后，`majorApps >= 1` 的题库人数必须与 Major 记录数一致。

更新 Major 数据：

```bash
npm run sync:major
```

只使用现有题库和最新 Major 记录重建完整 Major 题库（PandaScore 暂时不可用时也可执行）：

```bash
npm run sync:major-pool
```

更新 Major、PandaScore 现役阵容和 Liquipedia 位置数据：

```bash
npm run sync:all
```

Liquipedia 页面正文可能触发网页端人机验证；同步使用同站公开 API，不绕过验证，也不抓取网页渲染结果。

## 密钥

密钥只从项目根目录的 `.env` 读取：

```env
PANDASCORE_API_KEY=重新生成的密钥
```

不要把 `.env`、API Key 或管理员密码提交、上传或输出到日志。
