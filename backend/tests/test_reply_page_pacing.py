"""02：楼中楼每页真实请求结束后的 100ms 等待（真实归档链 + 多调用者账本）。"""

import asyncio
import json
import logging
import sqlite3

import httpx
import requests
from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app
from backend.bili_monitor.comment_client import RequestsCommentClient
from backend.bili_monitor.replies import sync_replies
from backend.bili_monitor.storage import Store
from backend.bili_monitor.reply_pacing import ReplyPagePacer
from backend.bili_monitor.source_endpoints import REPLIES_URL
from backend.bili_monitor.source_transport import SourcePacer
from backend.tests.archive_support import UID
from backend.tests.management_support import profile_response
from backend.tests.root_support import prepare
from backend.tests.test_replies import ROOT, reply_fixture, reply_source


class _Response:
    """Requests 已解压的最小响应替身：`_get` 会把它转成 HTTPX 响应。"""

    def __init__(self, response, request):
        self.status_code = response.status_code
        self.content = response.content
        self.headers = dict(response.headers)
        self.url = str(request.url)

    def close(self):
        pass


def install_source(monkeypatch, events, state, *, fail_page=None):
    """真实 API 装配：只替换外部 HTTP；楼中楼走生产 Requests 评论会话。"""
    source = reply_source(state)
    if fail_page is not None:
        state["fail_reply_page"] = fail_page

    def comment_get(session, url, params=None, headers=None, timeout=None, **kwargs):
        request = httpx.Request("GET", url, params=params)
        if request.url.path == "/x/v2/reply/reply":
            events.append(("send", request.url.params["pn"]))
            try:
                response = source(request)
            except Exception as error:
                events.append(("failed", request.url.params["pn"]))
                raise requests.ConnectionError("FICTIONAL_REPLY_FAILURE") from error
            events.append(("done", request.url.params["pn"]))
            return _Response(response, request)
        if request.url.path.startswith("/x/"):
            # 根页与评论计数走同一个生产 Requests 会话，只有楼中楼进入页后等待账本。
            return _Response(source(request), request)
        # 首页／空间预热不参与页后等待断言。
        return _Response(httpx.Response(200, text=""), request)

    async def upstream(transport, request):
        if request.url.path == "/x/web-interface/card":
            return profile_response(request)
        return source(request)

    monkeypatch.setattr(requests.Session, "get", comment_get)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", upstream)


def run_initial(path, monkeypatch, events, state, *, pacer, fail_page=None):
    install_source(monkeypatch, events, state, fail_page=fail_page)
    with TestClient(create_app(path, reply_page_pacer=pacer)) as api:
        prepare(api)
        assert api.post("/api/sync/initial", json={"uid": UID}).status_code == 200


def test_every_real_reply_page_waits_after_response_through_real_archive_chain(tmp_path, monkeypatch):
    events = []

    async def wait(seconds):
        # 只有页后等待进入这个替身：第一个请求之前不允许出现等待。
        events.append(("wait", seconds))
        await asyncio.sleep(0)

    state = {}
    run_initial(tmp_path / "pacing.sqlite", monkeypatch, events, state,
                pacer=ReplyPagePacer(sleep=wait, jitter=0))
    assert state["reply_pages"] == [1, 2, 2]
    assert events == [
        ("send", "1"), ("done", "1"), ("wait", 0.1),
        ("send", "2"), ("done", "2"), ("wait", 0.1),
        # 空尾页复查也是一次真实请求，最后一页之后仍然等待。
        ("send", "2"), ("done", "2"), ("wait", 0.1),
    ]


def test_failed_reply_request_still_pays_the_page_wait(tmp_path, monkeypatch):
    events = []

    async def wait(seconds):
        events.append(("wait", seconds))
        await asyncio.sleep(0)

    run_initial(tmp_path / "failing.sqlite", monkeypatch, events, {},
                pacer=ReplyPagePacer(sleep=wait, jitter=0), fail_page=2)
    assert events[-3:] == [("send", "2"), ("failed", "2"), ("wait", 0.1)]


def test_zero_reply_root_pays_no_page_or_per_root_wait(tmp_path, monkeypatch):
    events, root_waits = [], []

    async def wait(seconds):
        events.append(("wait", seconds))
        await asyncio.sleep(0)

    async def root_wait(seconds):
        root_waits.append(seconds)
        await asyncio.sleep(0)

    monkeypatch.setattr("backend.bili_monitor.replies.sleep_after_root", root_wait)
    run_initial(tmp_path / "zero.sqlite", monkeypatch, events, {},
                pacer=ReplyPagePacer(sleep=wait, jitter=0))
    # 固件里第二栋楼来源明确零回复：没有真实楼中楼请求，也没有楼级等待。
    assert [event for event in events if event[0] == "wait"] == [("wait", 0.1)] * 3
    assert len(root_waits) == 1
    assert 0.3 <= root_waits[0] <= 0.4


class VirtualTime:
    """单调时钟与等待共用同一账本：等待真的把时间推后。"""

    def __init__(self):
        self.value = 0.0
        self.waits = []

    def __call__(self):
        return self.value

    async def sleep(self, seconds):
        self.waits.append((self.value, seconds))
        self.value += seconds
        await asyncio.sleep(0)


