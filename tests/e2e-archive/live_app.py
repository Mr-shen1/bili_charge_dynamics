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

    def upstream(request):
        if os.environ.get("FIXTURE_OFFLINE") == "1":
            raise httpx.ConnectError("FICTIONAL_SECRET_OFFLINE", request=request)
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
                return httpx.Response(200, text=(FIXTURES / f"{files[dynamic_id]}.json").read_text(),
                                      headers={"content-type": "application/json"})
        if request.url.path.startswith("/opus/"):
            dynamic_id = request.url.path.rsplit("/", 1)[-1]
            if dynamic_id == "9199":
                raise httpx.ConnectError("FICTIONAL_SECRET_UNKNOWN", request=request)
            page_key = "page:" + dynamic_id
            attempts[page_key] = attempts.get(page_key, 0) + 1
            page_file = "empty.html" if dynamic_id == "9102" else "restricted.html" if dynamic_id == "9103" else "edited.html"
            document = (FIXTURES / page_file).read_text().replace('"9101"', json.dumps(dynamic_id))
            if dynamic_id == "9198":
                document = document.replace('"mid":"202"', '"mid":"303"')
            return httpx.Response(200, text=document, headers={"content-type": "text/html"})
        raise AssertionError("Unexpected upstream route")

    return production_app(os.environ["BILI_DATABASE_PATH"], profile_transport=httpx.MockTransport(upstream))
