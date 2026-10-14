"""仅开发本地视觉预览：全部内容虚构，不是真实 B 站／生产归档。

仓库根目录：pnpm build 后，uv run python -m scripts.visual_preview --frontend-dir dist
完整 HTTPS 页面：https://127.0.0.1:18443（首次需接受临时开发证书）
也可不传 --frontend-dir，使用 Vite 开发页面。
HTTP API: http://127.0.0.1:8000（现有 Vite 生产装配代理）；开发证书确认页: https://127.0.0.1:18443
前端 /api 代理指向 HTTP API 即可，Reader / ManagementApi 无需替换。

生产客户端只接受 HTTPS 图片／头像，不能使用明文 HTTP DTO 又保持生产
Adapter 不变。SVG 同时在 HTTP API 下公开，但 DTO 使用第二个本地 HTTPS
监听器；普通浏览器第一次须访问证书确认页接受本次临时自签开发证书。
证书不安装到系统、不读取已有证书或凭据，不访问外网，不调用真实 OSS。
每次启动新建并在正常退出后删除临时 SQLite／SVG／证书目录；无 DB 参数，
忽略 BILI_DATABASE_PATH 和所有 OSS 环境变量，不使用 backend/data。
无周期采集。手动初始化、增删、配置与错误均走生产应用，不伪造 API 成功。
"""

import argparse
import asyncio
from datetime import datetime, timedelta, timezone
from html import escape
import json
from pathlib import Path
import signal
import socket
import subprocess
from tempfile import TemporaryDirectory
import threading

import httpx
import uvicorn
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from backend.bili_monitor.app import create_app as production_app
from backend.bili_monitor.collector import Collector
from backend.bili_monitor.media import ImageDownloader, sync_media
from backend.bili_monitor.storage import Store
from backend.bili_monitor.sync import initialize

NOTICE = "虚构视觉演示 · 非真实 B 站内容 · 非生产归档"
UPS = {"710": "虚构 · 晴川手记", "720": "虚构 · 星河画室", "730": "虚构 · 山海观察员"}
KINDS = ("plain", "long", "single", "four", "nine", "twelve", "tall", "unknown", "pending", "failed")
ORIGIN = "https://i0.hdslb.com/visual-preview/"


def svg(name, width=960, height=720, index=0):
    """固定无外链 SVG：图中也标注虚构，尺寸与实际文件一致。"""
    colors = (("#e9f5ee", "#77b2a3", "#416a72"), ("#fae8e9", "#d8a8b6", "#996b89"),
              ("#edf0fc", "#a1b0de", "#697aa6"), ("#fff0d6", "#d8ba89", "#a68c6b"))
    bg, mid, dark = colors[index % len(colors)]
    label = escape(name)
    if name.startswith("avatar"):
        art = f'<circle cx="{width / 2}" cy="{height * .38}" r="{width * .18}" fill="{dark}"/><ellipse cx="{width / 2}" cy="{height * .98}" rx="{width * .38}" ry="{height * .36}" fill="{mid}"/>'
    else:
        art = f'<circle cx="{width * .77}" cy="{height * .21}" r="{width * .075}" fill="#fff9e9"/><path d="M0 {height * .63} Q{width * .23} {height * .24} {width * .48} {height * .61} T{width} {height * .47} V{height} H0Z" fill="{mid}"/><path d="M0 {height * .8} Q{width * .36} {height * .55} {width * .64} {height * .78} T{width} {height * .69} V{height} H0Z" fill="{dark}"/>'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">'
            f'<rect width="{width}" height="{height}" fill="{bg}"/>{art}'
            f'<text x="24" y="42" fill="{dark}" font-size="22" font-family="sans-serif">FICTIONAL DEMO / 虚构演示</text>'
            f'<text x="24" y="{height - 28}" fill="white" font-size="24" font-family="sans-serif">{label}</text></svg>').encode()


