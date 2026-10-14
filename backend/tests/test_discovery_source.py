"""27 / T3 补充 seam：公开发现读取 + 外部 MockTransport 原始虚构 JSON。"""

import json
from pathlib import Path

import anyio
import httpx
import pytest

from backend.bili_monitor.discovery import DiscoveryError, DiscoveryStopped, discover_recent


FIXTURES = Path(__file__).parent / "fixtures"
UID = "101"
FIRST_ID = "9007199254741009"


def feed(name="page1"):
    return json.loads((FIXTURES / f"recent-feed-{name}.json").read_text())


def discover(handler, n, *, uid=UID, **callbacks):
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await discover_recent(client, uid, n, **callbacks)
    return anyio.run(run)


def test_enough_candidates_stops_without_requesting_history():
    def handler(request):
        assert str(request.url.copy_with(query=None)) == (
            "https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space"
        )
        assert dict(request.url.params) == {"host_mid": UID}
        assert "cookie" not in request.headers and "authorization" not in request.headers
        return httpx.Response(200, json=feed())

    assert discover(handler, 1) == {"ids": [FIRST_ID], "exhausted": False}


def test_cross_page_unique_candidates_keep_source_order_until_n_or_exhaustion():
    def handler(request):
        offset = request.url.params.get("offset")
        page = {None: "page1", "page-2": "page2", "page-3": "empty"}[offset]
        return httpx.Response(200, json=feed(page))

    assert discover(handler, 3) == {"ids": [FIRST_ID, "11", "800"], "exhausted": False}
    assert discover(handler, 10) == {"ids": [FIRST_ID, "11", "800", "5"], "exhausted": True}


@pytest.mark.parametrize("failure,code", [
    ("http", "SOURCE_UNAVAILABLE"),
    ("transport", "SOURCE_UNAVAILABLE"),
    ("business", "SOURCE_UNAVAILABLE"),
    ("json", "SIGNAL_INVALID"),
    ("missing-code", "SIGNAL_INVALID"),
    ("bool-code", "SIGNAL_INVALID"),
    ("string-code", "SIGNAL_INVALID"),
    ("envelope", "SIGNAL_INVALID"),
])
def test_upstream_failures_raise_only_fixed_safe_errors(failure, code, caplog):
    def handler(request):
        if failure == "http":
            return httpx.Response(412, text="FICTIONAL_SECRET")
        if failure == "transport":
            raise httpx.ConnectError("FICTIONAL_SECRET", request=request)
        if failure == "json":
            return httpx.Response(200, text="FICTIONAL_SECRET")
        payload = feed()
        if failure == "business":
            payload.update(code=-101, message="FICTIONAL_SECRET")
        elif failure == "missing-code":
            del payload["code"]
        elif failure == "bool-code":
            payload["code"] = False
        elif failure == "string-code":
            payload["code"] = "0"
        elif failure == "envelope":
            payload = ["FICTIONAL_SECRET"]
        return httpx.Response(200, json=payload)

    with pytest.raises(DiscoveryError) as caught:
        discover(handler, 3)
    assert caught.value.code == str(caught.value) == code
    assert caught.value.__suppress_context__
    assert "FICTIONAL_SECRET" not in str(caught.value) + caplog.text


MISSING = object()


