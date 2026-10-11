# 静态交付与 Nginx 验证（任务 08）

本期是纯静态 SPA：Vite 在本地或 CI 构建，Nginx 只读取 `dist/`，不需要 SSR、常驻 Node.js 应用、模拟 HTTP 服务或服务器代理。部署在域名根路径，非子路径。任务 09 必须对最终集成产物复跑检查，不能直接沿用本票结果。

## 1. 可复现构建

在仓库根目录执行；Node.js `24.21.0`、pnpm `10.34.6`、直接依赖和 lockfile 已固定。使用 nvm 与 pnpm，不在服务器现场解析新依赖。

```bash
source ~/.nvm/nvm.sh
nvm install
nvm use
corepack enable
corepack prepare pnpm@10.34.6 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:e2e:preview
pnpm build
```

发布目录为 `dist/`，不提交仓库；默认无 source map。`pnpm build` 使用正常虚构数据装配；即使 `pnpm build --mode fault` 也不会携带开发故障装配。不提供故障控制面板或公开故障 URL 参数，不调用真实 B站/后端，不需要服务凭据。读取失败与内容不存在由应用分别表达；故障回归使用 `DynamicReader` 可控 Adapter 或独立 `dev:fault`，不得发布故障服务。

`test:e2e:preview` 验证正常构建，不证明 Nginx 的资源错误或缓存规则正确。Nginx 验证入口见第 4 节。

## 2. Nginx 配置与路径契约

示例：[deploy/nginx.conf](../deploy/nginx.conf)。将它作为 `http` 上下文中的 `server` 配置包含；Nginx 主配置必须已加载 `mime.types`，建议 `default_type application/octet-stream`。修改 `root` 为可读的发布目录或 `current` 链接。示例仅监听 `127.0.0.1:4173`，供本机非特权验证；真实部署的监听地址、域名、TLS 和运维权限由维护者另行配置，本票不操作生产环境。

在应用配置生效前检查语法，再按维护者自己的运维流程启用；验证脚本不会 reload 系统 Nginx。

```bash
# 维护者配置好实际主配置路径后：
nginx -t -c /absolute/path/to/nginx.conf
```

| 路径类别 | 实际产物 / 请求例子 | 策略 |
| --- | --- | --- |
| 入口和 SPA 页面 | `/`、`/index.html`、`/dynamics/90071992547409934` | `Cache-Control: no-cache`，使用 ETag/Last-Modified 重新验证；未变可 304 |
| Vite 内容哈希资源 | `/assets/index-<hash>.js`、`.css` | 存在时 `public, max-age=31536000, immutable`；`/assets/` 仅放内容哈希文件 |
| 版本化演示图片 | `/demo-images/landscape-1-thumb.v1.png`、`landscape-1-preview.v1.png` | 存在时长期 immutable；改素材内容必须改版本及 URL，不覆盖同版本 |
| 版本化头像 | `/creator-avatar.v1.svg` | 存在时长期 immutable；新版本须同步增加配置的版本化匹配 |
| 未版本化资源 | `/default-avatar.svg`、`/demo-images/README.md`、该素材目录其他未版本化文件 | `no-cache`，不是一律永久缓存 |
| 明确资源命名空间中的缺失文件 | `/assets/missing.js`、`/assets/no-extension`、`/demo-images/missing.v1.png`、头像缺失路径 | HTTP 404、`no-store`，不会回退为应用入口，也不会套用成功资源的长期缓存 |
| 未知页面、含点号的动态 ID | `/unknown.page`、`/dynamics/id.with.dot` | 返回入口 HTML，再由前端分别显示“未找到页面”或“动态不存在” |

资源靠**命名空间**分类：`/assets/`、`/demo-images/`、`/creator-avatar…`、`/default-avatar…` 明确预留给静态资源；图片版本正则也只在素材命名空间内生效。不得增加“所有带扩展名的 URL 都是资源”的全局正则，也不得用 `error_page 404 /index.html` 掩盖资源错误。添加新的 `public/` 资源目录时，须同步补明确资源规则和验证，而不是让缺失文件进入 SPA 回退。

**SPA 的前端未找到页面不是服务器 HTTP 404。** 未知页面与不存在的动态通常都获得入口 HTTP 200，再由应用区分；读取失败仍有局部错误与重试。这不要求 SSR，也不能用页面显示“未找到”作为资源 404 的证据。

Nginx 默认静态 ETag/Last-Modified 用于重新验证；`no-cache` 不是 `no-store`。长期缓存头只用于成功资源；错误路径单独返回 `no-store`，不要对所有响应无条件添加 immutable。

