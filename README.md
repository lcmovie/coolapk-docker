# 酷安docker版

## 感谢原作者

感谢 [daimiaopeng](https://github.com/daimiaopeng) 开源 [coolapk-desktop](https://github.com/daimiaopeng/coolapk-desktop)，以及原项目贡献者对界面和功能的持续完善。

本项目基于原项目改造，增加原生网页访问、Docker / Docker Compose 部署和服务端数据持久化。保留原作者署名，沿用 [MIT 开源协议](LICENSE)。

## DOME 预览

地址：http://124.223.222.24:18966   密码9iG7YNgRQWeFGDvd
公共预览地址，不建议登录账户，且会定期清理。

## Docker 安装

需要安装 Docker 和 Docker Compose。以下命令以 Linux / NAS 终端为例；数据目录权限命令需要 sudo，使用 root 时可省略 sudo。

### 1. 准备安装目录

```bash
git clone https://github.com/lcmovie/coolapk-docker.git
cd coolapk-docker
cp .env.example .env
sudo install -d -m 0700 -o 1000 -g 1000 data
chmod 600 .env
```

编辑安装目录中的 `.env`：

```dotenv
COOLAPK_BIND_IP=0.0.0.0
COOLAPK_HOST_PORT=18966
COOLAPK_PUBLIC_ORIGIN=
COOLAPK_ACCESS_PASSWORD=
```

- `COOLAPK_HOST_PORT`：网页访问端口，默认 `18966`。
- `COOLAPK_PUBLIC_ORIGIN`：使用反向代理时，填写实际访问的完整地址，例如 `https://coolapk.example.com`；有端口时一并填写，不包含路径。直接访问时可以留空。
- `COOLAPK_ACCESS_PASSWORD`：应用访问密码，可预先填写至少 10 个字符的密码；留空时在首次打开网页后设置。它与酷安账号 Cookie 分开管理。

### 2. 启动服务

两种安装方式任选一种。

**方式一：使用已发布的离线镜像**

当前离线镜像适用于 **Linux amd64 / x86_64**。在安装目录下载 [v1.29.0 Release](https://github.com/lcmovie/coolapk-docker/releases/tag/v1.29.0) 中的镜像和校验文件：

```bash
curl -fLO https://github.com/lcmovie/coolapk-docker/releases/download/v1.29.0/coolapk-docker-1.29.0-linux-amd64.tar.gz
curl -fLO https://github.com/lcmovie/coolapk-docker/releases/download/v1.29.0/SHA256SUMS
sha256sum -c SHA256SUMS
gzip -dc coolapk-docker-1.29.0-linux-amd64.tar.gz | docker load
docker tag coolapk-docker:1.29.0 coolapk-docker:local
docker compose up -d --no-build
```

**方式二：从源码构建**

```bash
docker compose up -d --build
```

启动后查看状态：

```bash
docker compose ps
docker compose logs --tail=100
```

浏览器打开 `http://你的服务器IP:18966`，或已经配置的反向代理地址。输入应用访问密码后即可打开网页；需要账号功能时，在网页登录窗口导入有效酷安 Cookie，提取方法见 [Cookie 导入指南](docs/cookie-guide.md)。

### 3. 数据保存与更新

容器使用 `./data:/app/data` 挂载，账号 Cookie、访问会话、设置、历史、草稿、缓存及下载文件保存在安装目录的 `data/` 中。重启或重新创建容器后可以继续使用；Cookie 失效时需要重新导入。

更新前备份 `.env` 和完整 `data/`，更新时保留这两项。

源码安装可在安装目录执行：

```bash
git pull --ff-only
docker compose up -d --build
```

离线镜像安装则从 [本项目 Releases](https://github.com/lcmovie/coolapk-docker/releases) 下载新版本，校验并载入镜像，将新镜像标记为 `coolapk-docker:local`，再执行 `docker compose up -d --no-build`。

## 功能介绍

- **原生网页访问**：直接在浏览器使用，沿用原桌面版的界面布局、字号和卡片样式；宽屏内容居中，窄窗口适配显示。
- **内容浏览**：查看首页信息流、数码、发现、话题、酷图，以及应用和游戏内容。
- **全站搜索**：搜索应用、游戏、动态、用户和话题。
- **动态与评论**：查看图文详情、热门评论、楼中楼回复及互动记录。
- **账号互动**：点赞、评论、收藏、转发、关注，管理关注列表和粉丝列表。
- **内容发布**：发布普通动态和图文文章，支持图文标题、题图、正文图片及重新编辑；草稿保存到安装目录。
- **收藏管理**：查看和管理收藏、收藏单及合集。
- **通知与私信**：查看回复、提及和私信，支持文字及图片消息。
- **多账号管理**：导入、保存和切换多个酷安账号，打开网页后恢复已保存的账号状态。
- **下载与导出**：管理应用下载任务，在网页查看已保存文件并下载到当前设备，支持浏览历史 JSON 导出。
- **浏览历史**：记录浏览轨迹，按动态、用户、话题和应用筛选。
- **外观设置**：切换深浅色主题，调整界面显示、侧边栏及启动页面。

账号互动需要有效酷安 Cookie；具体功能可用性受酷安接口、账号权限和会话状态影响。
