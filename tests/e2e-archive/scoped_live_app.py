"""有限虚构档案，使用生产 Store 写入真实 SQLite；读取时上游禁止访问。"""

import os

import httpx

from backend.bili_monitor.app import create_app as production_app
from backend.bili_monitor.storage import Store


def create_app():
    path = os.environ["BILI_DATABASE_PATH"]
    store = Store(path)
    store.migrate()
    if not store.read():
        for uid, name in [("123", "保留作者一"), ("456", "保留作者二"), ("789", "已知空作者")]:
            store.add(uid, name, None)
            store.update(uid, "specified", 10, True)
        for index in range(25):
            uid = "123" if index % 2 == 0 else "456"
            id = str(1001 + index)
            store.add_target(uid, id)
            generation = store.claim_archive(uid, id)
            store.observe_archive(id, generation, {
                "published_at": f"2026-03-{28 - index // 2:02d}T10:00:00+08:00",
                "observed_version": "fixture-v1",
            })
            store.finish_archive(id, generation, "success", {"text": f"有限归档正文 {id}"}, "fixture-v1")

    def unavailable(request):
        raise AssertionError("Archive reading must not contact upstream")

    return production_app(path, profile_transport=httpx.MockTransport(unavailable))