## 3. 发布更新

1. 在本地/CI 对固定依赖构建并测试，将完整 `dist/` 复制到新发布目录；Nginx 用户只需读取权限。
2. 保留上一版哈希资源：切换入口时，已打开页面仍可能使用旧脚本/样式。可将旧 `assets/` 中不冲突的哈希文件保留在新目录，或使用共享哈希资源目录。已发布同 URL 的内容不得改写；版本化图片也需按仍可访问的旧页面保留。
3. 在同一文件系统用重命名原子切换 `current` 链接，避免逐个覆盖正在提供的入口和资源；不要把 Nginx `open_file_cache` 长时间缓存旧链接（本示例未启用）。核对入口返回新的 HTML、新哈希资源可读、旧哈希资源仍可读。
4. 用旧入口 ETag 重新请求：更新后应得到 200 新入口，而不是旧 304；浏览器刷新有效详情仍可导航和看图。未变化的资源允许继续使用缓存。不要依赖强制刷新绕过缓存来掩盖错误策略。

本票脚本在临时源码副本中改变入口标题和一个执行标记，再实际构建 B、保留 A 的哈希资源并原子切换；不改真实源文件、`dist/` 的发布版本或真实部署目录。此演练验证交付机制，不等于提供自动发布平台或实施生产更新。

## 4. 可执行 Nginx 验证

需要本地可执行的 Nginx、与其匹配的 `mime.types`、Playwright Chromium 和空闲的 `127.0.0.1:4173`。以非 root 用户运行，不需要系统服务、Docker、云账号或凭据。

```bash
source ~/.nvm/nvm.sh
nvm use
pnpm exec playwright install chromium
NGINX_BIN=/absolute/path/to/nginx \
NGINX_MIME_TYPES=/absolute/path/to/mime.types \
pnpm test:delivery

# 只跑静态交付专项（仍包含构建可复现、fault 构建隔离和更新演练）：
NGINX_BIN=/absolute/path/to/nginx \
NGINX_MIME_TYPES=/absolute/path/to/mime.types \
pnpm test:delivery tests/e2e/static-delivery.spec.ts
```

系统已有 Nginx 时也可用 `NGINX_BIN=nginx NGINX_MIME_TYPES=/etc/nginx/mime.types`。脚本先检查端口空闲并构建；生成临时主配置，**直接包含交付示例**，只替换 root；验证配置、启动独立 Nginx、执行全部正常浏览器回归（桌面 Chromium / Pixel 7 模拟视口，不启动 Vite）、再核对相同输入重建和 `--mode fault` 的入口/bundle 字节一致，最后实际构建更新并验证条件请求和浏览器刷新。正常结束或测试失败均退出临时 Nginx、删除临时目录；若被系统强制终止，需自行清理残留临时进程/目录。

没有现成 Nginx、但已有编译器/make/PCRE2/zlib 时，可按以下方式在用户临时目录复现本票环境；不运行 `make install`，不修改系统设施。源码下载/编译失败应记录为环境限制，不能替换成 Vite 验收。

```bash
scratch=$(mktemp -d)
curl --fail --location --proto '=https' \
  https://nginx.org/download/nginx-1.28.0.tar.gz -o "$scratch/nginx.tar.gz"
tar -xzf "$scratch/nginx.tar.gz" -C "$scratch"
(cd "$scratch/nginx-1.28.0" && ./configure --prefix="$scratch/runtime" && make -j2)
NGINX_BIN="$scratch/nginx-1.28.0/objs/nginx" \
NGINX_MIME_TYPES="$scratch/nginx-1.28.0/conf/mime.types" \
pnpm test:delivery
# 全部测试结束后可删除源码/编译目录：
rm -r "$scratch"
```

专项从 HTTP/浏览器公开边界验证：

- 有效详情直达、刷新、看图和返回；未知页面/含点号 ID 的前端状态与入口 HTTP 200。
- 缺失脚本、样式、版本化/未版本化图片、无扩展名资源均 HTTP 404 + `no-store`，响应不是入口。
- 实际入口引用的 JS/CSS MIME 和缓存；版本图片、未版本化头像/素材目录文件的缓存；入口 ETag/修改时间 304。
- 既有图片测试在正常 Nginx 产物上验证缩略图懒加载、完整图片 URL（含参数）和仅当前预览请求；既有导航/历史回归也在同一产物执行。
- 相同输入重建、故障构建模式仍是正常装配、一次真实构建更新后的新入口/新资源/旧资源和浏览器执行。