class FictionalSource:
    """只替换外部 HTTP；协议结构依据已跟踪的 e2e live_app fixtures。"""

    def __init__(self, assets, public_base):
        self.assets = assets
        self.public_base = public_base
        self.entries = {}
        self.dimensions = {}
        for index in range(12):
            self.add_asset(f"landscape-{index + 1}.svg", 960, 720, index)
        self.add_asset("tall.svg", 720, 2880, 2)
        self.add_asset("failed.svg", 960, 720, 1)
        for index, uid in enumerate((*UPS, "reader")):
            self.add_asset(f"avatar-{uid}.svg", 240, 240, index)
        for up_index, uid in enumerate(UPS):
            for index, kind in enumerate(KINDS):
                id = f"{uid}{index + 1:03d}"
                self.entries[id] = self.entry(uid, id, kind, up_index * 10 + index)

    def add_asset(self, name, width, height, index):
        self.dimensions[name] = (width, height)
        (self.assets / name).write_bytes(svg(name, width, height, index))

    def author(self, uid):
        return {"mid": uid, "name": UPS.get(uid, f"虚构 · 新增 UP {uid}"),
                "face": f"{self.public_base}/avatar-{uid if uid in UPS else 'reader'}.svg"}

    def pictures(self, kind):
        count = {"single": 1, "four": 4, "nine": 9, "twelve": 12,
                 "tall": 1, "unknown": 1, "pending": 4, "failed": 2}.get(kind, 0)
        results = []
        for index in range(count):
            name = "tall.svg" if kind == "tall" else "failed.svg" if kind == "failed" and index == 0 else f"landscape-{index + 1}.svg"
            width, height = self.dimensions[name]
            results.append({"url": ORIGIN + name,
                            "width": None if kind == "unknown" else width,
                            "height": None if kind == "unknown" else height})
        return results

    def entry(self, uid, id, kind, order=0):
        published = datetime(2026, 4, 18, 12, tzinfo=timezone(timedelta(hours=8))) - timedelta(hours=order * 3)
        text = f"【{NOTICE}】\n今天记录一段安静的日常，给阅读界面留一点呼吸的空间。\n样例 {id} · {kind}"
        if kind == "long":
            text += "\n\n" + "\n".join(f"第 {line:02d} 段：阳光照在窗边，远山、街角和手边的画纸都是虚构视觉素材。长正文用于展开、滚动与返回位置测试 🙂。" for line in range(1, 36))
        return {"uid": uid, "id": id, "kind": kind, "text": text,
                "published": None if kind == "unknown" else int(published.timestamp()),
                "pictures": self.pictures(kind)}

    def get_entry(self, id):
        if id == "799999":
            return None  # 明确无法验证；生产返回 TARGET_UNVERIFIED。
        if id not in self.entries:
            # 新目标规则：UID + 三位非零序号，如新 UID 740 对应 740001。
            uid = id[:-3]
            if not uid or not uid.isascii() or not uid.isdigit() or uid.startswith("0") or id[-3:] == "000":
                return None
            self.entries[id] = self.entry(uid, id, "plain")
        return self.entries[id]

    def comment(self, entry, index, *, root=None, parent=None):
        id = f"{entry['id']}{index:03d}"
        uid = entry["uid"] if index in (1, 102) else "880"
        author = self.author(uid)
        text = ("虚构 UP：感谢大家一起阅读这份本地视觉样例。" if uid == entry["uid"]
                else "虚构读者：喜欢这组颜色，回复与图片均是本地演示素材。")
        if index == 1 and entry["kind"] == "long":
            text += "\n" + "\n".join(f"长评论第 {line} 行：这是虚构评论，用于验证折叠与展开。" for line in range(1, 25))
        pictures = self.pictures("four" if index == 2 else "tall" if index == 3 else "plain")
        return {"rpid_str": id, "root_str": root or "0", "parent_str": parent or "0",
                "oid": entry["id"], "type": 11, "ctime": (entry["published"] or 1776484800) + index * 60,
                "like": 158 - index if index < 100 else 3, "rcount": 5 if index == 1 else 0,
                "member": {"mid": uid, "uname": author["name"], "avatar": author["face"]},
                "content": {"message": "" if index == 3 else text, "pictures": [
                    {"img_src": p["url"], "img_width": p["width"], "img_height": p["height"]} for p in pictures]}}

    def upstream(self, request):
        # 未覆盖路由显式失败；MockTransport 没有任何网络回退。
        path, params = request.url.path, request.url.params
        if request.url.host not in ("api.bilibili.com", "www.bilibili.com"):
            raise httpx.ConnectError("Fictional upstream route unavailable", request=request)
        if path == "/x/web-interface/card":
            uid = params.get("mid", "")
            if uid == "799":
                return httpx.Response(503)
            author = self.author(uid)
            return httpx.Response(200, json={"code": 0, "data": {"card": author}})
        id = params.get("id") if path.endswith("/detail") else params.get("oid") if path.startswith("/x/v2/reply") else path.rsplit("/", 1)[-1]
        entry = self.get_entry(id or "")
        if entry is None or id == "710997":
            raise httpx.ConnectError("Fictional source intentionally unavailable", request=request)
        author = {**self.author(entry["uid"]), "pub_ts": entry["published"]}
        if path.startswith("/opus/"):
            if entry["kind"] == "failed":
                return httpx.Response(503)
            author["pub_time"] = "刚刚" if entry["kind"] == "unknown" else "编辑于 2026年4月18日 12:01"
            paragraphs = [{"para_type": 1, "text": {"nodes": [{"type": "TEXT_NODE_TYPE_WORD", "word": {"words": entry["text"]}}]}},
                          {"para_type": 2, "pic": {"pics": entry["pictures"]}}]
            detail = {"id_str": id, "modules": [
                {"module_type": "MODULE_TYPE_AUTHOR", "module_author": author},
                {"module_type": "MODULE_TYPE_TITLE", "module_title": {"text": f"虚构演示 · {entry['kind']}"}},
                {"module_type": "MODULE_TYPE_CONTENT", "module_content": {"paragraphs": paragraphs}},
                {"module_type": "MODULE_TYPE_STAT", "module_stat": {"comment": {"count": 8}}}]}
            return httpx.Response(200, text='<html><script>window.__INITIAL_STATE__=' + json.dumps({"detail": detail}, ensure_ascii=False).replace("<", "\\u003c") + ';</script></html>', headers={"content-type": "text/html"})
        if path == "/x/polymer/web-dynamic/v1/detail":
            item = {"id_str": id, "basic": {"comment_id_str": id, "comment_type": 11}, "modules": {
                "module_author": author, "module_stat": {"comment": {"count": 8}},
                "module_dynamic": {"major": {"type": "MAJOR_TYPE_OPUS", "opus": {"pics": entry["pictures"]}}}}}
            return httpx.Response(200, json={"code": 0, "data": {"item": item}})
        if path in ("/x/v2/reply", "/x/v2/reply/reply"):
            page = int(params["pn"])
            roots = [self.comment(entry, index) for index in range(1, 4)]
            data = {"page": {"num": page, "size": 20, "count": 3, "acount": 8}}
            if path.endswith("/reply/reply"):
                root = next((r for r in roots if r["rpid_str"] == params["root"]), None)
                if root is None:
                    return httpx.Response(404)
                root_id = root["rpid_str"]
                replies = [self.comment(entry, index, root=root_id,
                                       parent=f"{id}101" if index == 103 else root_id) for index in range(101, 106)]
                data.update(root=root, replies=replies[(page - 1) * 20:page * 20] or None)
                data["page"]["count"] = 5
            else:
                data["replies"] = roots[(page - 1) * 20:page * 20] or None
            return httpx.Response(200, json={"code": 0, "data": data})
        raise httpx.ConnectError("Fictional upstream route unavailable", request=request)

    def download(self, request):
        if not str(request.url).startswith(ORIGIN):
            raise httpx.ConnectError("Fictional media route unavailable", request=request)
        name = request.url.path.rsplit("/", 1)[-1]
        if name not in self.dimensions or name == "failed.svg":
            return httpx.Response(503)
        return httpx.Response(200, content=(self.assets / name).read_bytes(), headers={"content-type": "image/svg+xml"})

    async def upload(self, key, content, content_type):
        # 本地虚构上传边界，无 OSS SDK／环境读取；只接受固定文件的原字节。
        if content_type != "image/svg+xml":
            raise ValueError("Unsupported fixture media")
        for name in self.dimensions:
            if (self.assets / name).read_bytes() == content:
                return f"{self.public_base}/{name}"
        raise ValueError("Unknown fixture media")


