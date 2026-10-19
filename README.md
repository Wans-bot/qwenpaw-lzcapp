# qwenpaw-lzcapp

[QwenPaw](https://github.com/agentscope-ai/QwenPaw) 的懒猫微服打包工程，自动跟随上游发版：
每天检查一次上游镜像，有新版本就中转进 `registry.lazycat.cloud` → 出 LPK → 发 Release → 提交商店审核。

商店应用：`cloud.lazycat.app.qwenpaw`

## 这个仓库做什么

上游 `agentscope-ai/QwenPaw` 在发版时把多架构镜像推到 Docker Hub 与阿里云 ACR，因此这里
**不构建任何镜像**，只做四件事：

1. `pkgscript/upstream.mjs` — 从 GitHub Releases 取最新稳定版号，再去 Docker Hub registry
   逐个探活镜像 tag（`vX.Y.Z` → `X.Y.Z` → `latest`），顺带拿 `Docker-Content-Digest`
   用于识别「同版本号但镜像被重建」的情况。
2. `lzc-cli appstore copy-image` — 服务端把镜像搬进懒猫官方源（商店只接受中转镜像）。
   搬运是懒猫服务端拉取，所以 GitHub runner 不需要能访问 Docker Hub，也不需要 docker。
3. `pkgscript/apply-release.mjs` — 改写 `lzc-manifest.yml` 的 image 行、`package.yml` 的版本号，
   写 `upstream.json` 与更新日志。
4. `lzc-cli project release` 出包 → 发 GitHub Release → `lzc-cli appstore publish` 提审。

## 上游镜像（踩过的坑，别改回去）

| 事实 | 说明 |
| --- | --- |
| Docker Hub tag 带 `v` 前缀 | 是 `agentscope/qwenpaw:v2.2.2`，**不是** `:2.2.2`；写错会得到 `MANIFEST_UNKNOWN` |
| Docker Hub tag 列表接口不可靠 | `hub.docker.com/.../tags` 里查不到 `v2.2.2`，但 registry 上确实存在，所以只能走 registry 探活 |
| 阿里云 ACR 需要鉴权 | `agentscope-registry.ap-southeast-1.cr.aliyuncs.com/...` 匿名访问返回 401，copy-image 用不了 |
| `latest` / `pre` 也在 | 版本化 tag 缺失时脚本退回 `latest`，并在日志里写明 |
| `.postN` 版本要转换 | 上游 `2.0.0.post1` 这类版本，出包时映射成 semver 的 `2.0.0-post.1` |


## 数据目录（升级不能变）

沿用最初 2.2.1 版本的挂载路径，与上游 `docker-compose.yml` 的 volume 名一一对应：

| 容器内 | 设备上 | 内容 |
| --- | --- | --- |
| `/app/working` | `/lzcapp/var/working` | 会话、记忆、技能、配置 |
| `/app/working.secret` | `/lzcapp/var/working.secret` | 密钥与凭据 |
| `/app/working.backups` | `/lzcapp/var/working.backups` | 自动备份 |

改这里等于让老用户升级后看不到自己的历史对话，**不要动**。

## 仓库配置

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| secret | `LZC_API_TOKEN` | 懒猫账号 token（`~/.config/lazycat/box-config.json` 的 `token`），中转镜像 + 提审都要 |
| variable | `SUBMIT_REVIEW` | 设为 `false` 时只发 Release 不提审；默认提审 |
| variable | `UPSTREAM_TRACK` | 设为 `beta` 跟随预发布线；默认 `stable` |
| variable | `UPSTREAM_IMAGE_REPO` | 上游镜像仓库，默认 `agentscope/qwenpaw` |

## 手动操作

```bash
# 跟随最新稳定版跑一次（上游没更新则空跑结束）
gh workflow run lazycat.yml

# 指定版本（上游 tag 已存在但定时任务还没跑到时用）
gh workflow run lazycat.yml -f upstream_version=2.2.2

# 同一版本重出修订包（2.2.2-2），用于修 manifest 而不是换上游版本
gh workflow run lazycat.yml -f upstream_version=2.2.2 -f force=true
```

本地验证出包（不需要任何凭据）：

```bash
mkdir -p dist && lzc-cli project release && lzc-cli lpk info dist/*.lpk
lzc-cli project lint
```

## 提审失败怎么办

`lazycat.yml` 最后一步是提审，它失败时前面的 Release 已经产出，不用重新出包：

```bash
gh workflow run publish.yml -f lpk_version=2.2.2
```

`publish.yml` 会从 Release `v2.2.2` 下载 lpk、按 `SHA256SUMS.txt` 校验，再用当前分支的
`.github/changelog.zh.md` / `changelog.en.md` 提审——所以改更新日志后重跑一次即可，不需要动版本号。

如果商店打回要求改包内容，那才需要 `force=true` 出 `2.2.2-2`。

## 版本号规则

- 首次跟随某上游版本：`2.2.2`
- 同一上游版本重修（镜像 digest 变了，或 `force`）：`2.2.2-2`、`2.2.2-3` …
- 预发布线（`UPSTREAM_TRACK=beta`）：`2.2.2-beta.6` 原样使用
