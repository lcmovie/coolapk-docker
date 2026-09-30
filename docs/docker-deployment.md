# 飞牛 NAS 的 Docker 网页版

这是原生网页：Vue 直接在浏览器中渲染，Rust HTTP 服务负责酷安接口、账号和存储。容器不启动 Linux 桌面、VNC 或 Tauri 窗口。网页与 API 使用同一地址，原桌面版继续使用自己的 Tauri 适配层。

## 安装目录和访问链路

本次飞牛测试的完整项目目录为：

```text
/volume1/docker/coolapk-docker/
├── Dockerfile
├── compose.yaml
├── package.json、src/、web-server/ 等项目文件
├── .env                  # 本机部署配置，禁止提交
└── data/                 # 唯一持久化数据目录，禁止提交
```

当前部署映射 `18966:8080`：容器监听 `8080`，飞牛发布端口 `18966`。

```text
https://coolapk.example.com:88 → Lucky → http://198.51.100.10:18966 → 容器
```

当前远程入口为 [酷安网页版](https://coolapk.example.com:88/)。本机与飞牛不在同一局域网，浏览器通过 Lucky 的公开 HTTPS 地址访问。

## 打开当前实例

在网页输入应用访问密码。密码保存在 NAS 安装目录 `/volume1/docker/coolapk-docker/.env` 的 `COOLAPK_ACCESS_PASSWORD` 中；这是网页访问密码，与酷安账号 Cookie 分开管理。验证后浏览器保存访问会话，日常打开网页可继续使用。

酷安 Cookie 由用户在网页登录界面自行导入。本轮测试没有代用户导入真实 Cookie，账号登录、切换以及点赞、评论、收藏、私信等已登录业务尚未作为验收项测试。

公开浏览也可能被酷安要求进行人工验证。出现官方验证码弹窗时由用户手动完成；关闭或加载失败时页面给出错误提示，可以重试。

## Docker Compose 启动

下面是首次安装步骤，在飞牛 SSH 终端执行。将完整源代码放到安装目录，保留已有 `.env` 配置。

```bash
cd /volume1/docker/coolapk-docker
cp --no-clobber .env.example .env
install -d -m 0700 -o 1000 -g 1000 data
chmod 600 .env
```

编辑 `.env`：

```dotenv
COOLAPK_BIND_IP=0.0.0.0
COOLAPK_HOST_PORT=18966
COOLAPK_PUBLIC_ORIGIN=https://coolapk.example.com:88
COOLAPK_ACCESS_PASSWORD=
```

`COOLAPK_PUBLIC_ORIGIN` 填写实际使用的完整 origin，包含协议、域名和端口，不包含路径。首次安装时为 `COOLAPK_ACCESS_PASSWORD` 填入至少 10 个字符、最多 72 字节的应用访问密码。新实例也支持留空后在首次访问时设置密码。当前已部署实例使用安装目录 `.env` 中的密码。

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl --fail --silent http://127.0.0.1:18966/healthz
```

健康接口应返回 `{"status":"ok"}`，Compose 应显示 `healthy`。健康检查只确认 HTTP 服务工作，酷安上游接口和账号有效性需要在网页中另行验证。

构建先完成 Vue，再以一个编译任务构建 Rust。运行镜像使用 Debian、TLS 根证书和 HTTP 服务，不安装 GTK/WebKit。首次构建仍需要下载 Node、Rust 镜像及依赖；内存较少的 NAS 应避免同时构建其他项目。当前实际测试目标是 Linux x86_64，其他架构需要独立构建和运行验证。

## Lucky 规则

当前 iStoreOS 的 Lucky 已新增以下 HTTPS Web 反向代理规则，原有 21 条规则保持：

| 字段 | 值 |
| --- | --- |
| 规则备注（Remark） | `coolapk-docker` |
| 前端域名 | `coolapk.example.com` |
| 后端地址 | `http://198.51.100.10:18966` |
| 外部监听 | 使用既有 HTTPS `88` 监听器 |
| TLS | 使用可覆盖该域名的证书 |

保留公开请求的 Host，正确传递 `X-Forwarded-Proto: https`。网站静态资源、API 和媒体均经同一规则。不要缓存 `/api/` 响应，不改写认证 Cookie。HTTP 服务不需要直接公开到互联网，访问入口统一通过 Lucky。

## 数据持久化

Compose 使用 `./data:/app/data`，所以账号、Cookie、会话、设置、本地状态以及下载等服务端数据都位于安装目录的 `data/`。网页的浏览器缓存不承担唯一存储职责。

容器以 UID/GID `1000:1000` 运行，安装目录中的 `data/` 必须允许该用户写入。不要把持久化数据写进镜像或仅保存在容器内部。`.env`、`data/` 和备份均被 Docker 构建上下文排除。

已保存的 Cookie 在容器重启和重新创建后继续保留。酷安可能使 Cookie 过期或撤销登录，数据持久化不会延长官方会话有效期。失效时需要在网页重新导入有效 Cookie。

## 更新、备份和恢复

升级前先停容器，再备份完整 `data/` 和 `.env`，避免备份时状态文件仍在写入。备份可能包含 Cookie，应保存在受控目录，不上传仓库。

```bash
cd /volume1/docker/coolapk-docker
docker compose stop
install -d -m 0700 backups
tar -czf "backups/coolapk-data-$(date +%Y%m%d-%H%M%S).tar.gz" data .env
docker compose up -d --build
```

恢复时停止容器，在该安装目录还原数据和配置，确认 `data/` 的 UID/GID 仍为 `1000:1000`，然后重新启动。回退程序时使用保留的旧镜像和升级前数据备份。直接重新创建容器不会删除宿主机的 `data/`。

```bash
docker compose up -d --force-recreate
```

## 网页与桌面能力

网页复用原桌面版的组件、颜色、字号和卡片布局，宽屏内容居中，窄窗口使用原有响应式行为。浏览器自带前进、后退和刷新。

网页登录采用 Cookie 导入和恢复，桌面 WebView 自动授权窗口不适用于浏览器。桌面窗口按钮、托盘、开机启动、桌面安装更新和打开宿主机目录改为对应的网页行为或说明。保存到 NAS 的下载与导出文件可在网页“NAS 保存的文件”页面下载到当前设备，程序升级使用 Docker Compose。

服务端诊断日志通过 `docker compose logs` 查看。内置第三方网页阅读器仅抓取支持的酷安和媒体域名；其他外链可在浏览器新标签页打开。单次 JSON 请求最大 32MB。当前部署面向个人使用，同一实例的浏览器共享当前酷安账号，可管理并切换多个已保存账号。

相关测试方法见 [docker-testing.md](./docker-testing.md)。
