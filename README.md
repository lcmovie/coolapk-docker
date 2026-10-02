<p align="center">
  <img src="src/assets/coolapk-logo-rounded.png" width="96" alt="酷安 Logo">
</p>

<h1 align="center">酷安docker版</h1>

<p align="center">基于 Vue 3、TypeScript、Pinia、Vite、Rust / Axum 和 Docker Compose 的第三方酷安 Docker 客户端。</p>

<p align="center">
  <a href="https://github.com/lcmovie/coolapk-docker">项目主页</a>
  <a href="https://github.com/lcmovie/coolapk-docker/issues">反馈与支持</a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker" alt="Docker Compose">
</p>

> [!IMPORTANT]
> 本项目是社区维护的第三方 Docker 客户端，与酷安官方及深圳酷安网络科技有限公司无隶属、授权或合作关系。酷安名称、Logo 和相关商标归其权利人所有。

## 酷安docker版

本分支增加原生网页运行方式：复用桌面版 Vue 界面，由独立 Rust HTTP 服务提供接口和持久化数据，不需要图形桌面或 VNC。桌面版仍使用原有 Tauri 运行方式。

支持通过 `docker compose up -d --build` 构建和部署。账号 Cookie、应用访问会话、设置、历史和下载文件保存在安装目录的 `data/`，容器重新创建后继续保留；Cookie 的有效期仍由酷安决定。

当前版本为 **1.29.0**，同步上游至 `010c26c`，包含图文动态发布与重新编辑，以及 Android 通知、深链、文件保存和安装包入口的源码更新。Docker 网页中的图文题图、正文图片及视频草稿同样保存到安装目录。升级验证见 [1.29.0 测试报告](docs/docker-upgrade-1.29.0-2026-10-02.md)。

