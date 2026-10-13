"""浏览器集成装配：生产应用、虚构传输和真实 SQLite。"""

import json
import os
from pathlib import Path

import httpx

from backend.bili_monitor.app import create_app as production_app

FIXTURES = Path(__file__).parent / "fixtures"


def create_app():
    attempts = {}
    files = {"9101": "normal", "9102": "empty", "9103": "restricted", "9104": "failed"}
    roots = json.loads((FIXTURES / "root-comments.json").read_text()) if os.environ.get("FIXTURE_ROOT_COMMENTS") == "1" else None
    replies = json.loads((FIXTURES / "replies.json").read_text()) if os.environ.get("FIXTURE_REPLIES") == "1" else None
    if replies is not None:
        assert roots is not None
        root_id = replies["data"]["root"]["rpid_str"]
        root = next(item for item in roots["data"]["replies"] if item["rpid_str"] == root_id)
        root["rcount"] = replies["data"]["page"]["count"]

    def upstream(request):
        if os.environ.get("FIXTURE_OFFLINE") == "1":
            raise httpx.ConnectError("FICTIONAL_SECRET_OFFLINE", request=request)
        if request.url.path == "/x/v2/reply" and roots is not None:
            assert request.url.params["oid"] == "9101"
            assert request.url.params["type"] == "11"
            assert request.url.params["sort"] == "0"
            assert request.url.params["ps"] == "20"
            page = int(request.url.params["pn"])
            payload = json.loads(json.dumps(roots))
            payload["data"]["page"]["num"] = page
            payload["data"]["replies"] = roots["data"]["replies"][(page - 1) * 20:page * 20] or None
            return httpx.Response(200, json=payload)
        if request.url.path == "/x/v2/reply/reply" and replies is not None:
            assert request.url.params["oid"] == "9101"
            assert request.url.params["type"] == "11"
            assert request.url.params["root"] == root_id
            assert request.url.params["ps"] == "20"
            page = int(request.url.params["pn"])
            assert page >= 1
            payload = json.loads(json.dumps(replies))
            payload["data"]["page"]["num"] = page
            payload["data"]["replies"] = replies["data"]["replies"][(page - 1) * 20:page * 20] or None
            return httpx.Response(200, json=payload)
        target_id = request.url.params.get("id") if request.url.path.endswith("/detail") else request.url.path.rsplit("/", 1)[-1]
        if target_id == "9104":
            attempts["failed-target"] = attempts.get("failed-target", 0) + 1
            if attempts["failed-target"] > 1:
                raise httpx.ConnectError("FICTIONAL_SECRET_TEXT_FAILURE", request=request)
        if request.url.path == "/x/web-interface/card":
            return httpx.Response(200, json={"code": 0, "data": {"card": {
                "mid": "202", "name": "虚构初始作者", "face": "https://example.invalid/avatar.svg",
            }}})
        if request.url.path == "/x/polymer/web-dynamic/v1/detail":
            dynamic_id = request.url.params["id"]
            if dynamic_id == "9199":
                raise httpx.ConnectError("FICTIONAL_SECRET_UNKNOWN", request=request)
            if dynamic_id == "9198":
                document = json.loads((FIXTURES / "normal.json").read_text())
                document["data"]["item"]["id_str"] = dynamic_id
                document["data"]["item"]["modules"]["module_author"]["mid"] = "303"
                return httpx.Response(200, json=document)
            attempts[dynamic_id] = attempts.get(dynamic_id, 0) + 1
            if dynamic_id in files:
                document = json.loads((FIXTURES / f"{files[dynamic_id]}.json").read_text())
                if roots is not None and dynamic_id == "9101":
                    document["data"]["item"]["modules"]["module_stat"]["comment"]["count"] = 501
                return httpx.Response(200, json=document)
        if request.url.path.startswith("/opus/"):
            dynamic_id = request.url.path.rsplit("/", 1)[-1]
            if dynamic_id == "9199":
                raise httpx.ConnectError("FICTIONAL_SECRET_UNKNOWN", request=request)
            page_key = "page:" + dynamic_id
            attempts[page_key] = attempts.get(page_key, 0) + 1
            page_file = "empty.html" if dynamic_id == "9102" else "restricted.html" if dynamic_id == "9103" else "edited.html"
            document = (FIXTURES / page_file).read_text().replace('"9101"', json.dumps(dynamic_id))
            if roots is not None and dynamic_id == "9101":
                document = document.replace('"count":7', '"count":501')
                long_text = "\n".join(f"详情完整正文第 {line} 行 🙂" for line in range(1, 41))
                document = document.replace("第七行以后的全文也应可读。", json.dumps(long_text, ensure_ascii=False)[1:-1])
            if dynamic_id == "9198":
                document = document.replace('"mid":"202"', '"mid":"303"')
            return httpx.Response(200, text=document, headers={"content-type": "text/html"})
        raise AssertionError("Unexpected upstream route")

    return production_app(os.environ["BILI_DATABASE_PATH"], profile_transport=httpx.MockTransport(upstream))
