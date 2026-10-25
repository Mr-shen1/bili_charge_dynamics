"""评论会话按 UP 复用：预热按 TTL 缓存，Cookie 变化或会话 TTL 到期才重建。"""

import asyncio

from backend.bili_monitor.comment_client import RequestsCommentClientFactory, WarmupCache


class FakeClock:
    def __init__(self):
        self.value = 0.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class FakeClient:
    def __init__(self, uid):
        self.uid = uid
        self.prepared = 0
        self.closed = False
        self.fail_prepare = False

    async def prepare(self):
        if self.fail_prepare:
            raise RuntimeError("warmup failed")
        self.prepared += 1

    async def aclose(self):
        self.closed = True


def make_factory(clock, **kwargs):
    created = []

    def new_client(uid, pairs, pacer):
        client = FakeClient(uid)
        created.append(client)
        return client

    factory = RequestsCommentClientFactory(
        cookie_pairs=(("SESSDATA", "a"),), client_factory=new_client,
        warmup=WarmupCache(clock=clock), clock=clock, **kwargs)
    return factory, created


async def eventually(predicate, timeout=1.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


def test_same_up_reuses_one_session_and_one_warmup():
    clock = FakeClock()
    factory, created = make_factory(clock)

    async def scenario():
        async with factory("111") as first:
            pass
        async with factory("111") as second:
            pass
        async with factory("222") as other:
            pass
        assert first is second
        assert other is not first
        assert [client.uid for client in created] == ["111", "222"]
        assert [client.prepared for client in created] == [1, 1]
        await factory.aclose()

    asyncio.run(scenario())


def test_warmup_refreshes_in_background_after_ttl():
    clock = FakeClock()
    factory, created = make_factory(clock)

    async def scenario():
        async with factory("111") as client:
            pass
        assert client.prepared == 1
        clock.advance(301)          # 超过预热 TTL：后台刷新，不阻塞本次请求
        async with factory("111") as again:
            assert again is client
            assert client.prepared == 1
        await eventually(lambda: client.prepared == 2)
        await factory.aclose()

    asyncio.run(scenario())


def test_cookie_change_rebuilds_session():
    clock = FakeClock()
    factory, created = make_factory(clock)

    async def scenario():
        async with factory("111") as first:
            pass
        factory.cookie_pairs = (("SESSDATA", "b"),)
        async with factory("111") as second:
            assert second is not first
            assert first.closed is True
            assert second.prepared == 1
        await factory.aclose()

    asyncio.run(scenario())


def test_session_rotates_after_ttl():
    clock = FakeClock()
    factory, created = make_factory(clock, session_ttl=30)

    async def scenario():
        async with factory("111") as first:
            pass
        clock.advance(31)
        async with factory("111") as second:
            assert second is not first
            assert first.closed is True
        await factory.aclose()

    asyncio.run(scenario())


def test_failed_warmup_waits_for_retry_window():
    clock = FakeClock()
    factory, created = make_factory(clock)

    async def scenario():
        client = FakeClient("111")
        client.fail_prepare = True
        created.append(client)
        factory._new_client = lambda uid, pairs, pacer: client
        async with factory("111"):
            pass
        assert client.prepared == 0
        attempts_before = factory.warmup._attempted[("111", factory._fingerprint())]
        clock.advance(10)           # 冷却期内不重试
        async with factory("111"):
            pass
        assert factory.warmup._attempted[("111", factory._fingerprint())] == attempts_before
        clock.advance(60)           # 冷却结束后再试一次
        async with factory("111"):
            pass
        await eventually(lambda: factory.warmup._attempted[("111", factory._fingerprint())] != attempts_before)
        await factory.aclose()

    asyncio.run(scenario())


def test_aclose_closes_sessions_and_cancels_warmup():
    clock = FakeClock()
    factory, created = make_factory(clock)

    async def scenario():
        async with factory("111"):
            pass
        clock.advance(301)
        async with factory("111"):
            pass
        await factory.aclose()
        assert all(client.closed for client in created)
        assert factory.warmup._tasks == {}

    asyncio.run(scenario())
