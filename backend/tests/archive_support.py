"""02 票共享的公开 HTTP 与虚构来源 fixture 装配。"""

import json
from contextlib import contextmanager
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app
from backend.tests.management_support import BASE, UID, profile_response

TARGETS = f"{BASE}/{UID}/targets"


@contextmanager
def archive_client(path, handler=None):
    def upstream(request):
        if request.url.path == "/x/web-interface/card":
            return profile_response(request)
        assert handler is not None, "Unexpected upstream request"
        return handler(request)

    with TestClient(create_app(path, profile_transport=httpx.MockTransport(upstream))) as client:
        yield client


def author_html():
    return (Path(__file__).parent / "fixtures/author.html").read_text()


def set_specified(client, enabled=True):
    return client.patch(f"{BASE}/{UID}/monitor", json={"mode": "specified", "recent_n": 10, "enabled": enabled})


def detail_json():
    return json.loads((Path(__file__).parent / "fixtures/detail.json").read_text())


def readable_html(text="虚构全文\n第二行 <b>仍是文本</b> 🙂", *, id="123", title=None, pictures=None):
    paragraphs = []
    if text is not None:
        paragraphs.append({"para_type": 1, "text": {"nodes": [{"type": "TEXT_NODE_TYPE_WORD", "word": {"words": text}}]}})
    if pictures is None:
        pictures = [
            {"url": "https://example.invalid/first.png", "width": 640, "height": 480},
            {"url": "https://example.invalid/second.png", "width": 200, "height": 1200},
        ]
    if pictures:
        paragraphs.append({"para_type": 2, "pic": {"pics": pictures}})
    modules = [{"module_type": "MODULE_TYPE_CONTENT", "module_content": {"paragraphs": paragraphs}}]
    if title is not None:
        modules.insert(0, {"module_type": "MODULE_TYPE_TITLE", "module_title": {"text": title}})
    html = author_html().replace('"modules":[', '"modules":[' + ",".join(json.dumps(item, ensure_ascii=False) for item in modules) + ",")
    return html.replace('"id_str":"123"', f'"id_str":"{id}"')