@pytest.mark.parametrize("field,value,code", [
    ("data", MISSING, "SIGNAL_INVALID"),
    ("data", None, "SIGNAL_INVALID"),
    ("data", [], "SIGNAL_INVALID"),
    ("has_more", MISSING, "PAGINATION_INVALID"),
    ("has_more", None, "PAGINATION_INVALID"),
    ("has_more", "false", "PAGINATION_INVALID"),
    ("has_more", "1", "PAGINATION_INVALID"),
    ("has_more", 2, "PAGINATION_INVALID"),
    ("has_more", 1.0, "PAGINATION_INVALID"),
    ("items", MISSING, "PAGINATION_INVALID"),
    ("items", None, "PAGINATION_INVALID"),
    ("items", {}, "PAGINATION_INVALID"),
    ("items", [], "PAGINATION_INVALID"),
    ("offset", MISSING, "PAGINATION_INVALID"),
    ("offset", None, "PAGINATION_INVALID"),
    ("offset", "", "PAGINATION_INVALID"),
    ("offset", 123, "PAGINATION_INVALID"),
])
def test_broken_page_cannot_claim_success_even_when_first_candidate_reaches_n(field, value, code):
    payload = feed()
    target = payload if field == "data" else payload["data"]
    if value is MISSING:
        del target[field]
    else:
        target[field] = value
    requests = 0
    def handler(request):
        nonlocal requests
        requests += 1
        # 损坏首屏必须立即失败；阻断错误实现的无限翻页。
        return httpx.Response(200, json=payload) if requests == 1 else httpx.Response(503)

    with pytest.raises(DiscoveryError) as caught:
        discover(handler, 1)
    assert caught.value.code == str(caught.value) == code


@pytest.mark.parametrize("has_more", [False, 0])
def test_explicit_empty_end_is_exhaustion(has_more):
    payload = feed("empty")
    payload["data"]["has_more"] = has_more
    assert discover(lambda request: httpx.Response(200, json=payload), 10) == {
        "ids": [], "exhausted": True,
    }


def test_reaching_n_on_terminal_page_does_not_claim_exhaustive_scan():
    payload = feed()
    payload["data"]["has_more"] = False
    assert discover(lambda request: httpx.Response(200, json=payload), 1) == {
        "ids": [FIRST_ID], "exhausted": False,
    }


@pytest.mark.parametrize("offsets,terminal", [
    (["page-2", "page-2"], False),
    (["page-2", "page-3", "page-2"], False),
    (["page-2", "page-2"], True),
])
def test_cursor_repetition_or_cycle_is_failure_not_exhaustion(offsets, terminal):
    pages = []
    for index, offset in enumerate(offsets):
        payload = feed()
        payload["data"]["offset"] = offset
        payload["data"]["has_more"] = not (terminal and index == len(offsets) - 1)
        pages.append(payload)
    def handler(request):
        return httpx.Response(200, json=pages.pop(0)) if pages else httpx.Response(503)

    with pytest.raises(DiscoveryError) as caught:
        discover(handler, 10)
    assert caught.value.code == "PAGINATION_INVALID"


def test_repeated_page_contents_with_advancing_cursor_are_allowed():
    first, repeated, final = feed(), feed(), feed("page2")
    repeated["data"]["offset"] = "page-3"
    final["data"].update(offset="", has_more=False)
    pages = {None: first, "page-2": repeated, "page-3": final}
    assert discover(lambda request: httpx.Response(200, json=pages[request.url.params.get("offset")]), 10) == {
        "ids": [FIRST_ID, "11", "800", "5"], "exhausted": True,
    }


@pytest.mark.parametrize("path,value", [
    (("id_str",), MISSING), (("id_str",), 900), (("id_str",), "0"),
    (("id_str",), "01"), (("id_str",), "-1"), (("id_str",), ""),
    (("id_str",), "1" * 129), (("id_str",), "１２３"),
    (("modules",), MISSING), (("modules",), None), (("modules",), []),
    (("modules", "module_author"), MISSING),
    (("modules", "module_author"), None), (("modules", "module_author"), []),
    (("modules", "module_author", "mid"), MISSING),
    (("modules", "module_author", "mid"), None),
    (("modules", "module_author", "mid"), True),
    (("modules", "module_author", "mid"), 101.0),
    (("modules", "module_author", "mid"), "202"),
    (("modules", "module_author", "mid"), "0101"),
    (("modules", "module_author", "icon_badge"), []),
    (("modules", "module_author", "icon_badge"), "充电专属"),
    (("modules", "module_author", "icon_badge"), {}),
    (("modules", "module_author", "icon_badge"), {"text": 1}),
    (("modules", "module_dynamic"), MISSING),
    (("modules", "module_dynamic"), None), (("modules", "module_dynamic"), []),
    (("modules", "module_dynamic", "major"), "MAJOR_TYPE_BLOCKED"),
    (("modules", "module_dynamic", "major"), []),
    (("modules", "module_dynamic", "major"), {}),
    (("modules", "module_dynamic", "major"), {"type": None}),
])
def test_invalid_identity_or_signal_is_not_silently_an_ineligible_candidate(path, value):
    payload = feed()
    target = payload["data"]["items"][0]
    for part in path[:-1]:
        target = target[part]
    if value is MISSING:
        del target[path[-1]]
    else:
        target[path[-1]] = value
    with pytest.raises(DiscoveryError) as caught:
        discover(lambda request: httpx.Response(200, json=payload), 1)
    assert caught.value.code == str(caught.value) == "SIGNAL_INVALID"


