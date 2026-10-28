"""08 隔离双进程装配：真实 API／collector、同一临时 SQLite、外部传输账本。

角色：
  `api`（uvicorn）与 `collector`（python -m ... --role collector）都使用生产装配。
  `FAIR_SERIAL_DIR/start.gate` 存在前，所有来源请求等待；测试先启动双方，再放行。
  `ledger.txt` 逐行记录「角色 种类 页码 send|done 时间」，用于证明跨进程串行与页后等待。
"""

import argparse
import asyncio
import json
import os
from pathlib import Path
import signal
import time

import fcntl
import httpx
import requests

from backend.bili_monitor.app import create_app as production_app
from backend.bili_monitor.collector import Collector, open_collector
from backend.bili_monitor.media import ImageDownloader, is_archive_delivery_url
from backend.bili_monitor.reply_pacing import ReplyPagePacer
from backend.bili_monitor.safety import configure_safe_logging
from backend.bili_monitor.source_gate import GatedAsyncTransport, source_request
from backend.bili_monitor.storage import Store
from backend.tests.root_support import root_fixture
from backend.tests.archive_support import readable_html


DIRECTORY = Path(os.environ["FAIR_SERIAL_DIR"]) if os.environ.get("FAIR_SERIAL_DIR") else None
ROLE = os.environ.get("FAIR_SERIAL_ROLE", "api")
UIDS = {"301": "92001", "302": "92002"}
REPLY_PAGES = 30
REPLY_TOTAL = REPLY_PAGES * 20


def ledger(kind, page, phase, oid=""):
    if DIRECTORY is None:
        return
    path = DIRECTORY / "ledger.txt"
    with path.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            handle.write(f"{ROLE} {kind} {page or '-'} {phase} {time.time():.6f} {oid or '-'}\n")
            handle.flush()
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def gate_open():
    return DIRECTORY is not None and (DIRECTORY / "start.gate").exists()


class Source:
    """虚构来源：同一份数据供 HTTPX 与 Requests 两条真实发送路径。"""

    def __init__(self, *, wait_gate=True):
        self.wait_gate = wait_gate
        self.template = json.loads((Path(__file__).parent / "fixtures/replies.json").read_text())[
            "data"]["replies"][0]
        self.root_template = root_fixture()["data"]["replies"][0]

    async def wait(self):
        if self.wait_gate:
            while not gate_open():
                await asyncio.sleep(0.01)

    def root(self, uid, dynamic, root_id):
        root = json.loads(json.dumps(self.root_template))
        root.update(rpid_str=root_id, oid=int(dynamic), type=11, rcount=REPLY_TOTAL)
        root["content"] = {**root.get("content", {}), "pictures": []}
        return root

    def reply(self, dynamic, root_id, number):
        start = (number - 1) * 20
        items = []
        for index in range(20):
            value = start + index + 1
            item = json.loads(json.dumps(self.template))
            item.update(rpid_str=str(960000000000000000 + value), root_str=root_id,
                        parent_str=root_id, oid=int(dynamic), type=11)
            item["content"] = {**item.get("content", {}), "message": f"回复 {value}",
                               "pictures": []}
            items.append(item)
        return items

    def payload(self, request):
        path = request.url.path
        params = dict(request.url.params)
        candidate = (params.get("id") or params.get("oid")
                     or (path.rsplit("/", 1)[-1] if path.startswith("/opus/") else None))
        uid = next((uid for uid, dynamic in UIDS.items() if dynamic == candidate), None)
        dynamic = UIDS.get(uid)
        if path == "/x/web-interface/card":
            return httpx.Response(200, json={"code": 0, "data": {"card": {
                "mid": uid, "name": "虚构公平作者", "face": "https://media.example.invalid/a.png"}}})
        if uid is None:
            raise RuntimeError("Unexpected fixture source request")
        root_id = f"9300{uid[-1]}"
        if path.startswith("/opus/"):
            html = readable_html(id=dynamic, pictures=[]).replace('"count":7', '"count":0')
            return httpx.Response(200, text=html.replace(
                '"mid":"900719925474099312345"', f'"mid":"{uid}"'))
        if path == "/x/polymer/web-dynamic/v1/detail":
            payload = json.loads((Path(__file__).parent / "fixtures/detail.json").read_text())
            item = payload["data"]["item"]
            item["id_str"] = dynamic
            item["modules"]["module_author"]["mid"] = uid
            item["basic"].update(comment_id_str=dynamic, comment_type=11, rid_str=dynamic)
            item["modules"]["module_stat"]["comment"]["count"] = REPLY_TOTAL
            item["modules"]["module_dynamic"]["major"]["opus"]["pics"] = []
            return httpx.Response(200, json=payload)
        if path == "/x/v2/reply/count":
            return httpx.Response(200, json={"code": 0, "data": {"count": REPLY_TOTAL}})
        if path == "/x/v2/reply":
            number = int(params["pn"])
            payload = root_fixture()
            payload["data"]["page"].update(num=number, count=1, acount=REPLY_TOTAL + 1)
            payload["data"]["replies"] = [self.root(uid, dynamic, root_id)] if number == 1 else None
            payload["data"]["hots"] = []
            payload["data"]["upper"] = {"mid": int(uid), "top": None}
            return httpx.Response(200, json=payload)
        if path == "/x/v2/reply/reply":
            number = int(params["pn"])
            items = self.reply(dynamic, root_id, number) if number <= REPLY_PAGES else []
            return httpx.Response(200, json={"code": 0, "data": {
                "page": {"num": number, "size": 20, "count": REPLY_TOTAL},
                "root": self.root(uid, dynamic, root_id), "replies": items}})
        raise RuntimeError("Unexpected fixture source request")