def test_two_callers_cannot_interleave_past_the_page_wait(monkeypatch):
    clock, sends, done = VirtualTime(), [], []

    def comment_get(session, url, params=None, headers=None, timeout=None, **kwargs):
        request = httpx.Request("GET", url, params=params)
        sends.append((request.url.params["root"], clock()))
        done.append((request.url.params["root"], clock()))
        response = httpx.Response(200, json={"code": 0, "data": {}})
        return _Response(response, request)

    monkeypatch.setattr(requests.Session, "get", comment_get)

    async def scenario():
        pacer = ReplyPagePacer(sleep=clock.sleep, clock=clock, jitter=0)
        first = RequestsCommentClient("101", (), SourcePacer(sleep=clock.sleep), reply_page_pacer=pacer)
        second = RequestsCommentClient("102", (), SourcePacer(sleep=clock.sleep), reply_page_pacer=pacer)
        await first.get(REPLIES_URL, params={"root": "1"})
        # 两个调用者共用一个协调器：谁先完成，谁就把下一次发送推后至少 100ms。
        await asyncio.gather(second.get(REPLIES_URL, params={"root": "2"}),
                             first.get(REPLIES_URL, params={"root": "3"}))
        await first.aclose()
        await second.aclose()

    asyncio.run(scenario())
    assert sends[0] == ("1", 0.0)
    assert clock.waits[0] == (0.0, 0.1)
    for (_, completed), (_, started) in zip(done, sends[1:]):
        assert started >= completed + 0.1 - 1e-9
    assert [send[1] for send in sends] == [0.0, 0.1, 0.2]


def test_reply_page_wait_holds_no_sqlite_write_transaction(tmp_path, monkeypatch):
    path, write_locks = tmp_path / "locks.sqlite", []

    async def wait(seconds):
        # 等待期间另开连接做一次写事务：若同步仍持有写锁，这里会立刻 database is locked。
        with sqlite3.connect(path, timeout=0.1) as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("UPDATE identities SET name = name")
            connection.commit()
        write_locks.append(seconds)
        await asyncio.sleep(0)

    run_initial(path, monkeypatch, [], {}, pacer=ReplyPagePacer(sleep=wait, jitter=0))
    assert write_locks == [0.1, 0.1, 0.1]


def tail_fixture(count):
    template = reply_fixture()["data"]["replies"][0]
    replies = []
    for value in range(1, count + 1):
        item = json.loads(json.dumps(template))
        item.update(rpid_str=str(value), parent_str=ROOT)
        item["content"]["message"] = f"回复 {value}"
        replies.append(item)
    return replies


def run_incremental(path, monkeypatch, events, state, *, pacer, observed):
    """真实装配的末页倒序增量：只替换外部 HTTP，页面等待仍由同一协调器执行。"""
    install_source(monkeypatch, events, state)

    async def scenario():
        store = Store(path)
        generation = store.claim_archive(UID, "123")
        assert generation is not None
        client = RequestsCommentClient("101", (), SourcePacer(sleep=asyncio.sleep),
                                       reply_page_pacer=pacer)
        try:
            await sync_replies(store, client, "123", generation, ({ROOT: observed}, 7), uid=UID,
                               now=lambda: "2026-10-27T12:00:00+00:00")
        finally:
            await client.aclose()

    asyncio.run(scenario())


def test_incremental_tail_pages_share_the_same_wait_and_log_reverse_direction(tmp_path, monkeypatch):
    """末页倒序增量与探测走同一条 `client.get` 路径，因此同样有页后等待。"""
    clock, events = VirtualTime(), []
    state = {"replies": tail_fixture(25)}
    pacer = ReplyPagePacer(sleep=clock.sleep, clock=clock, jitter=0)
    path = tmp_path / "tail-wait.sqlite"
    run_initial(path, monkeypatch, events, state, pacer=pacer)
    # 初始化那轮的页后等待另算；这里只看末页倒序增量的账本。
    events.clear()
    waited = len(clock.waits)

    logged = []

    class Handler(logging.Handler):
        def emit(self, record):
            logged.append(record.getMessage())

    logger = logging.getLogger("bili_monitor.collector")
    handler = Handler()
    logger.addHandler(handler)
    state["replies"] = tail_fixture(26)
    state["reply_pages"] = []
    try:
        run_incremental(path, monkeypatch, events, state, pacer=pacer, observed=26)
    finally:
        logger.removeHandler(handler)
    # 末页与向前一页都是真实分页请求，各自结束后各等待一次。
    assert state["reply_pages"] == [2, 1]
    assert events == [("send", "2"), ("done", "2"), ("send", "1"), ("done", "1")]
    # 第二次发送发生在上一次完成并等待 100ms 之后，最后一次之后同样等待。
    assert clock.waits[waited:] == [(0.4, 0.1), (0.5, 0.1)]
    assert [message.split("direction=")[1].split(" ")[0] for message in logged
            if message.startswith("reply_page_fetched")] == ["reverse", "reverse"]
