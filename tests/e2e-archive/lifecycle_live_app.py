"""30 组合装配：仅替换外部 HTTP/OSS，经公开 Collector 执行，控制不进入产品 API。"""

import asyncio
import copy
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx

from backend.bili_monitor.app import create_app as production_app
from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from comment_status_app import CommentStatusSource, STATUS_FIXTURES
from live_app import FIXTURES, MEDIA_BYTES, MEDIA_SOURCE, FixtureMediaUploader


UPDATED_SOURCE = "https://i0.hdslb.com/e2e-media/updated.svg"
UPDATED_BYTES = MEDIA_BYTES.replace(b'<svg ', b'<svg data-fixture="updated" ')


class FixtureClock:
    def __init__(self):
        self.value = os.environ.get("FIXTURE_CLOCK", "2026-10-09T05:10:00+00:00")

    def now(self):
        return self.value


class LifecycleUploader(FixtureMediaUploader):
    def __init__(self):
        self.fail_updated = True
        self.blocked = asyncio.Event()
        self.release = asyncio.Event()

    async def upload(self, key, content, content_type):
        if content == UPDATED_BYTES:
            assert content_type == "image/svg+xml"
            if self.fail_updated:
                self.blocked.set()
                await self.release.wait()
                raise RuntimeError("FICTIONAL_SECRET_LIFECYCLE_UPLOAD_FAILURE")
            return f"https://archive-media.example.invalid/objects/{key}.svg"
        return await super().upload(key, content, content_type)


class LifecycleSource(CommentStatusSource):
    def __init__(self):
        super().__init__()
        self.fail_reply_page = False
        self.version = 1
        for root in self.roots["data"]["replies"]:
            if root["rpid_str"] in ("45", "44"):
                root["content"] = {"message": "", "pictures": [
                    {"img_src": MEDIA_SOURCE, "img_width": 80, "img_height": 120}
                ]}
        if os.environ.get("FIXTURE_VERSION") == "2":
            self.advance()

    def advance(self):
        assert self.version == 1
        self.version = 2
        for root in self.roots["data"]["replies"]:
            if root["rpid_str"] == "45":
                root["content"]["pictures"].append(
                    {"img_src": UPDATED_SOURCE, "img_width": 80, "img_height": 120})
            if root["rpid_str"] == "10":
                root["rcount"] = 26
        root = copy.deepcopy(self.roots["data"]["replies"][0])
        root.update(rpid_str="46", like=100, rcount=0)
        root["content"] = {"message": "计数变化新增评论", "pictures": []}
        self.roots["data"]["replies"].append(root)
        reply = copy.deepcopy(self.replies["data"]["replies"][0])
        reply.update(rpid_str="126", ctime=1791513600)
        reply["content"] = {"message": "计数变化新增回复"}
        self.replies["data"]["replies"].append(reply)

    async def __call__(self, request):
        if os.environ.get("FIXTURE_OFFLINE") == "1":
            self.calls.append({"path": request.url.path, "params": dict(request.url.params)})
            raise httpx.ConnectError("FICTIONAL_SECRET_OFFLINE", request=request)
        path = request.url.path
        if path == "/x/v2/reply/count":
            self.calls.append({"path": path, "params": dict(request.url.params)})
            document = json.loads((STATUS_FIXTURES / "count.json").read_text())
            document["data"]["count"] = 501 if self.version == 1 else 502
            return httpx.Response(200, json=document)
        if path == "/x/web-interface/card" or path.startswith("/opus/") or path.endswith("/detail"):
            self.calls.append({"path": path, "params": dict(request.url.params)})
            if path == "/x/web-interface/card":
                return httpx.Response(200, json={"code": 0, "data": {"card": {
                    "mid": "202", "name": "虚构生命周期作者", "face": "https://example.invalid/avatar.svg",
                }}})
            document = (FIXTURES / ("edited.html" if path.startswith("/opus/") else "normal.json")).read_text()
            pictures = [{"url": MEDIA_SOURCE, "width": 800, "height": 1200}]
            if self.version == 2:
                pictures.append({"url": UPDATED_SOURCE, "width": 80, "height": 120})
                document = document.replace("13:01", "13:02")
                document = document.replace("虚构首次归档正文", "可信编辑后的生命周期正文")
            document = document.replace(
                '{"url":"https://example.invalid/source-business.jpg","width":800,"height":1200}',
                ",".join(json.dumps(picture) for picture in pictures))
            document = document.replace('"count":7', '"count":501' if self.version == 1 else '"count":502')
            long_text = "\n".join(f"生命周期归档正文第 {line} 行 🙂" for line in range(1, 21))
            document = document.replace("第七行以后的全文也应可读。", json.dumps(long_text, ensure_ascii=False)[1:-1])
            return httpx.Response(200, text=document, headers={
                "content-type": "text/html" if path.startswith("/opus/") else "application/json",
            })
        return await super().__call__(request)


def create_app():
    source = LifecycleSource()
    uploader = LifecycleUploader()
    clock = FixtureClock()
    database = os.environ["BILI_DATABASE_PATH"]
    socket_path = Path(os.environ["FIXTURE_CONTROL_SOCKET"])

    def download(request):
        assert str(request.url) in (MEDIA_SOURCE, UPDATED_SOURCE), "Unexpected fixture media"
        content = MEDIA_BYTES if str(request.url) == MEDIA_SOURCE else UPDATED_BYTES
        return httpx.Response(200, content=content, headers={"content-type": "image/svg+xml"})

    app = production_app(database, profile_transport=httpx.MockTransport(source),
                         media_transport=httpx.MockTransport(download), media_uploader=uploader)
    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        async with original_lifespan(application):
            collector = Collector(Store(database), application.state.profiles,
                                  application.state.downloader, uploader, clock=clock)
            execution = None

            async def command(reader, writer):
                nonlocal execution
                try:
                    action = json.loads(await reader.readline())["action"]
                    if action == "check":
                        await collector.check_once("202", "9101")
                    elif action == "retry":
                        uploader.fail_updated = False
                        await collector.check_once("202", "9101")
                        await collector.execute_pending()
                    elif action == "execute-start":
                        assert execution is None
                        source.advance()
                        uploader.fail_updated = True
                        clock.value = "2026-10-09T05:11:00+00:00"
                        await collector.check_once("202", "9101")
                        execution = asyncio.create_task(collector.execute_pending())
                        await asyncio.wait_for(uploader.blocked.wait(), 5)
                    elif action == "release-failure":
                        assert execution is not None
                        uploader.release.set()
                        await execution
                        execution = None
                    elif action != "calls":
                        raise ValueError("Unknown fixture action")
                    result = {"ok": True, "calls": source.calls}
                except Exception:
                    result = {"ok": False, "error": "Fixture command failed"}
                writer.write((json.dumps(result) + "\n").encode())
                await writer.drain()
                writer.close()
                await writer.wait_closed()

            socket_path.unlink(missing_ok=True)
            server = await asyncio.start_unix_server(command, path=socket_path)
            try:
                yield
            finally:
                uploader.release.set()
                if execution is not None:
                    await execution
                server.close()
                await server.wait_closed()
                socket_path.unlink(missing_ok=True)

    app.router.lifespan_context = lifespan
    return app
