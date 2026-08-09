# PR弗一把 Linux HTTPS 部署

本文使用与普通静态网站相近的部署方式：本地打包 ZIP、上传到 `/tmp`、解压到 `/var/www`、在 Nginx 的 `sites-available` 新建站点，再通过 Certbot 开启 HTTPS。

本项目不是纯静态网站。游戏、随机匹配、自建房间、管理后台和数据同步都依赖 Node.js 服务，因此 Nginx 必须反向代理到 `127.0.0.1:3100`，不能使用纯静态站点的 `try_files` 配置。

服务器环境：

```text
Node.js v20.20.0
npm 10.8.2
运行账户 root
项目目录 /var/www/friberg
域名 your-domain.example.com
```

## 1. DNS

在 DNS 服务商添加：

```text
类型  主机记录  记录值
A     friberg   服务器公网 IPv4
```

只有服务器已经正确配置公网 IPv6 时才添加 AAAA 记录。错误的 AAAA 记录会导致部分访问和 Certbot 验证失败。

确认解析：

```bash
dig +short your-domain.example.com A
dig +short your-domain.example.com AAAA
```

A 记录应返回当前服务器公网 IPv4。

## 2. 本地打包

在 Windows PowerShell 中进入项目根目录：

```powershell
cd F:\repos\cs2_shnlfriberg_tool
```

为了避免上传本机 `.env`、`node_modules` 和管理员运行状态，先建立临时发布目录再压缩：

```powershell
$stage = Join-Path $env:TEMP "friberg-release"
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

Get-ChildItem -Force | Where-Object {
    $_.Name -notin @(".env", ".git", "node_modules", "friberg-release.zip", "friberg-update.zip")
} | Copy-Item -Destination $stage -Recurse -Force

$adminState = Join-Path $stage "data\admin-state.json"
if (Test-Path $adminState) { Remove-Item -LiteralPath $adminState -Force }

Compress-Archive -Path "$stage\*" -DestinationPath .\friberg-release.zip -Force
```

上传到服务器：

```powershell
scp .\friberg-release.zip root@服务器IP:/tmp/friberg-release.zip
```

发布包应包含当前的 `data/players.json` 和 `data/major-records.json`，确保外部 API 暂时失败时仍能启动。

## 3. 服务器解压

登录服务器：

```powershell
ssh root@服务器IP
```

以下命令全部在 root shell 中执行，不使用 `sudo`，也不创建额外用户。

安装需要的系统组件。服务器已有 Node.js 和 npm，不需要重复安装：

```bash
apt update
apt install -y nginx unzip certbot python3-certbot-nginx ufw
node --version
npm --version
command -v node
```

`node --version` 应显示 `v20.20.0`。先记录 Node 的真实路径：

```bash
command -v node
readlink -f "$(command -v node)"
ls -l /usr/bin/node
```

仓库中的 systemd 配置默认使用 `/usr/bin/node`。如果 `readlink` 返回其他位置，应在安装服务文件后把 `ExecStart` 改为该绝对路径。若路径位于 `/root/.nvm/`，还要关闭该服务的 `ProtectHome`，否则 systemd 会返回 `203/EXEC`。第 12 节给出了可直接执行的修复命令。

创建目录并解压：

```bash
mkdir -p /var/www/friberg
unzip -o /tmp/friberg-release.zip -d /var/www/friberg
chown -R root:root /var/www/friberg
chmod 0755 /var/www/friberg
chmod 0750 /var/www/friberg/data
```

确保文件直接位于：

```text
/var/www/friberg/admin-server.mjs
/var/www/friberg/app-server.mjs
/var/www/friberg/play.html
/var/www/friberg/index.html
/var/www/friberg/admin.html
/var/www/friberg/data/players.json
/var/www/friberg/deploy/fragle.service
```

检查：

```bash
ls -la /var/www/friberg
```

