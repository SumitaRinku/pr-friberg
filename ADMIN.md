# PR弗一把 管理后台

管理入口：`/admin`。后台支持选手新增、编辑、删除，PandaScore 手动同步，以及 1–168 小时的自动同步间隔。

管理员密码在服务器 `.env` 中配置，不在网页后台设置：

```env
ADMIN_PASSWORD=请替换为足够长且唯一的随机密码
```

管理员会话有效期为 8 小时。密码修改后请重启 `fragle` 服务使新配置生效。登录接口按来源 IP 限制失败次数。手工修改保存在 `data/admin-state.json`，最终合并数据保存在 `data/players.json`；后续 PandaScore 同步不会覆盖管理员修改。

修改配置后重启服务：

```bash
sudo systemctl restart fragle
sudo systemctl status fragle --no-pager
```

不要把 `.env` 上传到服务器之外，也不要复用已经公开过的管理员密码或 PandaScore API Key。完整 Linux 部署步骤见 [DEPLOY_LINUX.md](DEPLOY_LINUX.md)。

