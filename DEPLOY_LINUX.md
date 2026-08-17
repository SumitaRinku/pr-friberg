# PR弗一把 Linux 部署

以 Debian/Ubuntu + systemd + Nginx 为例,其他发行版自行替换包管理器。

本项目不是纯静态网站:游戏、房间、管理后台、数据同步都靠 Node.js 服务,Nginx 需要反向代理到 `127.0.0.1:3100`,不能用 `try_files`。没有 npm 运行依赖,不需要 `npm install`。

全篇约定,改任何一项都要同步改对应配置:

| 项 | 默认值 |
| --- | --- |
| 运行账户 | `friberg` |
| 项目目录 | `/var/www/friberg` |
| 端口 | `3100`(仅监听 127.0.0.1) |
| 服务名 | `fragle` |

需要:Node.js ≥ 20(系统路径安装)、sudo 权限、一个已解析到服务器公网 IPv4 的域名(下文用 `your-domain.example.com`)。

## 1. DNS

添加 A 记录指向服务器公网 IPv4。只有服务器确实配好公网 IPv6 才加 AAAA,错误的 AAAA 会让部分访问和 Certbot 验证失败。

```bash
dig +short your-domain.example.com A
```

## 2. 服务器准备

创建运行账户:

```bash
useradd --system --home-dir /var/www/friberg --shell /usr/sbin/nologin friberg
```

安装组件:

```bash
apt update
apt install -y nginx unzip certbot python3-certbot-nginx ufw git
```

安装 Node.js。Node 必须 ≥ 20 且在系统路径(如 `/usr/bin/node`),服务账户读不到 `/root/.nvm/` 下的 Node:

```bash
node --version || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; apt install -y nodejs; }
readlink -f "$(command -v node)"   # 记下路径,排障会用到
```

## 3. 部署代码

方式 A,git clone:

```bash
git clone https://github.com/SumitaRinku/pr-friberg.git /var/www/friberg
```

方式 B,本地打包上传。排除本机 `.env`、`.git`、`node_modules`、`data/admin-state.json`。

Linux/macOS:

```bash
rsync -a --exclude='.env' --exclude='.git' --exclude='node_modules' \
      --exclude='data/admin-state.json' ./ friberg-release/
tar -C friberg-release -czf friberg-release.tar.gz .
scp friberg-release.tar.gz 用户@服务器IP:/tmp/
mkdir -p /var/www/friberg && tar -xzf /tmp/friberg-release.tar.gz -C /var/www/friberg
```

Windows PowerShell:

```powershell
$stage = Join-Path $env:TEMP "friberg-release"
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
Get-ChildItem -Force | Where-Object {
    $_.Name -notin @(".env", ".git", "node_modules", "friberg-release.zip")
} | Copy-Item -Destination $stage -Recurse -Force
Remove-Item -LiteralPath (Join-Path $stage "data\admin-state.json") -Force -ErrorAction SilentlyContinue
Compress-Archive -Path "$stage\*" -DestinationPath .\friberg-release.zip -Force
scp .\friberg-release.zip 用户@服务器IP:/tmp/friberg-release.zip
```

服务器上解压后设权限:

```bash
unzip -o /tmp/friberg-release.zip -d /var/www/friberg
chown -R friberg:friberg /var/www/friberg
chmod 0755 /var/www/friberg
chmod 0750 /var/www/friberg/data
```

检查文件在根目录下,别多包一层:

```bash
ls /var/www/friberg   # 应直接看到 admin-server.mjs、data/、deploy/ 等
```

`data/` 里有离线缓存数据(players.json、arknights-operators.js 等),外部 API 挂了服务也能启动,不要删。

## 4. 环境变量

API Key 泄露过就先去 PandaScore 后台换新的。

```bash
openssl rand -base64 32   # 生成管理后台密码
touch /var/www/friberg/.env
chown friberg:friberg /var/www/friberg/.env && chmod 0600 /var/www/friberg/.env
nano /var/www/friberg/.env
```

```env
PANDASCORE_API_KEY=你的密钥,没有可删掉此行
ADMIN_PASSWORD=至少20位随机密码
HOST=127.0.0.1
PORT=3100
NODE_ENV=production
```

`PORT` 必须和 Nginx 的 `proxy_pass` 一致,不一致就是 502。没有 PandaScore Key 也能部署,选手同步会失败但游戏可用缓存数据。

确认权限(不要 cat 内容):

```bash
stat -c '%U %G %a %n' /var/www/friberg/.env
# friberg friberg 600 /var/www/friberg/.env
```

## 5. 测试和首次同步

```bash
cd /var/www/friberg && npm test
```

命令行同步,或部署后在管理后台网页点同步按钮,效果相同:

```bash
npm run sync:major     # Major 记录,Liquipedia
npm run sync:players   # 选手,PandaScore
```

