"""#31 隔离部署装配；生产 API/Collector/SQLite，仅替换外部 I/O。

API 必须显式设置 BILI_DATABASE_PATH：
  uv run uvicorn backend.tests.deployment_fixture:create_app --factory --host 127.0.0.1 --port <free>
独立采集入口：
  uv run python -m backend.tests.deployment_fixture --database <same path>

固定虚构 UID=202、动态=91001、正文包含“部署隔离正文”。
DEPLOYMENT_FIXTURE_MEDIA_URL 可覆盖公开图 URL（默认 https://media.example.invalid/deployment.png）。
DEPLOYMENT_FIXTURE_CONTROL_DIR（可选）内 source.block/upload.block 是测试文件门闩；
对应 *.entered 在确已进入外部请求时创建，删 *.block 放行；*.fail 触发虚构失败。
BILI_DEPLOYMENT_SECRET 可指定虚构失败原文，仅测试脱敏使用。无控制目录时正常运行。
不读取 .env，不创建真实 OSS 客户端，不允许未知请求落到真实网络。
"""

import argparse
import asyncio
import base64
import json
import os
from pathlib import Path
import signal

import httpx

from backend.bili_monitor.app import create_app as production_app
from backend.bili_monitor.collector import Collector
from backend.bili_monitor.media import ImageDownloader
from backend.bili_monitor.storage import Store


FIXTURES = Path(__file__).parent / "fixtures" / "deployment"
UID = "202"
DYNAMIC_ID = "91001"
MEDIA_SOURCE = "https://i0.hdslb.com/deployment-fixture/source.png"
PUBLIC_MEDIA = "https://media.example.invalid/deployment.png"
MEDIA_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
)


def detail_json():
    payload = json.loads((FIXTURES / "normal.json").read_text())
    item = payload["data"]["item"]
    item["id_str"] = DYNAMIC_ID
    item["basic"]["comment_id_str"] = DYNAMIC_ID
    item["modules"]["module_stat"]["comment"]["count"] = 0
    opus = item["modules"]["module_dynamic"]["major"]["opus"]
    opus["pics"][0]["url"] = MEDIA_SOURCE
    opus["summary"]["rich_text_nodes"][0]["text"] = "部署隔离正文 🙂"
    return payload


def page_html():
    # 复用已版本化的原始 HTML，不替换生产解析器。
    return ((FIXTURES / "edited.html").read_text()
            .replace('"9101"', json.dumps(DYNAMIC_ID))
            .replace("https://example.invalid/source-business.jpg", MEDIA_SOURCE)
            .replace("虚构首次归档正文 🙂", "部署隔离正文 🙂"))


async def external_gate(kind):
    directory = os.environ.get("DEPLOYMENT_FIXTURE_CONTROL_DIR")
    if not directory:
        return
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{kind}.entered").touch()
    while (directory / f"{kind}.block").exists():
        await asyncio.sleep(0.05)
    if (directory / f"{kind}.fail").exists():
        raise RuntimeError(os.environ.get("BILI_DEPLOYMENT_SECRET", "FAKE_DEPLOYMENT_SECRET_31_NEVER_REAL"))


class FixtureSource:
    async def __call__(self, request):
        if request.method != "GET":
            raise RuntimeError("Unexpected fixture request")
        if request.url.host == "api.bilibili.com" and request.url.path == "/x/web-interface/card":
            if request.url.params.get("mid") == "303":
                raise httpx.ConnectError(
                    os.environ.get("BILI_DEPLOYMENT_SECRET", "FAKE_DEPLOYMENT_SECRET_31_NEVER_REAL"), request=request)
            if request.url.params.get("mid") != UID:
                return httpx.Response(200, json={"code": -404})
            return httpx.Response(200, json={"code": 0, "data": {"card": {
                "mid": UID, "name": "虚构部署作者", "face": PUBLIC_MEDIA,
            }}})
        if request.url.host == "www.bilibili.com" and request.url.path == f"/opus/{DYNAMIC_ID}":
            await external_gate("source")
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


def download(request):
    if request.method != "GET" or str(request.url) != MEDIA_SOURCE:
        raise RuntimeError("Unexpected fixture media request")
    return httpx.Response(200, content=MEDIA_BYTES, headers={"content-type": "image/png"})


class FixtureUploader:
    async def upload(self, key, content, content_type):
        if content != MEDIA_BYTES or content_type != "image/png":
            raise RuntimeError("Unexpected fixture upload")
        await external_gate("upload")
        return os.environ.get("DEPLOYMENT_FIXTURE_MEDIA_URL", PUBLIC_MEDIA)


def create_app():
    database = os.environ.get("BILI_DATABASE_PATH")
    if not database:
        raise RuntimeError("BILI_DATABASE_PATH is required for the deployment fixture")
    return production_app(
        database, profile_transport=httpx.MockTransport(FixtureSource()),
        media_transport=httpx.MockTransport(download), media_uploader=FixtureUploader(),
    )


async def serve(database):
    async with httpx.AsyncClient(transport=httpx.MockTransport(FixtureSource()), trust_env=False) as source, \
            httpx.AsyncClient(transport=httpx.MockTransport(download), trust_env=False) as media:
        # 使用生产 run() 的真实锁、恢复和固定 15 秒调度，不手动驱动内部阶段。
        collector = Collector(Store(database), source, ImageDownloader(media), FixtureUploader())
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
    parser = argparse.ArgumentParser(description="Isolated deployment fixture collector")
    parser.add_argument("--database", required=True)
    arguments = parser.parse_args()
    try:
        asyncio.run(serve(arguments.database))
    except KeyboardInterrupt:
        pass
    except Exception:
        raise SystemExit("Deployment fixture collector failed") from None


if __name__ == "__main__":
    main()
