"""楼中楼增量：真实 SQLite + 来源分页替身，不访问生产来源。"""

import asyncio
import copy
import logging
import sqlite3
import time

import httpx
import pytest

from backend.bili_monitor.replies import sync_replies
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import UID, archive_client
from backend.tests.root_support import prepare
from backend.tests.test_replies import ROOT, REPLIES, reply_fixture, reply_source


def replies(count):
    template = reply_fixture()["data"]["replies"][0]
    result = []
    for value in range(1, count + 1):
        item = copy.deepcopy(template)
        item["rpid_str"] = str(value)
        item["parent_str"] = ROOT
        result.append(item)
    return result


def run_round(path, state, *, full=False, observed=2, page_counts=None):
    store = Store(path)
    generation = store.claim_archive(UID, "123")
    assert generation is not None
    source = reply_source(state)

    def upstream(request):
        if request.url.path == "/x/v2/reply/reply":
            state.setdefault("request_times", []).append(time.monotonic())
        response = source(request)
        if request.url.path == "/x/v2/reply/reply" and state.get("empty_tail_page") == int(request.url.params["pn"]):
            payload = response.json()
            payload["data"]["replies"] = None
            return httpx.Response(200, json=payload)
        if request.url.path == "/x/v2/reply/reply" and page_counts:
            number = int(request.url.params["pn"])
            override = page_counts.pop(0)
            if override is not None:
                payload = response.json()
                payload["data"]["page"]["count"] = override
                return httpx.Response(200, json=payload)
        return response

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            await sync_replies(store, client, "123", generation, ({ROOT: observed}, 2),
                               uid=UID, full=full, now=lambda: "2026-10-27T12:00:00+00:00")
    asyncio.run(scenario())


def setup(path, state):
    with archive_client(path, reply_source(state)) as api:
        prepare(api)
        assert api.post("/api/sync/initial", json={"uid": UID}).status_code == 200
    state["reply_pages"] = []


@pytest.mark.parametrize("old,new,expected", [
    (20, 41, [1, 3, 2]),     # 末页全新，随后退化到已缓存的首页
    (25, 26, [1, 2]),        # 末页半新半旧，首页复用
    (40, 41, [1, 3, 2]),    # 末页已知，overlap 再到首页
])
def test_tail_saves_new_replies_without_rescanning_every_page(tmp_path, old, new, expected, caplog):
    path = tmp_path / "tail.sqlite"
    state = {"replies": replies(old)}
    setup(path, state)
    state["replies"] = replies(new)
    logger = logging.getLogger("bili_monitor.collector")
    logger.addHandler(caplog.handler)
    try:
        run_round(path, state, observed=3)
    finally:
        logger.removeHandler(caplog.handler)
    assert state["reply_pages"] == expected
    with archive_client(path) as api:
        thread = api.get(REPLIES).json()
        assert thread["local_reply_count"] == new
        assert thread["source_reply_count"] == new
        assert thread["replies_last_attempt"] == "success"
    assert "reply_incremental_finished" in caplog.text
    assert "local_source_delta=0" in caplog.text


def test_known_page_requires_one_more_known_overlap(tmp_path):
    path = tmp_path / "overlap.sqlite"
    state = {"replies": replies(60)}
    setup(path, state)
    state["replies"] = replies(61)
    run_round(path, state, observed=3)
    assert state["reply_pages"] == [1, 4, 3, 2]


def test_second_drift_aborts_checkpoint_and_next_round_can_retry(tmp_path, caplog):
    path = tmp_path / "drift.sqlite"
    state = {"replies": replies(25)}
    setup(path, state)
    state["replies"] = replies(26)
    logger = logging.getLogger("bili_monitor.collector")
    logger.addHandler(caplog.handler)
    try:
        run_round(path, state, observed=3, page_counts=[None, 27, None, 28])
    finally:
        logger.removeHandler(caplog.handler)
    with archive_client(path) as api:
        assert api.get(REPLIES).json()["replies_last_attempt"] == "failed"
        assert api.get(REPLIES).json()["local_reply_count"] == 25
    assert "stopped_by=drift" in caplog.text
    state["reply_pages"] = []
    run_round(path, state, observed=3)
    assert state["reply_pages"] == [1, 2, 3, 3]  # failed root uses existing full scan