@pytest.mark.parametrize("item", [None, [], "FICTIONAL_SECRET", {}])
def test_malformed_item_after_enough_candidates_invalidates_requested_page(item):
    payload = feed()
    payload["data"]["items"].append(item)
    with pytest.raises(DiscoveryError) as caught:
        discover(lambda request: httpx.Response(200, json=payload), 1)
    assert caught.value.code == "SIGNAL_INVALID"


def test_optional_signals_and_unrelated_content_types_do_not_add_charge_conditions():
    payload = feed()
    badge, blocked = payload["data"]["items"][1], payload["data"]["items"][4]
    # 标识 OR blocked 原样保留：不读取正文、不自行过滤视频/转发。
    badge["type"] = "DYNAMIC_TYPE_AV"
    badge["modules"]["module_dynamic"]["major"]["type"] = "MAJOR_TYPE_ARCHIVE"
    blocked["type"] = "DYNAMIC_TYPE_FORWARD"
    badge["modules"]["module_author"]["mid"] = UID
    no_major = json.loads(json.dumps(badge))
    no_major["id_str"] = "33"
    del no_major["modules"]["module_dynamic"]["major"]
    null_major = json.loads(json.dumps(no_major))
    null_major["id_str"] = "44"
    null_major["modules"]["module_dynamic"]["major"] = None
    null_badge = json.loads(json.dumps(blocked))
    null_badge["id_str"] = "55"
    null_badge["modules"]["module_author"]["icon_badge"] = None
    payload["data"]["items"] += [no_major, null_major, null_badge]
    payload["data"]["has_more"] = False
    assert discover(lambda request: httpx.Response(200, json=payload), 10) == {
        "ids": [FIRST_ID, "11", "33", "44", "55"], "exhausted": True,
    }


@pytest.mark.parametrize("stop_before", [1, 2])
def test_async_stop_gate_is_checked_before_every_new_page_request(stop_before):
    checks = 0
    async def should_continue():
        nonlocal checks
        checks += 1
        return checks < stop_before

    def handler(request):
        assert checks == 1 and stop_before == 2
        assert "offset" not in request.url.params
        return httpx.Response(200, json=feed())

    with pytest.raises(DiscoveryStopped):
        discover(handler, 10, should_continue=should_continue)
    assert checks == stop_before


def test_actual_task_cancellation_propagates_for_interrupted_attempt_recovery():
    import asyncio
    async def run():
        started = asyncio.Event()
        async def handler(request):
            started.set()
            await asyncio.Event().wait()
            pytest.fail("cancelled discovery must not resume")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            task = asyncio.create_task(discover_recent(client, UID, 10))
            await started.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
    anyio.run(run)