如果实际变成 `/var/www/friberg/cs2_shnlfriberg_tool/admin-server.mjs`，说明压缩时多包了一层目录，需要把内层文件移动到 `/var/www/friberg` 后再继续。

## 4. 创建环境变量

此前公开过的 PandaScore API Key 必须撤销并重新生成，不要继续使用旧 Key。

生成管理员密码：

```bash
openssl rand -base64 32
```

创建配置：

```bash
touch /var/www/friberg/.env
chown root:root /var/www/friberg/.env
chmod 0600 /var/www/friberg/.env
nano /var/www/friberg/.env
```

填入：

```env
PANDASCORE_API_KEY=替换为新生成的PandaScore密钥
ADMIN_PASSWORD=替换为长度至少20位的随机密码
HOST=127.0.0.1
PORT=3100
NODE_ENV=production
```

保存后只检查权限，不要输出文件内容：

```bash
stat -c '%U %G %a %n' /var/www/friberg/.env
```

预期：

```text
root root 600 /var/www/friberg/.env
```

## 5. 测试和初次同步

项目没有第三方 npm 运行依赖，不需要执行 `npm install`。

```bash
cd /var/www/friberg
/usr/bin/npm test
```

可在启动服务前同步一次数据：

```bash
/usr/bin/npm run sync:major
/usr/bin/npm run sync:players
```

Major 同步来自 Liquipedia，选手同步来自 PandaScore。如果 PandaScore 暂时无响应，可执行 `/usr/bin/npm run sync:major-pool`，使用现有选手资料和最新 Major 记录本地重建完整题库。不要删除 `data` 目录，服务可以继续使用发布包中的缓存数据。

## 6. 安装 systemd 服务

仓库已经提供与 `/var/www/friberg` 和 root 账户匹配的服务文件：

```bash
install -o root -g root -m 0644 /var/www/friberg/deploy/fragle.service /etc/systemd/system/fragle.service
systemctl daemon-reload
systemctl enable --now fragle
systemctl status fragle --no-pager
```

本机健康检查：

```bash
curl --fail http://127.0.0.1:3100/healthz
```

正常返回：

```json
{"ok":true}
```

查看日志：

```bash
journalctl -u fragle -n 100 --no-pager
journalctl -u fragle -f
```

## 7. Nginx 站点配置

创建站点文件：

```bash
nano /etc/nginx/sites-available/your-domain.example.com
```

