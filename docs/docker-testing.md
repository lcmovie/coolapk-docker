# 网页部署验收

测试分为服务接口、持久化和浏览器操作。首页返回成功或容器显示 `healthy`，都不能替代账号及酷安功能验证。

当前部署位于 `203.0.113.10`，安装目录 `/opt/coolapk-docker`，服务器端口 `18966`；服务继续运行，Lucky 后端已切换到新机，外网入口为 `https://coolapk.example.com:88/`。应用访问密码读取安装目录 `.env` 中的 `COOLAPK_ACCESS_PASSWORD`。原 NAS 的结果见 [历史记录](./docker-validation-2026-09-30.md)，不能替代新机证据。

用户随后恢复测试并授权真实账号写入。2026-10-01 最终类型检查、生产构建和 `114` 个文件 / `716` 项前端测试通过；完整源码 Docker 构建中 Rust `62` 项通过、`21` 项忽略。已验证真实临时内容的写入、读回与清理，以及新版网页单次发布、升级后访问会话和账号恢复。动态菜单的实际剪贴板值与酷安官方 URL 一致，实际打开官方页面；无可靠 URL 的设置页隐藏对应菜单项。完整结果与未通过、未执行边界见 [完整测试报告](./docker-full-test-2026-10-01.md)。以下仍是可复用的验收方法，不代表所有上游功能均已通过。

NAS 已完成完整备份校验、项目清理及资源复核，本轮未重新部署 NAS，详见 [归档与恢复](./archive-2026-09-30.md) 和 [脱敏清理记录](../archives/fnos-cleanup-verification.json)。

## 服务接口冒烟

`scripts/web-smoke.py` 仅使用 Python 标准库。可在测试服务器终端对容器公开端口运行，也可在本机对切换后的 Lucky 地址运行：

```bash
python3 scripts/web-smoke.py --base-url http://127.0.0.1:18966
```

无密码模式检查：

- 健康接口及返回格式。
- 首页 HTML 和主脚本静态资源。
- 详情深链接的 SPA 回退。
- 认证状态接口格式。
- 匿名调用业务接口被拒绝。

脚本只输出检查名称、结果和 HTTP 状态，不输出响应正文、Cookie 或密码。访问 HTTPS 入口时保持证书校验。

## 容器重新创建后的持久化

准备只供测试读取的应用密码文件，限制为当前用户可读。密码不要作为命令行参数，也不要打印终端环境变量。完成测试后删除测试密码文件。应用的真实账号数据不会被冒烟测试修改。

假设应用密码已存入 `data/.smoke-password`，执行以下命令。脚本写入专用 `settings/web-smoke.json` 存储；`data/.smoke-reference.json` 仅包含用于对照的随机标记，不包含账号数据。设置了 HTTPS 公开地址后，访问会话使用 Secure Cookie，认证和持久化检查需要使用实际的 Lucky HTTPS 地址，不能使用 HTTP localhost。

```bash
python3 scripts/web-smoke.py \
  --base-url https://coolapk.example.com:88 \
  --password-file data/.smoke-password \
  --write-marker --marker-file data/.smoke-reference.json --data-dir data
docker compose up -d --force-recreate
docker compose ps
python3 scripts/web-smoke.py \
  --base-url https://coolapk.example.com:88 \
  --password-file data/.smoke-password \
  --verify-marker --marker-file data/.smoke-reference.json --data-dir data
```

尚未设置应用密码时，可在第一次调用添加 `--configure`，明确授权脚本使用密码文件初始化访问密码。不要在已经有真实数据的实例上随意重新设置密码。测试应同时证明服务端 API 读回相同数据、宿主机 `data/` 中存在对应文件、容器重新创建后仍能读回。运行第二次检查前等待容器恢复 `healthy`。

迁移验收保留已有账号和设置，确认数据文件完整及容器重建后状态恢复；凭据仅做私有存在性检查，不输出原文。真实账号业务验收使用用户已导入的有效 Cookie 和已授权范围，测试脚本不会生成或伪造登录。本轮授权已获得，无需重复询问。

## 浏览器验收

| 检查 | 要求 |
| --- | --- |
| 访问认证 | 首次设置密码，刷新后保持登录；退出后业务 API 不可访问 |
| 原生界面 | 原桌面应用的 Vue 页面直接显示，没有远程桌面窗口 |
| 品牌和关于页 | 所有应用名称为“酷安docker版”，技术栈准确；GitHub 统计显示 0，不获取原仓库统计；联系支持链接统一到 `https://github.com/lcmovie` |
| 当前内容菜单 | 动态等页面复制和打开真实酷安内容 URL；无可靠官方 URL 的页面隐藏对应两个菜单项 |
| 宽屏布局 | 常用桌面分辨率保持组件尺寸，2K/4K 内容居中 |
| 导航 | 信息流进入详情、浏览器后退、页面刷新、详情直达正常 |
| 匿名阅读 | 信息流、搜索、帖子、用户信息和媒体可实际加载 |
| 账号状态 | 有效 Cookie 导入、校验、切换及失效提示清晰 |
| 已登录操作 | 在授权测试账号上检查点赞、收藏、评论、消息等对应功能 |
| 媒体下载 | 图片和视频加载；视频拖动的 Range 请求正常 |
| 数据目录 | 状态文件落到安装目录的 `data/`，文件可写且重建后保留 |
| 日志 | 不输出原始 Cookie、访问密码、认证令牌或私信正文 |
| 迁移清理 | 新机器文件、账号和设置恢复正常，Lucky 目标为新地址；旧 NAS 项目目录、数据、容器和项目镜像均已移除 |

不具备真实账号时，应明确记录“账号业务操作尚未验证”，不能从匿名浏览通过推断已登录功能通过。官方接口拒绝、账号过期和适配代码错误应分别记录。