class PreviewCheckClock:
    """只供一次 check/execute 的固定时钟；不驱动周期调度。"""

    def now(self):
        return "2026-04-18T08:05:00+00:00"


async def seed(store, source):
    """通过生产初始化保存 30 条正文、根评论及回复，再选择性执行本地媒体。"""
    store.migrate()
    for uid in UPS:
        author = source.author(uid)
        store.add(uid, author["name"], author["face"])
        store.update(uid, "specified", 10, True)
    for id, entry in source.entries.items():
        store.add_target(entry["uid"], id)
    async with httpx.AsyncClient(transport=httpx.MockTransport(source.upstream), trust_env=False) as client, httpx.AsyncClient(
        transport=httpx.MockTransport(source.download), trust_env=False
    ) as media_client:
        downloader = ImageDownloader(media_client)
        for uid in UPS:
            # 不提供 uploader ⇒ 真实 pending，而不是把未上传项伪装成成功。
            await initialize(store, client, uid, downloader, None)
        for id, entry in list(source.entries.items()):
            if entry["kind"] != "pending":
                await sync_media(store, downloader, source, id)
                for root_id in store.media_root_ids(id):
                    await sync_media(store, downloader, source, id, root_id=root_id)
        # 真实 collector 仅运行一轮本地 transport，不起定时器。
        # 新的无图目标实际完成；既有失败图保持 SYNC_INCOMPLETE；上游失败如实保存。
        store.add_target("710", "710998")
        store.add_target("710", "710997")
        source.entries["710998"] = source.entry("710", "710998", "plain", 31)
        collector = Collector(store, client, downloader, source, clock=PreviewCheckClock())
        for id in ("710998", "710997", "710010"):
            await collector.check_once("710", id)
        await collector.execute_pending()
        # pending 样例只检查，不领取，以保留真正尚未执行的图片状态。
        await collector.check_once("710", "710009")
    store.update("720", "recent", 8, True)
    store.update("730", "specified", 12, False)