class _Response:
    def __init__(self, response, request):
        self.status_code = response.status_code
        self.content = response.content
        self.headers = dict(response.headers)
        self.url = str(request.url)

    def close(self):
        pass


def install_requests(source):
    def get(session, url, params=None, headers=None, timeout=None, **kwargs):
        request = httpx.Request("GET", url, params=params)
        classified = source_request("GET", request.url)
        kind = classified.endpoint_type if classified is not None else ""
        page = request.url.params.get("pn")
        oid = request.url.params.get("oid", "")
        if kind in ("replies", "root_comments"):
            ledger(kind, page, "send", oid)
        response = source.payload(request)
        if kind in ("replies", "root_comments"):
            ledger(kind, page, "done", oid)
        return _Response(response, request)

    requests.Session.get = get


class Uploader:
    async def upload(self, key, content, content_type):
        url = f"https://media.example.invalid/{key}"
        if not is_archive_delivery_url(url):
            raise RuntimeError("Invalid fixture media URL")
        return url

    async def close(self):
        return None


class FixtureSource(Source):
    async def __call__(self, request):
        if not gate_open() and DIRECTORY is not None:
            (DIRECTORY / "waiting").touch()
        await self.wait()
        classified = source_request(request.method, request.url)
        kind = classified.endpoint_type if classified is not None else ""
        page = request.url.params.get("pn")
        oid = request.url.params.get("oid", "")
        if kind in ("replies", "root_comments"):
            ledger(kind, page, "send", oid)
        response = self.payload(request)
        if kind in ("replies", "root_comments"):
            ledger(kind, page, "done", oid)
        return response


def create_app():
    database = os.environ.get("BILI_DATABASE_PATH")
    if not database:
        raise RuntimeError("BILI_DATABASE_PATH is required")
    source = FixtureSource()
    install_requests(source)

    async def http_send(transport, request):
        return await source(request)

    # 不注入 profile_transport：保留生产默认的 Requests 评论工厂与页后等待，
    # 只在最外层 HTTPX transport 接虚构来源（真实解析与归档代码不变）。
    httpx.AsyncHTTPTransport.handle_async_request = http_send
    return production_app(database, media_transport=httpx.MockTransport(source),
                          media_uploader=Uploader())


async def serve_collector(database):
    global ROLE
    ROLE = "collector"
    configure_safe_logging()
    source = FixtureSource()
    install_requests(source)
    # 等待测试放行后再领取工作，保证 API 手动初始化与 collector 在同一窗口竞争。
    while not gate_open():
        await asyncio.sleep(0.01)
    async with open_collector(database, source_transport=httpx.MockTransport(source),
                              media_transport=httpx.MockTransport(source),
                              media_uploader=Uploader(),
                              reply_page_pacer=ReplyPagePacer()) as collector:
        await collector.execute_pending()


def main():
    parser = argparse.ArgumentParser(description="Isolated fair serial fixture")
    parser.add_argument("--database", required=True)
    parser.add_argument("--role", choices=("collector",), default="collector")
    arguments = parser.parse_args()
    try:
        asyncio.run(serve_collector(arguments.database))
    except KeyboardInterrupt:
        pass
    except Exception:
        raise SystemExit("Fair serial fixture failed") from None


if __name__ == "__main__":
    main()