填入：

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

    # PandaScore 手动同步可能需要数分钟。
    location = /api/admin/sync {
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

这与静态站点的主要区别是 `proxy_pass`。Nginx 不直接读取 HTML，而是把页面和 API 请求都转发给 Node.js。

启用并检查：

```bash
ln -sfn /etc/nginx/sites-available/your-domain.example.com /etc/nginx/sites-enabled/your-domain.example.com
nginx -t
systemctl reload nginx
```

HTTP 检查：

```bash
curl --fail http://your-domain.example.com/healthz
```

如果服务器已有默认站点且访问域名时进入 Nginx 默认页，可以取消默认站点并重新加载：

```bash
unlink /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
```

## 8. 防火墙

先放行 SSH，再启用防火墙：

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
ufw status verbose
```

不要开放公网 3100 端口。Node.js 只监听 `127.0.0.1:3100`。

## 9. HTTPS

先查看服务器已有证书：

```bash
certbot certificates
```

申请并自动修改 Nginx 配置：

```bash
certbot --nginx -d your-domain.example.com --redirect
nginx -t
systemctl reload nginx
```

测试自动续期：

```bash
certbot renew --dry-run
```

`other.example.com`、`another.example.com` 等普通单域名证书不能自动覆盖 `your-domain.example.com`。除非现有证书是包含该域名的多域名证书，或 `*.example.com` 通配符证书，否则必须为 `your-domain.example.com` 单独申请。

Certbot 完成后，可在 HTTPS `server` 块中加入：

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

然后执行：

```bash
nginx -t
systemctl reload nginx
```

## 10. 上线检查

```bash
curl -I http://your-domain.example.com/
curl --fail https://your-domain.example.com/healthz
curl -I https://your-domain.example.com/
systemctl status fragle --no-pager
```

访问地址：

```text
游戏选择  https://your-domain.example.com/
CS2 弗一把  https://your-domain.example.com/play
CS2 推理工具  https://your-domain.example.com/tool
方舟弗一把  https://your-domain.example.com/arknights
方舟干员工具  https://your-domain.example.com/arknights-tool
管理后台  https://your-domain.example.com/admin
状态接口  https://your-domain.example.com/api/status
健康检查  https://your-domain.example.com/healthz
```

## 11. 后续更新

更新包不应包含服务器运行时的 `.env` 和 `data`，避免覆盖管理员修改、同步设置及服务器上的最新选手数据。

本地重新建立发布目录：

```powershell
$stage = Join-Path $env:TEMP "friberg-update"
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

Get-ChildItem -Force | Where-Object {
    $_.Name -notin @(".env", ".git", "data", "node_modules", "friberg-release.zip", "friberg-update.zip")
} | Copy-Item -Destination $stage -Recurse -Force

Compress-Archive -Path "$stage\*" -DestinationPath .\friberg-update.zip -Force
scp .\friberg-update.zip root@服务器IP:/tmp/friberg-update.zip
```

服务器更新：

```bash
cp -a /var/www/friberg /var/www/friberg.backup
systemctl stop fragle
unzip -o /tmp/friberg-update.zip -d /var/www/friberg
chown -R root:root /var/www/friberg
cd /var/www/friberg
/usr/bin/npm test
systemctl start fragle
systemctl status fragle --no-pager
curl --fail http://127.0.0.1:3100/healthz
```

如果更新了 `deploy/fragle.service` 或 Nginx 配置，还要重新安装对应配置并执行 `systemctl daemon-reload` 或 `nginx -t`。

## 12. 常见故障

### systemd 返回 203/EXEC

这表示 `ExecStart` 中的 Node 路径不存在，或被 systemd 的目录保护规则阻止。自动读取当前 root shell 使用的 Node 路径并写入服务文件：

```bash
NODE_BIN="$(readlink -f "$(command -v node)")"
echo "$NODE_BIN"
test -x "$NODE_BIN" || echo "Node 路径不可执行"
sed -i "s|^ExecStart=.*|ExecStart=$NODE_BIN /var/www/friberg/admin-server.mjs|" /etc/systemd/system/fragle.service

case "$NODE_BIN" in
  /root/*) sed -i 's/^ProtectHome=.*/ProtectHome=false/' /etc/systemd/system/fragle.service ;;
esac

systemctl daemon-reload
systemctl reset-failed fragle
systemctl restart fragle
systemctl status fragle --no-pager
```

本服务器的 3100 端口用于 PR弗一把；原有 PRBET 已占用 3000，不要停止或覆盖原服务。确认监听：

```bash
ss -lntp | grep -E ':3000|:3100'
curl --fail http://127.0.0.1:3100/healthz
```

### Nginx 返回 502

```bash
systemctl status fragle --no-pager
journalctl -u fragle -n 100 --no-pager
curl -v http://127.0.0.1:3100/healthz
```

重点检查 `/var/www/friberg/admin-server.mjs` 是否存在、`.env` 是否为有效格式，以及 systemd 的 `ExecStart` 是否指向可执行的 Node 绝对路径。

### Certbot 验证失败

```bash
dig +short your-domain.example.com A
ss -lntp | grep -E ':80|:443|:3100'
ufw status
nginx -t
```

检查 DNS、云服务器安全组、80/443 端口及错误的 AAAA 记录。

### 管理后台同步超时

```bash
nginx -T | grep -A 14 'location = /api/admin/sync'
journalctl -u fragle -f
```

确认生效配置中的 `proxy_read_timeout` 为 `300s`。