项目已迁移到服务器 `203.0.113.10`，安装目录为 `/opt/coolapk-docker`，端口 `18966`，服务继续运行。外网沿用 [酷安docker版](https://coolapk.example.com:88/)，Lucky 目标已切换到新机器。旧 NAS 项目已完成完整备份校验、删除和资源复核，其他服务保持不变。网页访问密码保存在安装目录 `.env` 的 `COOLAPK_ACCESS_PASSWORD` 中。参见 [部署说明](docs/docker-deployment.md)、[验证说明](docs/docker-testing.md) 和 [本轮修复与迁移记录](docs/docker-migration.md)。

酷安 Cookie 由用户在网页自行导入，测试不会展示真实凭据。经用户授权，2026-09-30 至 2026-10-01 已使用现有账号验证动态、点赞、收藏、评论、转发与私密收藏夹，并清理本轮临时内容。1.27.6 历史回归中前端 114 个文件 / 716 项测试通过，Rust 62 项通过、21 项忽略；真实网页单次发布及升级后会话恢复已验证。私信自发和 Live Photo 视频受上游限制，详见 [完整测试报告](docs/docker-full-test-2026-10-01.md)。桌面 WebView 自动授权不适用于浏览器。

## 本地归档

完整工作目录已归档到 `D:\dev\coolapk`，新的 Git 工作仓库已继承原 `feat/docker-web` 历史，以 `main` 继续维护并保留原标签。原历史 bundle、本地源码快照、NAS 完整资料、新机当前资料及实际运行镜像保存在 `archives/private/`；该目录不进入 Git，并使用 Windows ACL 保护。备份含真实部署配置和账号数据，勿公开或提交。归档内容、恢复步骤及已完成的 NAS 清理见 [本地归档与恢复](docs/archive-2026-09-30.md)，脱敏校验记录保存在 `archives/` 根目录。

## 原项目桌面与移动端产物参考

以下为上游原项目的桌面和移动端产物参考，网页安装以 Docker [部署说明](docs/docker-deployment.md) 为准。原项目程序包位于 [上游 GitHub Releases](https://github.com/daimiaopeng/coolapk-desktop/releases)：

| 操作系统 | 文件格式 | 推荐安装包 |
| :--- | :--- | :--- |
| **Windows 安装版** | `.exe` | `coolapk-desktop_x.x.x_x64-setup.exe` (x64) / `arm64-setup.exe` (ARM64) |
| **Windows 单文件版** | `.exe` | `coolapk-desktop_x.x.x_x64-portable.exe` (x64) / `arm64-portable.exe` (ARM64) |
| **macOS** | `.dmg` / `.app` | `coolapk-desktop_x.x.x_aarch64.dmg` (Apple 芯片) / `x64.dmg` (Intel 芯片) |
| **Linux** | `.AppImage` / `.deb` / `.rpm` | `coolapk-desktop_x.x.x_amd64.AppImage` / `.deb` / `.rpm` |
| **Android** | `.apk` / `.aab` | `coolapk-vx.y.z-android-arm64.apk` / `coolapk-vx.y.z-android-arm64.aab` |
| **iPhone / iPad** | `.ipa` | `coolapk-vx.y.z-ios-arm64-unsigned.ipa`（未签名，需自行签名安装） |

> 上述桌面及移动产物由上游维护。本 Docker 仓库提供源码和 Docker 部署方式，未构建或验证上述原生安装包。

## 界面预览

![界面预览 1](docs/screenshots/首页.png)

![界面预览 2](docs/screenshots/2.png)

![界面预览 3](docs/screenshots/3.png)

![界面预览 5](docs/screenshots/5.png)

![界面预览 6](docs/screenshots/6.png)

![界面预览 7](docs/screenshots/7.png)

## 项目来源与支持

感谢原作者 [daimiaopeng](https://github.com/daimiaopeng/coolapk-desktop) 及原项目贡献者。本分支复用原 Vue 界面和 Rust 酷安协议逻辑，增加 Axum HTTP 服务、Docker Compose、服务端持久化和浏览器能力适配。

项目源码、社区统计和 Release 更新来源为 [lcmovie/coolapk-docker](https://github.com/lcmovie/coolapk-docker)，问题反馈见 [本项目 Issues](https://github.com/lcmovie/coolapk-docker/issues)。关于页读取本仓库 GitHub 数据；请求失败显示未知状态。尚无 Release 时明确提示未发布，不将上游桌面安装包作为 Docker 更新。维护者主页为 [lcmovie](https://github.com/lcmovie)。

## 贡献者

[![贡献者](https://contrib.rocks/image?repo=lcmovie/coolapk-docker)](https://github.com/lcmovie/coolapk-docker/graphs/contributors)

## 下载量统计图

[![下载量统计图](https://release-monitor.com/chart/lcmovie/coolapk-docker.svg?stable=5)](https://release-monitor.com/#/lcmovie/coolapk-docker)

## 功能

- **首页信息流**：推荐、热榜、快讯、酷图、二手、数码、评测等频道一应俱全
- **动态浏览**：图文详情、评论楼中楼、热门爆评、点赞、收藏、转发查看，体验顺畅
- **浏览历史**：时间轴轨迹记录，支持动态、用户、话题与应用分类即时筛选及右侧常逛侧边栏
- **关注与粉丝**：双列响应式布局，支持查看已关注酷友及粉丝列表、实时动态与全量自动翻页
- **搜索直达**：全站综合搜索涵盖应用、游戏、用户、话题与动态帖子
- **收藏管理**：集成云端收藏与收藏单合集，支持全屏满幅平铺浏览
- **广场中心**：涵盖话题广场、评测区、应用中心与游戏中心
- **私信聊天**：支持文字与图片消息，支持多账号快速切换
- **账号能力**：Cookie 导入（详见 [手动抓取与导入 Cookie 指南](docs/cookie-guide.md)），多账户保存与一键切账号；桌面授权代码保留在原项目运行方式中
- **个性化与布局**：全屏无边距满幅平铺、深浅色主题、侧边栏折叠与默认启动页设置
- **跨平台**：Windows、macOS、Linux 原生桌面应用，以及 Android、iOS 移动端应用

部分功能依赖酷安服务端接口，可能因官方调整、账号权限或风控策略而临时失效。

## 隐私与网络访问

- 项目不内置个人 Cookie、账号 Token、统计 SDK 或遥测服务。
- 登录凭据由用户手动输入，保存到部署安装目录 `data/accounts/` 的账户库，不写入仓库。
- Docker 服务的设备身份、应用访问会话和设置保存在安装目录 `data/`，容器重新创建后恢复。
- Rust 服务请求酷安 API 和媒体，浏览器通过同源服务访问数据；人工验证码按需加载官方 SDK。
- 请勿在 Issue、日志或截图中提交真实 Cookie、私信和其他个人数据。
- 一键反馈打开本项目 GitHub Issues，不自动给原作者发送私信或上传日志。诊断页面保留上游 PNG/ZIP 日志附件提取能力，分享日志前请自行确认脱敏内容。

部署存储与凭据保护参见 [部署说明](docs/docker-deployment.md) 和 [归档保护说明](docs/archive-2026-09-30.md)。

## 开发环境

- Node.js 22 或更高版本
- Rust stable
- 各平台的 [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)

```bash
git clone https://github.com/lcmovie/coolapk-docker.git
cd coolapk-docker
npm ci
npm run tauri dev
```

生产构建可按当前平台选择产物格式：

```bash
# Windows：构建 NSIS 安装包；原始 release 可执行文件即单文件版
npm run tauri build -- --bundles nsis
./scripts/prepare-windows-portable.ps1 -Architecture x64

# Linux
npm run tauri build -- --bundles appimage,deb,rpm

# macOS
npm run tauri build -- --bundles app,dmg
```

### Android APK

Android 构建需要 JDK 17+、Android SDK、Platform Tools、Build Tools 和 NDK (Side by side)。Windows 下构建脚本会自动读取 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME`，也能识别默认 Android SDK 和本项目使用的 Android OpenJDK 安装位置。

```bash
# 首次生成 Android 工程（生成目录不会提交到 Git）
npm run android:init

# 默认构建 ARM64 debug APK，适用于大多数真机
npm run android:build

# 自定义目标，例如生成全部架构的 debug APK
npm run android:build -- --debug --apk
```

APK 输出到 `src-tauri/gen/android/app/build/outputs/apk/`。连接设备后可用 `adb install -r <apk路径>` 安装。正式分发前还需配置 Android 签名；Google Play 应优先构建并上传 AAB。

上游的 Android 自动发布需要以下签名配置；本 Docker 仓库未启用该流程：

- `ANDROID_KEYSTORE_BASE64`：上传密钥 `.jks` 文件的 Base64 内容
- `ANDROID_KEYSTORE_PASSWORD`：密钥库密码
- `ANDROID_KEY_ALIAS`：密钥别名
- `ANDROID_KEY_PASSWORD`：密钥密码

原生构建产物位于 `src-tauri/target/release/bundle/`。以下为上游支持的产物参考：

- Windows x64：NSIS 安装包 `-setup.exe`、单文件便携版 `x64-portable.exe`
- Windows ARM64：NSIS 安装包 `-setup.exe`、单文件便携版 `arm64-portable.exe`
- Linux x64：AppImage 免安装版 `.AppImage`、Debian 安装包 `.deb`、RPM 安装包 `.rpm`
- macOS Apple 芯片：磁盘映像 `.dmg`、应用包 `.app`
- macOS Intel：磁盘映像 `.dmg`、应用包 `.app`
- Android ARM64：Release APK `.apk`、Google Play 发布包 `.aab`
- iOS ARM64：未签名 IPA `.ipa`（供第三方工具或用户自行签名）

### iOS IPA

iOS 构建必须在 macOS 上完成，并需要完整的 Xcode、CocoaPods 和 Rust iOS 目标。首次构建前，在 macOS 上执行：

```bash
# 安装 CocoaPods（已安装可跳过）
brew install cocoapods

# 安装 Rust iOS 目标
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

# 首次生成 iOS 工程
npm run tauri -- ios init

# 使用 Xcode 打开并调试
npm run tauri -- ios dev --open

# 构建设备版未签名 IPA
npm run tauri -- ios build --target aarch64 --no-sign --ci
```

上游支持生成 ARM64 未签名 IPA。本 Docker 仓库未执行 iOS 构建；未签名 IPA 安装到真机前需要用户自行签名。

## Docker 版本发布

本仓库通过前端检查、Rust 测试、Docker 构建和部署验证后发布版本。Release 与更新提示使用 [本项目 Releases](https://github.com/lcmovie/coolapk-docker/releases)，Docker 更新时保留 `.env` 和 `data/`，重新构建并创建容器。

维护者使用版本脚本同步六个版本文件，完成仓库要求的全部检查后，创建独立版本提交和带注释标签：

```bash
npm run version:set -- 1.2.3
npm run typecheck
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
git commit -m "发布版本 v1.2.3"
git tag -a v1.2.3 -m "发布版本 v1.2.3"
git push origin main v1.2.3
```

网页检查更新仅提示 Docker 版本及部署操作；原生程序包的更新能力保留在桌面代码中，不作为 Docker 升级方式。

## 常用检查

```bash
npm run build
npm audit
cd src-tauri
cargo test
cargo check
```

## 项目结构

```text
src/                         Vue 3 / TypeScript 前端
  api/coolapk.ts             桌面命令与 HTTP 接口适配
web-server/                 Rust / Axum HTTP 服务
Dockerfile、compose.yaml     Docker 镜像和 Compose 部署
  utils/coolapkEmoji.ts      酷安表情映射
src-tauri/                   Rust / Tauri 桌面端
  src/coolapk/auth.rs        Token V3 兼容签名
  src/coolapk/client.rs      API、图片和会话请求
  src/coolapk/commands.rs    Tauri commands
  src/coolapk/api_tests.rs   接口可用性探测测试
docs/screenshots/            界面预览截图
scripts/web-smoke.py         Docker HTTP 冒烟验证
```

## 登录说明

先使用安装目录 `.env` 中配置的应用访问密码打开网页。公开动态、评论和图文可在未登录酷安账号时浏览；酷安仍可能要求人工验证码。

需要账号功能时，在网页右上角登录弹窗导入有效 Cookie。详细提取步骤见 [手动抓取与导入 Cookie 指南](docs/cookie-guide.md)。原桌面 WebView 自动授权窗口不适用于浏览器。

Cookie 保存在部署安装目录 `data/accounts/`，不回传原文给浏览器。Cookie 包含账号操作权限，不能写入代码仓库、公开 Issue、日志或截图；持久化不改变酷安官方有效期。

## 贡献

反馈与支持见 [本项目 Issues](https://github.com/lcmovie/coolapk-docker/issues)。提交前请运行前端构建、Rust 测试，并确保测试数据不包含真实账号、Cookie、设备标识或私信内容。


## 许可证

代码采用 [MIT 许可证](LICENSE)。第三方品牌、Logo、表情及服务端内容不包含在 MIT 授权范围内，详见 [第三方声明](NOTICE.md)。