def test_first_count_drift_restarts_from_new_page_one(tmp_path):
    path = tmp_path / "drift-once.sqlite"
    state = {"replies": replies(25)}
    setup(path, state)
    state["replies"] = replies(26)
    run_round(path, state, observed=3, page_counts=[None, 27])
    assert state["reply_pages"] == [1, 2, 1, 2]
    with archive_client(path) as api:
        assert api.get(REPLIES).json()["local_reply_count"] == 26
        assert api.get(REPLIES).json()["replies_last_attempt"] == "success"


def test_deleted_reply_remains_and_delta_reports_orphan(tmp_path, caplog):
    path = tmp_path / "orphan.sqlite"
    state = {"replies": replies(25)}
    setup(path, state)
    state["replies"] = replies(25)[1:] + replies(26)[-1:]
    logger = logging.getLogger("bili_monitor.collector")
    logger.addHandler(caplog.handler)
    try:
        run_round(path, state, observed=3)
    finally:
        logger.removeHandler(caplog.handler)
    with archive_client(path) as api:
        thread = api.get(REPLIES).json()
        assert thread["local_reply_count"] == 26
        assert thread["source_reply_count"] == 25
    assert "local_source_delta=1" in caplog.text


def test_unreadable_tail_is_confirmed_without_failing_the_root(tmp_path):
    path = tmp_path / "unreadable.sqlite"
    state = {"replies": replies(25)}
    setup(path, state)
    state["empty_tail_page"] = 2
    run_round(path, state, observed=3)
    assert state["reply_pages"] == [1, 2, 2]
    with archive_client(path) as api:
        assert api.get(REPLIES).json()["replies_last_attempt"] == "success"
        assert api.get(REPLIES).json()["local_reply_count"] == 25


def test_incremental_failure_logs_actual_page(tmp_path, caplog):
    path = tmp_path / "page-error.sqlite"
    state = {"replies": replies(25)}
    setup(path, state)
    state["fail_reply_page"] = 2
    logger = logging.getLogger("bili_monitor.collector")
    logger.addHandler(caplog.handler)
    try:
        run_round(path, state, observed=3)
    finally:
        logger.removeHandler(caplog.handler)
    assert "reply_sync_failed" in caplog.text
    assert "page=2" in caplog.text


def test_empty_source_count_succeeds_with_only_page_one(tmp_path):
    path = tmp_path / "empty.sqlite"
    state = {"replies": replies(25)}
    setup(path, state)
    state["replies"] = []
    run_round(path, state, observed=3)
    assert state["reply_pages"] == [1]
    with archive_client(path) as api:
        thread = api.get(REPLIES).json()
        assert thread["replies_last_attempt"] == "success"
        assert thread["local_reply_count"] == 25


def test_reply_pages_have_no_sleep_but_each_root_waits_after_completion(tmp_path, monkeypatch):
    path = tmp_path / "pacing.sqlite"
    state = {"replies": replies(25)}
    setup(path, state)
    state["replies"] = replies(26)
    events = []
    original_sleep = asyncio.sleep

    async def sleep(seconds):
        events.append(("wait", seconds))
        # 等待时 SQLite 写锁必须已经释放。
        with sqlite3.connect(path, timeout=0, isolation_level=None) as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.rollback()
        await original_sleep(0)

    monkeypatch.setattr("backend.bili_monitor.replies.sleep_after_root", sleep)
    run_round(path, state, observed=3)
    assert len(events) == 1
    assert 0.3 <= events[0][1] <= 0.4
    assert state["reply_pages"] == [1, 2]
    assert state["request_times"][1] - state["request_times"][0] < 0.1


def test_full_and_failed_root_keep_forward_scan(tmp_path):
    path = tmp_path / "full.sqlite"
    state = {"replies": replies(25)}
    setup(path, state)
    run_round(path, state, full=True)
    assert state["reply_pages"] == [1, 2, 3, 3]
