# 测试 fixture：真实发行包默认 `nginx.conf`

| 项 | 值 |
| --- | --- |
| 文件 | `nginx-1.30.6-1.conf` |
| 来源归档 | `https://archive.archlinux.org/packages/n/nginx/nginx-1.30.6-1-x86_64.pkg.tar.zst`（**Arch 官方 1.30.6-1**） |
| 归档内成员 | `etc/nginx/nginx.conf`（用 `bsdtar -xOf` 只读提取，未安装） |
| 大小 | 2717 字节 |
| sha256 | `7cd7c15a98e2124a5cbf46e9483072d03e99f647c64d2ae0522c2ff43e1a49b9` |
| 关键事实 | 第 38–39 行有**激活**的 `server { listen 80; }`；`include mime.types;` 在 http 内；**没有** `conf.d/*.conf` include |

## 为什么是 Arch 官方包而不是 CachyOS `-1.1`

本机 CachyOS 候选是 `nginx 1.30.6-1.1`（同一 pkgver 的重建，只改编译目标）。其归档在镜像上取不到（返回 HTML 欢迎页），
因此用**同 pkgver 的 Arch 官方 `1.30.6-1` 归档**取证；`etc/nginx/nginx.conf` 来自同一上游源码 tarball，内容为同版默认值。
**本 fixture 不被标注为 CachyOS 包**；它是 Arch 官方 `1.30.6-1` 的原始文件。

## 使用方式

- `tests/sandbox-safety-tests.sh` 默认从**脚本相对路径**读取本文件（`tests/fixtures/nginx-1.30.6-1.conf`），
  不依赖 `/tmp`；可用 `NGINX_STOCK_FIXTURE` 覆盖，但测试会硬断言 `sha256=7cd7c15a…49b9` 与 2717 字节。
- 测试用 `bsdtar` 现场把它打成“同版本缓存包”（`nginx-<ver>-<arch>.pkg.tar.zst`）来模拟 pacman 缓存，
  验证“pacman 元数据 + 缓存包原文逐字节比对 → 备份 → 受管 main”的完整路径。
- **不要编辑本文件**：字节被测试钉死；真要换版本，必须同时更新测试断言与来源记录。
