"""03 隔离双进程装配：生产 API／采集入口与真实 SQLite，只替换外部来源。

API 进程（父测试用同一个临时库启动它）：
  RISK_FIXTURE_ROLE=api RISK_FIXTURE_DIR=<dir> BILI_DATABASE_PATH=<db> \
  uv run uvicorn backend.tests.risk_fixture:create_app --factory --host 127.0.0.1 --port <free>
采集进程：
  RISK_FIXTURE_ROLE=collector RISK_FIXTURE_DIR=<dir> BILI_DATABASE_PATH=<db> \
  uv run python -m backend.tests.risk_fixture --database <db>

控制文件（`RISK_FIXTURE_DIR`）：
  `risk.arm` 存在时，仅 API 角色的动态网页请求返回 HTTP 412（采集角色不受影响），
  便于证明「一进程触发、另一进程停止发送」而不是来源停止响应。
  `ledger.txt` 记录每次真实来源发送「角色 + 接口类型」，用它证明没有绕过许可的请求。
"""

import argparse
import asyncio
import json
import os
from pathlib import Path
import signal

import httpx

from backend.bili_monitor.app import create_app as production_app
from backend.bili_monitor.collector import Collector
from backend.bili_monitor.media import ImageDownloader
from backend.bili_monitor.risk import RiskGate
from backend.bili_monitor.safety import configure_safe_logging
from backend.bili_monitor.source_gate import GatedAsyncTransport, source_request
from backend.bili_monitor.storage import Store
from backend.tests.deployment_fixture import DYNAMIC_ID, UID, detail_json, page_html


ROLE = os.environ.get("RISK_FIXTURE_ROLE", "api")
DIRECTORY = Path(os.environ["RISK_FIXTURE_DIR"]) if os.environ.get("RISK_FIXTURE_DIR") else None


def ledger(kind):
    if DIRECTORY is None:
        return
    # 单次 write 追加；两个进程共用同一账本文件。
    with (DIRECTORY / "ledger.txt").open("a") as handle:
        handle.write(f"{ROLE} {kind}\n")


def armed():
    return ROLE == "api" and DIRECTORY is not None and (DIRECTORY / "risk.arm").exists()


class Source:
    """虚构来源：接口形状取自已版本化样本；不访问真实 B 站。"""

    async def __call__(self, request):
        if request.method != "GET":
            raise RuntimeError("Unexpected fixture request")
        classified = source_request(request.method, request.url)
        if classified is not None:
            ledger(classified.endpoint_type)
        if armed() and request.url.host == "www.bilibili.com" and request.url.path.startswith("/opus/"):
            return httpx.Response(412, text="")
        if request.url.host == "api.bilibili.com" and request.url.path == "/x/web-interface/card":
            return httpx.Response(200, json={"code": 0, "data": {"card": {
                "mid": UID, "name": "虚构风控作者", "face": "https://media.example.invalid/avatar.png",
            }}})
        if request.url.host == "www.bilibili.com" and request.url.path == f"/opus/{DYNAMIC_ID}":
            return httpx.Response(200, text=page_html(), headers={"content-type": "text/html"})
        if request.url.host == "api.bilibili.com":
            if request.url.path == "/x/polymer/web-dynamic/v1/detail" and request.url.params.get("id") == DYNAMIC_ID:
                return httpx.Response(200, json=detail_json())
            if request.url.params.get("oid") == DYNAMIC_ID and request.url.params.get("type") == "11":
                if request.url.path == "/x/v2/reply/count":
                    return httpx.Response(200, json={"code": 0, "data": {"count": 0}})
                if request.url.path == "/x/v2/reply":
                    payload = json.loads((Path(__file__).parent / "fixtures/root-comments.json").read_text())
                    payload["data"].update(replies=[], hots=[], upper={"mid": UID, "top": None})
                    payload["data"]["page"].update(num=int(request.url.params["pn"]), count=0, acount=0)
                    return httpx.Response(200, json=payload)
        raise RuntimeError("Unexpected fixture source request")


def create_app():
    database = os.environ.get("BILI_DATABASE_PATH")
    if not database:
        raise RuntimeError("BILI_DATABASE_PATH is required for the risk fixture")
    # 生产装配默认的 RiskGate：与采集进程读同一个 SQLite 文件。
    return production_app(database, profile_transport=httpx.MockTransport(Source()))


async def serve(database):
    configure_safe_logging()
    store = Store(database)
    gate = RiskGate(store)
    async with httpx.AsyncClient(
            transport=GatedAsyncTransport(httpx.MockTransport(Source()), gate=gate), trust_env=False) as client, \
            httpx.AsyncClient(transport=GatedAsyncTransport(httpx.MockTransport(Source()), gate=gate),
                              trust_env=False) as media:
        collector = Collector(store, client, ImageDownloader(media), None, risk=gate,
                              credentials_configured=False)
        task = asyncio.create_task(collector.run())
        loop = asyncio.get_running_loop()
        for signum in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(signum, task.cancel)
        try:
            await task
        except asyncio.CancelledError:
            pass
        finally:
            for signum in (signal.SIGTERM, signal.SIGINT):
                loop.remove_signal_handler(signum)


def main():
    parser = argparse.ArgumentParser(description="Isolated risk-control fixture collector")
    parser.add_argument("--database", required=True)
    arguments = parser.parse_args()
    try:
        asyncio.run(serve(arguments.database))
    except KeyboardInterrupt:
        pass
    except Exception:
        raise SystemExit("Risk fixture collector failed") from None


if __name__ == "__main__":
    main()