def landing(api_port, asset_port, database):
    return f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>虚构本地视觉预览</title>
    <body style="font-family:sans-serif;max-width:900px;margin:3rem auto;line-height:1.8">
    <h1>{NOTICE}</h1><p>仅本地开发；所有 UP、动态、评论、图片及来源响应都是虚构素材。生产 API、解析器、SQLite 和错误处理实际运行，但不证明生产真实归档。</p>
    <p><strong>浏览器图片准备：</strong>先打开 <a href="https://127.0.0.1:{asset_port}/">本地 HTTPS 证书确认页</a>并接受这次临时自签证书，再返回前端。不会自动修改系统信任设置。</p>
    <p>API：http://127.0.0.1:{api_port}/api；前端开发代理将 /api 指向这里（仅改运行配置，不替换 Reader 或 ManagementApi）。</p>
    <p>临时数据库：<code>{escape(str(database))}</code>；退出删除，下次启动全新生成。</p>
    <ul><li>UP：710（指定／启用）、720（近期／启用）、730（指定／停用）。</li>
    <li>样例 ID：710001 纯文，710002 长正文，710003 单图，710004 四图，710005 九图，710006 十二图，710007 长图，710008 未知编辑／时间／尺寸，710009 媒体待处理，710010 正文／媒体失败。720、730 使用同样后三位。</li>
    <li>评论：每个样例根 ID = 动态 ID + 001/002/003；001 有五条回复含 UP 身份和回复关系；002 四图，003 纯图长图。</li>
    <li>新增 UID：如 740；对应可验证目标 740001（规则 UID + 三位非零序号）。799 故意资料失败；799999 故意目标无法验证；720001 对 710 返回作者不符。</li>
    <li>检查：710998 实际本地整轮成功；710997 来源失败；710010 实际部分失败；710009 已检查未执行；其他目标未检查。recent 不支持近期发现，无定时器。</li></ul>
    <p><a href="/api/archive/ups">身份 API</a> · <a href="/api/archive/dynamics?limit=10">动态 API</a> · <a href="/api/manage/ups">管理 API</a> · <a href="/api/manage/ups/710/checks">检查 API</a> · <a href="/visual-assets/landscape-1.svg">HTTP SVG</a></p>
    <img src="/visual-assets/landscape-1.svg" alt="虚构本地 SVG" width="320"></body></html>"""


def check_port(port):
    # 只验证回环监听；禁止 0.0.0.0／自定义数据库路径。
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", port))


def main():
    parser = argparse.ArgumentParser(description=NOTICE)
    parser.add_argument("--port", type=int, default=8000, help="Loopback HTTP API port (matches Vite development proxy)")
    parser.add_argument("--asset-port", type=int, default=18443, help="Loopback HTTPS preview port")
    parser.add_argument("--frontend-dir", type=Path, help="Optional production build directory (pnpm build)")
    args = parser.parse_args()
    frontend = args.frontend_dir.resolve() if args.frontend_dir else None
    if frontend and not (frontend / "index.html").is_file():
        parser.error("Build the frontend with pnpm build before using --frontend-dir")
    if not all(1024 <= p <= 65535 for p in (args.port, args.asset_port)) or args.port == args.asset_port:
        parser.error("Ports must be distinct and between 1024 and 65535")
    check_port(args.port)
    check_port(args.asset_port)
    # 强制 /tmp：不采纳可能指向 backend/data 的 TMPDIR／BILI_DATABASE_PATH。
    with TemporaryDirectory(prefix="bili-fictional-visual-", dir="/tmp") as directory:
        root = Path(directory)
        assets = root / "assets"
        assets.mkdir()
        database = root / "preview.sqlite"
        certificate, key = root / "localhost.crt", root / "localhost.key"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-keyout", str(key), "-out", str(certificate), "-subj", "/CN=FICTIONAL-local-preview",
                        "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        key.chmod(0o600)
        source = FictionalSource(assets, f"https://127.0.0.1:{args.asset_port}/visual-assets")
        asyncio.run(seed(Store(database), source))
        def local_app():
            application = production_app(database, profile_transport=httpx.MockTransport(source.upstream),
                                         media_transport=httpx.MockTransport(source.download), media_uploader=source)
            application.mount("/visual-assets", StaticFiles(directory=assets), name="fictional-assets")
            return application

        app, asset_app = local_app(), local_app()
        page = landing(args.port, args.asset_port, database)

        @app.get("/", response_class=HTMLResponse, include_in_schema=False)
        @asset_app.get("/visual-preview", response_class=HTMLResponse, include_in_schema=False)
        async def index():
            return page

        if frontend:
            asset_app.mount("/assets", StaticFiles(directory=frontend / "assets"), name="frontend-assets")

            @asset_app.get("/default-avatar.svg", include_in_schema=False)
            async def default_avatar():
                return FileResponse(frontend / "default-avatar.svg")

            @asset_app.get("/", include_in_schema=False)
            @asset_app.get("/manage", include_in_schema=False)
            @asset_app.get("/ups/{up_id}", include_in_schema=False)
            @asset_app.get("/dynamics/{dynamic_id}", include_in_schema=False)
            async def frontend_index():
                return FileResponse(frontend / "index.html")
        else:
            asset_app.add_api_route("/", index, response_class=HTMLResponse, include_in_schema=False)

        https_server = uvicorn.Server(uvicorn.Config(asset_app, host="127.0.0.1", port=args.asset_port,
                                                   ssl_certfile=str(certificate), ssl_keyfile=str(key), access_log=False))
        thread = threading.Thread(target=https_server.run, name="fictional-svg-https", daemon=True)
        thread.start()
        print(f"\n警告：{NOTICE}\n数据库（退出即删除）：{database}\nHTTP API：http://127.0.0.1:{args.port}/\n先接受临时开发证书：https://127.0.0.1:{args.asset_port}/\n", flush=True)
        # Uvicorn 退出后会向原 handler 重发已捕获的终止信号。原 SIGTERM
        # 默认动作会跳过 TemporaryDirectory 清理；这里先装非终止 handler，
        # 正常运行中的信号仍由 Uvicorn 捕获并进行 graceful shutdown。
        previous_handlers = {s: signal.signal(s, lambda _signum, _frame: None)
                             for s in (signal.SIGINT, signal.SIGTERM)}
        try:
            uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False)
        finally:
            https_server.should_exit = True
            thread.join(timeout=10)
            for signum, handler in previous_handlers.items():
                signal.signal(signum, handler)


if __name__ == "__main__":
    main()
