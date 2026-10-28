"""04 隔离跨进程装配：真实 API／采集／领取进程与同一临时 SQLite，只替换外部来源与时钟。

角色（`RISK_PROBE_ROLE` 或 `--task`）：

- `api`：`uvicorn backend.tests.risk_probe_fixture:create_app --factory`；生产 API 装配。
- `collector`：`python -m backend.tests.risk_probe_fixture --database <db>`；生产采集循环
  （固定节拍、保护暂停、到期探测与恢复），只把来源换成下面的虚构实现。
- `trigger`／`claim`／`finish`：一次性进程，用来在真实独立进程中触发保护、领取探测轮次
  和提交结果，证明唯一 owner 租约与旧 owner fencing。

控制文件（`RISK_PROBE_FIXTURE_DIR`）：

- `clock.txt`：共享的 UTC epoch 秒；缺失时用真实时间。测试用写文件推进“现在”。
- `ledger.txt`：每次虚构来源发送记录「角色 方法 接口类型」。
- `risk.arm`：这些接口类型返回 HTTP 412（风控触发）。
- `probe.fail`：这些接口类型返回 HTTP 412（探测失败）。

不读取 .env、不创建真实 OSS／B 站客户端、不允许未知请求落到真实网络。
"""

import argparse
import asyncio
import json
import os
from pathlib import Path
import signal
import time

import httpx

from backend.bili_monitor.app import create_app as production_app
from backend.bili_monitor.collector import Collector
from backend.bili_monitor.media import ImageDownloader, is_archive_delivery_url
from backend.bili_monitor.reply_pacing import ReplyPagePacer
from backend.bili_monitor.risk import RiskGate, SourceRiskPaused, format_epoch
from backend.bili_monitor.risk_probe import RiskProber
from backend.bili_monitor.safety import configure_safe_logging
from backend.bili_monitor.source_gate import GatedAsyncTransport, SourceReport, source_request
from backend.bili_monitor.storage import Store
from backend.tests.deployment_fixture import (
    DYNAMIC_ID, MEDIA_BYTES, UID, detail_json, page_html,
)


DIRECTORY = Path(os.environ["RISK_PROBE_FIXTURE_DIR"]) if os.environ.get("RISK_PROBE_FIXTURE_DIR") else None
ROLE = os.environ.get("RISK_PROBE_ROLE", "")


class FileClock:
    """跨进程共享的受控时钟：两个真实进程读同一个 `clock.txt`。"""

    def __init__(self, directory):
        self.path = Path(directory) / "clock.txt"

    def _epoch(self):
        try:
            return float(self.path.read_text().strip())
        except (OSError, ValueError):
            return None

    def monotonic(self):
        value = self._epoch()
        return value if value is not None else time.monotonic()

    def now(self):
        value = self._epoch()
        return format_epoch(value if value is not None else time.time())

    async def sleep(self, seconds):
        # 跨进程受控时间下，真实等待时长由测试决定：节拍只决定“现在”的推进粒度。
        override = os.environ.get("RISK_PROBE_CLOCK_SLEEP")
        if override:
            seconds = float(override)
        await asyncio.sleep(seconds)


def ledger(kind, method="GET"):
    if DIRECTORY is None:
        return
    with (DIRECTORY / "ledger.txt").open("a") as handle:
        handle.write(f"{ROLE or 'task'} {method} {kind}\n")


def controlled(name):
    if DIRECTORY is None:
        return set()
    path = DIRECTORY / name
    if not path.exists():
        return set()
    return set(path.read_text().split())


class Source:
    """虚构来源：接口形状取自已版本化样本；不访问真实 B 站。"""

    async def __call__(self, request):
        if request.method != "GET":
            raise RuntimeError("Unexpected fixture request")
        classified = source_request(request.method, request.url)
        kind = classified.endpoint_type if classified is not None else ""
        if classified is not None:
            ledger(kind, request.method)
        if kind in controlled("risk.arm") or kind in controlled("probe.fail"):
            return httpx.Response(412, text="")
        if request.url.host == "api.bilibili.com" and request.url.path == "/x/web-interface/card":
            return httpx.Response(200, json={"code": 0, "data": {"card": {
                "mid": UID, "name": "虚构风控作者", "face": "https://media.example.invalid/avatar.png",
            }}})
        if request.url.host == "www.bilibili.com" and request.url.path == f"/opus/{DYNAMIC_ID}":
            return httpx.Response(200, text=page_html(), headers={"content-type": "text/html"})
        if request.url.host in ("i0.hdslb.com", "i1.hdslb.com"):
            return httpx.Response(200, content=MEDIA_BYTES,
                                  headers={"content-type": "image/png"})
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