手工诊断可在维护者启动的实际站点执行（自动脚本结束后本机 4173 不再提供服务）：

```bash
origin=http://127.0.0.1:4173
curl -i "$origin/dynamics/90071992547409934"
curl -i "$origin/unknown.page"
curl -i "$origin/assets/missing.js"
curl -i "$origin/assets/missing.css"
curl -i "$origin/demo-images/missing.v1.png"
curl -I "$origin/"
curl -I "$origin/default-avatar.svg"
curl -I "$origin/demo-images/landscape-1-thumb.v1.png"
# 先从入口取得实际 JS/CSS 路径，再对它们执行 curl -I；不要固定旧哈希。
# 用上一次入口的实际 ETag 替换占位值：
curl -i -H 'If-None-Match: "previous-entry-etag"' "$origin/"
```

记录 Nginx 版本、实际配置、环境和每项结果；环境不可用时保持对应验收项未勾选。执行证据见 [08 验收记录](../.scratch/dynamics-viewer/acceptance-08.md)。

### 4.1 真实局域网 HTTP 回归与真机续验准备

`127.0.0.1` / `localhost` 属于浏览器可信上下文：上面的本机 Nginx 回归不能证明普通 HTTP 的 Web Crypto 能力。应用站点不以 HTTPS 为启动前提；会话、访问、预览标识优先沿用 `crypto.randomUUID`，不可用时由 `crypto.getRandomValues` 生成 UUID v4，不退化到 `Math.random`，也不作为授权凭证。这不意味着生产 HTTP 安全性与 HTTPS 等价。

在同一可信局域网另起**独立临时 Nginx**，仅监听机器实际的私有 IPv4 和空闲非特权端口，例如 `192.168.8.20:4180`；不要改系统 Nginx、防火墙或开启公网转发。主配置包含匹配的 `mime.types` 与示例 server，替换 `listen`、`root`，可用 `allow 192.168.8.0/24; deny all;` 进一步限制访问。IP/网段必须以实际环境为准。只提供重新构建的正常 `dist/`，不能继续使用修复前固定副本，也不能发布 `dev:fault`。

```bash
pnpm build
# 按第3节更新该临时站点的发布副本，再启动/检查独立 Nginx。
# 下列 URL 替换为实际监听的私有 IPv4；不能填 localhost 或回环别名。
HTTP_ACCEPTANCE_URL=http://192.168.8.20:4180/ pnpm test:http
```

脚本要求 HTTP、真实私有 IPv4 和 Nginx 响应；通过实际 Chromium 页面断言 `isSecureContext === false`、`randomUUID` 不可用而 `getRandomValues` 可用，检查启动错误、四类标识的 UUID v4 格式、列表追加→详情→预览→关闭/前进/后退→列表恢复和刷新重置。不 mock crypto、不伪造安全上下文，也不使用浏览器安全豁免。它不负责启动或更新外部站点，必须与全量 `test:delivery` 一起执行；两者各自覆盖普通 HTTP 与资源/缓存/构建更新风险，不能互相替代。

自动化通过后保持该正常站点运行，向验收者提供 URL、构建哈希和独立 Nginx 停止命令，在实际 Linux 品牌浏览器、iPhone、iPad、Android 上续验。无 Mac 时桌面 Safari 仍为未验证；Chromium 模拟不能代替品牌浏览器、iOS Safari 或 Android 真机。临时地址、配置与续验范围见 [09 验收记录](../.scratch/dynamics-viewer/acceptance-09.md)。

## 5. 素材与范围边界

本期 PNG/SVG 为项目内自绘素材，来源与重建见 [素材说明](../public/demo-images/README.md)。浏览器按模型给定的 URL 请求，不依赖 B站外链、不改写图片参数。后续 OSS 由浏览器直连给定的 HTTPS URL；域名、CORS、权限、签名有效期和缓存需另行评估，本票不加应用服务器代理，不配置 OSS/CDN/云平台。

2 核 2GB 是静态站点的目标配置，**不是容量保证**；未采购、部署或压测真实服务器。后端、数据库、爬虫和总体资源占用仍需独立评估。TLS、生产权限/安全加固、发布自动化、真实 Android/iOS/Safari 及跨设备收口属于后续工作或任务 09，本票不声称这些已经验证。

参考：[Nginx location/try_files/ETag](https://nginx.org/en/docs/http/ngx_http_core_module.html)、[缓存头规则](https://nginx.org/en/docs/http/ngx_http_headers_module.html)、[编译选项](https://nginx.org/en/docs/configure.html)。