PandaScore 暂时无响应时可用 `npm run sync:major-pool` 本地重建题库。

## 6. systemd 服务

```bash
install -o root -g root -m 0644 /var/www/friberg/deploy/fragle.service /etc/systemd/system/fragle.service
systemctl daemon-reload
systemctl enable --now fragle
curl --fail http://127.0.0.1:3100/healthz   # {"ok":true}
```

服务文件默认用 `/usr/bin/node`。Node 在其他路径就改 `ExecStart`。日志:

```bash
journalctl -u fragle -n 100 --no-pager
journalctl -u fragle -f
```

## 7. Nginx

```bash
nano /etc/nginx/sites-available/your-domain.example.com
```

```nginx
limit_req_zone $binary_remote_addr zone=fragle_api:10m rate=10r/s;

server {
    listen 80;
    listen [::]:80;
    server_name your-domain.example.com;

    client_max_body_size 64k;

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    location = /healthz {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        access_log off;
    }

    # 手动数据同步可能要几分钟,单独放宽超时
    location /api/admin/sync {
        limit_req zone=fragle_api burst=5 nodelay;
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 300s;
        proxy_send_timeout 30s;
    }

    location /api/ {
        limit_req zone=fragle_api burst=30 nodelay;
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
    }

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
    }
}
```

```bash
ln -sfn /etc/nginx/sites-available/your-domain.example.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
curl --fail http://your-domain.example.com/healthz
```

改端口的话三处 `proxy_pass` 一起改。访问域名进的是 Nginx 默认页就 `unlink /etc/nginx/sites-enabled/default` 再 reload。

## 8. 防火墙

云服务器还要在控制台安全组放行 80/443。

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

不要对公网开 3100。

## 9. HTTPS

```bash
certbot --nginx -d your-domain.example.com --redirect
nginx -t && systemctl reload nginx
certbot renew --dry-run
```

已有证书不含此域名时要单独申请,多域名/通配符证书除外。之后可在 443 的 `server` 块加 HSTS:

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

## 10. 上线检查

```bash
curl -I http://your-domain.example.com/
curl --fail https://your-domain.example.com/healthz
systemctl status fragle --no-pager
```

| 页面 | 地址 |
| --- | --- |
| 游戏选择 | `/` |
| CS2 弗一把 / 推理工具 | `/play`、`/tool` |
| 方舟弗一把 / 干员工具 | `/arknights`、`/arknights-tool` |
| 管理后台 | `/admin` |
| 健康 / 状态 | `/healthz`、`/api/status` |

管理后台可管理选手和干员(增删改查)、手动同步四个数据源(选手 / Major / 位置 / 干员)、设置自动同步。

## 11. 更新

git 部署的:

```bash
systemctl stop fragle
cd /var/www/friberg && sudo -u friberg git pull
npm test
systemctl start fragle
```

git pull 不碰服务器上的 `.env` 和 `data/`。

打包部署的:重新打包(排除列表再加 `data`)上传,然后:

```bash
cp -a /var/www/friberg /var/www/friberg.backup
systemctl stop fragle
unzip -o /tmp/friberg-update.zip -d /var/www/friberg
chown -R friberg:friberg /var/www/friberg && chmod 0750 /var/www/friberg/data
cd /var/www/friberg && npm test
systemctl start fragle
```

更新了 `deploy/fragle.service` 或 Nginx 配置就重新安装并 `systemctl daemon-reload` / `systemctl reload nginx`。

## 12. 故障排查

### 203/EXEC

Node 路径不对。自动改:

```bash
NODE_BIN="$(readlink -f "$(command -v node)")"
sed -i "s|^ExecStart=.*|ExecStart=$NODE_BIN /var/www/friberg/admin-server.mjs|" /etc/systemd/system/fragle.service
systemctl daemon-reload && systemctl restart fragle
```

Node 在 `/root/` 下的话装到系统路径,换 `ProtectHome` 也没用。

### 502

Nginx 正常,后端没起来或端口对不上:

```bash
systemctl status fragle --no-pager
journalctl -u fragle -n 100 --no-pager
ss -lntp | grep 3100
```

- Node 监听的端口和 `proxy_pass` 不一致(最常见,检查 `.env` 的 `PORT`)
- journal 报 `Cannot find module .../data/...` 或 ENOENT:发布包缺 `data` 目录
- 报 `EACCES`:文件归属不是 friberg,回第 3 节重新 chown
- 报 SyntaxError:代码文件传了一半,重新打包上传

### Certbot 验证失败

```bash
dig +short your-domain.example.com A
ss -lntp | grep -E ':80|:443'
ufw status && nginx -t
```

查 DNS、云安全组、80/443、AAAA 记录。

### 管理后台同步超时

```bash
nginx -T | grep -A 15 'location /api/admin/sync'
```

确认 `proxy_read_timeout` 是 `300s`。同步进行中重复点击会被拒绝(409)。