class Uploader:
    """本地替身：返回不含签名、可校验的公开交付地址，不访问 OSS。"""

    async def upload(self, key, content, content_type):
        url = f"https://media.example.invalid/{key}"
        if not is_archive_delivery_url(url):
            raise RuntimeError("Invalid fixture media URL")
        return url

    async def close(self):
        return None


def create_app():
    database = os.environ.get("BILI_DATABASE_PATH")
    if not database:
        raise RuntimeError("BILI_DATABASE_PATH is required for the probe fixture")
    clock = FileClock(DIRECTORY)
    return production_app(
        database,
        profile_transport=httpx.MockTransport(Source()),
        media_transport=httpx.MockTransport(Source()),
        media_uploader=Uploader(),
        risk_clock=clock,
    )


async def serve(database):
    configure_safe_logging()
    clock = FileClock(DIRECTORY)
    store = Store(database)
    gate = RiskGate(store, clock=clock)
    async with httpx.AsyncClient(
            transport=GatedAsyncTransport(httpx.MockTransport(Source()), gate=gate),
            trust_env=False, follow_redirects=False) as client, \
            httpx.AsyncClient(
                transport=GatedAsyncTransport(httpx.MockTransport(Source()), gate=gate),
                trust_env=False) as media, \
            httpx.AsyncClient(transport=httpx.MockTransport(Source()), trust_env=False) as probe_client, \
            httpx.AsyncClient(transport=httpx.MockTransport(Source()), trust_env=False) as probe_media:
        prober = RiskProber(store, gate, probe_client,
                            downloader=ImageDownloader(probe_media),
                            reply_page_pacer=ReplyPagePacer())
        collector = Collector(store, client, ImageDownloader(media), Uploader(), risk=gate,
                             probe=prober, clock=clock, credentials_configured=False)
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


def open_state(database):
    store = Store(database)
    store.migrate()
    return store, RiskGate(store, clock=FileClock(DIRECTORY))


def trigger(database, path):
    store, gate = open_state(database)
    classified = source_request("GET", f"https://api.bilibili.com{path}")
    try:
        asyncio.run(gate.report(classified, SourceReport(status_code=412)))
    except SourceRiskPaused:
        pass
    print(json.dumps(gate.status(), sort_keys=True))


def claim(database, types):
    store, gate = open_state(database)
    result = asyncio.run(gate.claim_probe(types))
    print(json.dumps(result, sort_keys=True))


def finish(database, round_id, owner, passed):
    store, gate = open_state(database)
    status = asyncio.run(gate.finish_probe(
        {"round": round_id, "owner": owner}, passed == "true"))
    print(json.dumps(status, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description="Isolated risk probe fixture")
    parser.add_argument("--database", required=True)
    parser.add_argument("--task", choices=("collector", "trigger", "claim", "finish"), default="collector")
    parser.add_argument("--path", default="/x/v2/reply/count")
    parser.add_argument("--types", default="")
    parser.add_argument("--round", default="")
    parser.add_argument("--owner", default="")
    parser.add_argument("--passed", default="true")
    arguments = parser.parse_args()
    try:
        if arguments.task == "trigger":
            trigger(arguments.database, arguments.path)
        elif arguments.task == "claim":
            claim(arguments.database, [kind for kind in arguments.types.split(",") if kind])
        elif arguments.task == "finish":
            finish(arguments.database, arguments.round, arguments.owner, arguments.passed)
        else:
            asyncio.run(serve(arguments.database))
    except KeyboardInterrupt:
        pass
    except Exception:
        raise SystemExit("Risk probe fixture failed") from None


if __name__ == "__main__":
    main()
