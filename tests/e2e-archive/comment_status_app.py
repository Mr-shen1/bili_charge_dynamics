"""26：原始虚构协议 → Collector → SQLite → 生产 HTTP；控制仅走测试 Unix socket。"""

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
from live_app import FixtureMediaUploader

FIXTURES = Path(__file__).parent / "fixtures"
STATUS_FIXTURES = FIXTURES / "comment-status"


class CommentStatusSource:
    def __init__(self):
        self.calls = []
        self.fail_reply_page = True
        self.blocked = asyncio.Event()
        self.release = asyncio.Event()
        self.roots = json.loads((FIXTURES / "root-comments.json").read_text())
        self.replies = json.loads((FIXTURES / "replies.json").read_text())
        for root in self.roots["data"]["replies"]:
            root["rcount"] = 25 if root["rpid_str"] == "10" else 0
            root["content"]["pictures"] = []

    async def __call__(self, request):
        path, params = request.url.path, dict(request.url.params)
        self.calls.append({"path": path, "params": params})
        if path == "/x/web-interface/card":
            return httpx.Response(200, json={"code": 0, "data": {"card": {
                "mid": "202", "name": "虚构状态作者", "face": "https://example.invalid/avatar.svg",
            }}})
        id = params.get("oid", params.get("id", path.rsplit("/", 1)[-1]))
        assert id in ("9101", "9102", "9105"), "Unexpected fixture target"
        count = 501 if id == "9101" else 0 if id == "9102" else None
        if path == "/x/v2/reply/count":
            document = json.loads((STATUS_FIXTURES / "count.json").read_text())
            document["data"] = {} if count is None else {"count": count}
            return httpx.Response(200, json=document)
        if path == "/x/polymer/web-dynamic/v1/detail":
            document = json.loads((STATUS_FIXTURES / "detail.json").read_text())
            item = document["data"]["item"]
            item["id_str"] = item["basic"]["comment_id_str"] = id
            item["modules"]["module_stat"]["comment"] = {} if count is None else {"count": count}
            return httpx.Response(200, json=document)
        if path.startswith("/opus/"):
            document = (STATUS_FIXTURES / "page.html").read_text().replace('"9101"', json.dumps(id))
            document = document.replace('"count": 501', '"count": ' + json.dumps(count))
            return httpx.Response(200, text=document, headers={"content-type": "text/html"})
        if path in ("/x/v2/reply", "/x/v2/reply/reply"):
            assert params["type"] == "11" and params["ps"] == "20"
            if id == "9105":
                raise httpx.ReadError("FICTIONAL_SECRET_COMMENT_PAGE")
            page = int(params["pn"])
            is_root = path == "/x/v2/reply"
            if not is_root:
                assert id == "9101" and params["root"] == "10"
                if page == 2 and self.fail_reply_page:
                    self.blocked.set()
                    await self.release.wait()
                    raise httpx.ReadError("FICTIONAL_SECRET_REPLY_PAGE")
            document = copy.deepcopy(self.roots if is_root else self.replies)
            items = document["data"]["replies"] if id == "9101" else []
            document["data"]["page"].update(num=page, count=len(items))
            if is_root:
                assert params["sort"] == "0"
                document["data"]["page"]["acount"] = count
                document["data"]["upper"] = None
                document["data"]["hots"] = []
            document["data"]["replies"] = items[(page - 1) * 20:page * 20] or None
            return httpx.Response(200, json=document)
        raise AssertionError("Unexpected upstream route")


def create_app():
    source = CommentStatusSource()
    database = os.environ["BILI_DATABASE_PATH"]
    socket_path = Path(os.environ["FIXTURE_CONTROL_SOCKET"])
    app = production_app(database, profile_transport=httpx.MockTransport(source),
                         media_uploader=FixtureMediaUploader())
    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        async with original_lifespan(application), httpx.AsyncClient(
            transport=httpx.MockTransport(source), trust_env=False
        ) as client:
            collector = Collector(Store(database), client)
            execution = None

            async def command(reader, writer):
                nonlocal execution
                try:
                    action = json.loads(await reader.readline())["action"]
                    if action == "check":
                        for id in ("9101", "9102", "9105"):
                            await collector.check_once("202", id)
                    elif action == "execute-start":
                        assert execution is None
                        execution = asyncio.create_task(collector.execute_pending())
                        await asyncio.wait_for(source.blocked.wait(), 5)
                    elif action == "release-failure":
                        assert execution is not None
                        source.release.set()
                        await execution
                        execution = None
                    elif action == "retry":
                        source.fail_reply_page = False
                        await collector.check_once("202", "9101")
                        await collector.execute_pending()
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
                source.release.set()
                if execution is not None:
                    await execution
                server.close()
                await server.wait_closed()
                socket_path.unlink(missing_ok=True)

    app.router.lifespan_context = lifespan
    return app