def test_async_progress_reports_cumulative_copies_separately_from_final_success():
    snapshots, delivered = [], []
    async def on_progress(ids):
        snapshots.append(ids.copy())
        delivered.append(ids)
        ids.append("999")  # 回调不能修改发现内部集合，也不能污染下页累计结果。

    def handler(request):
        offset = request.url.params.get("offset")
        assert len(snapshots) == (0 if offset is None else 1)
        if offset == "page-2":
            return httpx.Response(200, json=feed("page2"))
        assert offset is None  # 凑够 N 后绝不请求第三页。
        return httpx.Response(200, json=feed())

    result = discover(handler, 3, on_progress=on_progress)
    assert snapshots == [[FIRST_ID, "11"], [FIRST_ID, "11", "800"]]
    assert result == {"ids": [FIRST_ID, "11", "800"], "exhausted": False}
    delivered[-1].clear()
    assert result["ids"] == [FIRST_ID, "11", "800"]


@pytest.mark.parametrize("failure,code", [
    ("http", "SOURCE_UNAVAILABLE"),
    ("business", "SOURCE_UNAVAILABLE"),
    ("item", "SIGNAL_INVALID"),
    ("pagination", "PAGINATION_INVALID"),
    ("cursor", "PAGINATION_INVALID"),
])
def test_mid_scan_failure_preserves_only_prior_page_progress_not_success(failure, code):
    snapshots = []
    async def on_progress(ids):
        snapshots.append(ids)
    def handler(request):
        if "offset" not in request.url.params:
            return httpx.Response(200, json=feed())
        if failure == "http":
            return httpx.Response(503, text="FICTIONAL_SECRET")
        payload = feed("page2")
        if failure == "business":
            payload.update(code=-101, message="FICTIONAL_SECRET")
        elif failure == "item":
            del payload["data"]["items"][-1]["id_str"]
        elif failure == "pagination":
            del payload["data"]["has_more"]
        elif failure == "cursor":
            payload["data"]["offset"] = "page-2"
        return httpx.Response(200, json=payload)

    with pytest.raises(DiscoveryError) as caught:
        discover(handler, 10, on_progress=on_progress)
    assert caught.value.code == code
    assert snapshots == [[FIRST_ID, "11"]]


def test_progress_can_persist_page_then_disable_before_next_request():
    enabled, snapshots = True, []
    async def should_continue():
        return enabled
    async def on_progress(ids):
        nonlocal enabled
        snapshots.append(ids)
        enabled = False
    def handler(request):
        assert "offset" not in request.url.params
        return httpx.Response(200, json=feed())

    with pytest.raises(DiscoveryStopped):
        discover(handler, 10, should_continue=should_continue, on_progress=on_progress)
    assert snapshots == [[FIRST_ID, "11"]]


@pytest.mark.parametrize("uid,n", [
    (UID, 0), (UID, -1), (UID, True), (UID, 1.0), (UID, "10"),
    (101, 1), ("0", 1), ("0101", 1), (None, 1),
])
def test_invalid_inputs_fail_safely_before_any_source_request(uid, n):
    def handler(request):
        pytest.fail("invalid input must not reach upstream")
    with pytest.raises(DiscoveryError) as caught:
        discover(handler, n, uid=uid)
    assert caught.value.code == "SIGNAL_INVALID"


def test_multiple_ups_independent_n_over_100_reuse_injected_client_without_caps():
    async def run():
        def handler(request):
            uid = request.url.params["host_mid"]
            assert "offset" not in request.url.params
            payload = feed()
            template = payload["data"]["items"][1]
            items = []
            for index in range(120):
                item = json.loads(json.dumps(template))
                item["id_str"] = f"{uid}{1000 - index}"
                item["modules"]["module_author"]["mid"] = int(uid)
                items.append(item)
            payload["data"].update(items=items, has_more=False, offset="")
            return httpx.Response(200, json=payload)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            for uid, n in [("101", 1), ("202", 3), ("303", 101), ("404", 110), ("505", 120), ("606", 121)]:
                result = await discover_recent(client, uid, n)
                assert result == {
                    "ids": [f"{uid}{1000 - index}" for index in range(min(n, 120))],
                    "exhausted": n > 120,
                }
    anyio.run(run)
