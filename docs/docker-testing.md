# 网页部署验收

测试分为服务接口、持久化和浏览器操作。首页返回成功或容器显示 `healthy`，都不能替代账号及酷安功能验证。

当前飞牛入口为 `https://coolapk.example.com:88/`，安装目录为 `/volume1/docker/coolapk-docker`，NAS 端口为 `18966`。应用访问密码读取安装目录 `.env` 中的 `COOLAPK_ACCESS_PASSWORD`。真实酷安 Cookie 尚未导入和测试，由用户后续自行导入；以下账号项目列的是验收要求。

## 服务接口冒烟

`scripts/web-smoke.py` 仅使用 Python 标准库。可在飞牛终端对容器公开端口运行，也可在本机对 Lucky 地址运行：

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

人工验收时另外导入一个真实账号，保存布局设置，然后重启和重新创建容器，再打开网页确认账号、当前账号和设置恢复。这里需要有效的真实 Cookie，测试脚本不会生成或伪造账号登录。

## 浏览器验收

| 检查 | 要求 |
| --- | --- |
| 访问认证 | 首次设置密码，刷新后保持登录；退出后业务 API 不可访问 |
| 原生界面 | 原桌面应用的 Vue 页面直接显示，没有远程桌面窗口 |
| 宽屏布局 | 常用桌面分辨率保持组件尺寸，2K/4K 内容居中 |
| 导航 | 信息流进入详情、浏览器后退、页面刷新、详情直达正常 |
| 匿名阅读 | 信息流、搜索、帖子、用户信息和媒体可实际加载 |
| 账号状态 | 有效 Cookie 导入、校验、切换及失效提示清晰 |
| 已登录操作 | 在授权测试账号上检查点赞、收藏、评论、消息等对应功能 |
| 媒体下载 | 图片和视频加载；视频拖动的 Range 请求正常 |
| 数据目录 | 状态文件落到安装目录的 `data/`，文件可写且重建后保留 |
| 日志 | 不输出原始 Cookie、访问密码、认证令牌或私信正文 |

不具备真实账号时，应明确记录“账号业务操作尚未验证”，不能从匿名浏览通过推断已登录功能通过。官方接口拒绝、账号过期和适配代码错误应分别记录。
