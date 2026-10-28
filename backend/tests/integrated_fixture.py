"""10 组合装配：真实 API／独立采集／独立通知三进程与同一临时 SQLite。

只替换外部边界：B 站来源（HTTPX 与 Requests 两条真实发送路径）、图片 CDN、OSS
上传和飞书 HTTP。生产解析、检查、单路重型调度、发送／目标租约、风控状态机、探测、
归档提交、发件箱与投递调度全部使用真实实现；时间可通过 `clock.txt` 跨进程受控。

角色（`INTEGRATED_ROLE` 或 `--task`）：

- `api`：`uvicorn backend.tests.integrated_fixture:create_app --factory`；生产 API 装配。
- `collector`：`python -m backend.tests.integrated_fixture --database <db>`；生产采集循环。
- `trigger`／`claim`／`finish`／`observe`：一次性真实进程，用生产 `RiskGate` 在共享库上
  触发风控、领取／结束探测轮次或提交观察心跳；用来在真实进程边界上验证 owner 租约、
  旧 owner fencing、重启保留与 599／600 秒边界。
- 通知进程不由本模块启动；测试使用 `subprocess` 调生产入口
  `python -m backend.bili_monitor.notifier`（见 `notification_process_support.NotifierProcess`）。

控制文件（`INTEGRATED_DIR`）：

- `state.json`：按动态声明正文版本、根评论数、楼中楼回复数、媒体与受控失败页。
- `clock.txt`：UTC epoch 秒；缺失时使用真实时间（采集节拍/风控期限同源）。
- `ledger.txt`：每次真实来源发送记录「角色 类型 页码 send|done 时间 oid」，跨进程加锁追加。
- `risk.arm`：空白分隔的 `[角色:]类型`；命中角色的该接口返回 HTTP 412。
- `probe.fail`：空白分隔的接口类型；探测请求返回 HTTP 412。
- `hold.<类型>.<页码>`：存在时对应来源请求在发送后阻塞，直到文件删除（用于中途杀进程）。
- `upload.hold`：存在时 OSS 上传阻塞；上传期间风控可被触发，用来证明已下载内容的
  提交与 OSS 上传不受保护暂停影响。`uploads.txt` 记录完成的上传。

不读取 `.env`、不创建真实 OSS／B 站／飞书客户端，未命中任何已知虚构请求直接失败，
不会把未知请求落到真实网络。
"""

import argparse
import asyncio
import copy
import fcntl
import json
import os
from pathlib import Path
import signal
import time

import httpx
import requests

from backend.bili_monitor.app import create_app as production_app
from backend.bili_monitor.collector import open_collector
from backend.bili_monitor.media import is_archive_delivery_url
from backend.bili_monitor.risk import RiskGate, format_epoch
from backend.bili_monitor.safety import configure_safe_logging
from backend.bili_monitor.source_gate import SourceReport, source_request
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import readable_html
from backend.tests.root_notification_support import detail_item, reply_item, root_comment


DIRECTORY = Path(os.environ["INTEGRATED_DIR"]) if os.environ.get("INTEGRATED_DIR") else None
ROLE = os.environ.get("INTEGRATED_ROLE", "api")
UID = "202"
TARGETS = tuple(f"9100{index}" for index in range(1, 9))
HUGE = "91001"
MEDIA_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x04\x00\x00\x00"
    b"\xb5\x1c\x0c\x02\x00\x00\x00\x0bIDATx\xdac\xfc\xff\x1f\x00\x03\x03\x02\x00\xef\xa3E\x99"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)
# 固定“未来”发表时间：晚于任何真实通知起点，新增根评论才可被投递。
FUTURE_CTIME = 1798732800
# 基线内容用更早的固定发表时间：首次归档只建立通知基线，不补发历史消息。
BASELINE_CTIME = 1_700_000_000


class FileClock:
    """跨进程受控时钟：所有进程读同一个 `clock.txt`；缺失时退回真实时间。"""

    def __init__(self, directory):
        self.path = Path(directory) / "clock.txt" if directory is not None else None

    def _epoch(self):
        if self.path is None:
            return None
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
        override = os.environ.get("INTEGRATED_CLOCK_SLEEP")
        if override:
            seconds = float(override)
        await asyncio.sleep(seconds)


def state_path():
    return Path(os.environ["INTEGRATED_STATE"]) if os.environ.get("INTEGRATED_STATE") else (
        DIRECTORY / "state.json" if DIRECTORY is not None else None)


def load_state():
    path = state_path()
    if path is None:
        return {"dynamics": {}}
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {"dynamics": {}}


def controlled(name, directory=None):
    base = directory if directory is not None else DIRECTORY
    path = (Path(base) / name) if base is not None else None
    if path is None or not path.exists():
        return set()
    return set(path.read_text().split())


def armed(kind, role, directory=None):
    for token in controlled("risk.arm", directory):
        expected_role, _, expected_kind = token.partition(":")
        if not expected_kind:
            expected_role, expected_kind = "", expected_role
        if expected_kind == kind and (not expected_role or expected_role == role):
            return True
    return False



def holding(kind, page, directory=None):
    base = directory if directory is not None else DIRECTORY
    path = (Path(base) / f"hold.{kind}.{page}") if base is not None else None
    return path is not None and path.exists()


def ledger(kind, page, phase, oid="", *, directory=None, role=None):
    base = directory if directory is not None else DIRECTORY
    path = (Path(base) / "ledger.txt") if base is not None else None
    if path is None:
        return
    with path.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            handle.write(f"{role or ROLE} {kind} {page or '-'} {phase} {time.time():.6f} {oid or '-'}\n")
            handle.flush()
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def source_count(spec):
    """来源总评论数：根评论与楼中楼回复之和，用于计数变化与页 acount。"""
    replies = int(spec.get("replies", 0)) if spec.get("reply_root", True) else 0
    return int(spec.get("roots", 0)) + replies


def root_id(dynamic, index):
    return str(860000 + int(dynamic[-2:]) * 20 + index)


def reply_id(dynamic, index):
    return str(970000000000000000 + int(dynamic[-2:]) * 100000 + index)


def locator(spec, dynamic):
    """locator 可切换：默认 basic（99 + 动态），`locator_type=11` 时用动态 ID 兜底。"""
    if int(spec.get("locator_type", 17)) == 11:
        return dynamic, 11
    return "99" + dynamic, 17


def root_items(dynamic, spec):
    total = int(spec.get("roots", 0))
    oid, kind = locator(spec, dynamic)
    replies = int(spec.get("replies", 0)) if spec.get("reply_root", True) else 0
    fresh = set(spec.get("fresh_roots") or ())
    items = []
    # 新根排在最前：插入新根就是一次真实的页移动，后续根被挤到下一页。
    for index in range(total, 0, -1):
        item = root_comment(
            int(root_id(dynamic, index)), author=spec.get("uid", UID),
            nickname=spec.get("name", "虚构组合作者"),
            ctime=(FUTURE_CTIME if index in fresh else BASELINE_CTIME) + index,
            text=f"虚构一级评论 {index}",
            pictures=(), rcount=replies if index == 1 else 0, like=total - index)
        item["oid"], item["type"] = int(oid), kind
        items.append(item)
    return items


def reply_items(dynamic, spec, start, stop):
    oid, kind = locator(spec, dynamic)
    root = root_id(dynamic, 1)
    fresh = set(spec.get("fresh_replies") or ())
    items = []
    for index in range(start, stop + 1):
        item = reply_item(
            int(reply_id(dynamic, index)), root=root, author=spec.get("uid", UID),
            nickname="虚构回复者",
            ctime=(FUTURE_CTIME if index in fresh else BASELINE_CTIME) + index,
            text=f"虚构楼中楼回复 {index}")
        item["oid"], item["type"] = int(oid), kind
        items.append(item)
    return items


def body_html(dynamic, spec):
    pictures = [{"url": f"https://i0.hdslb.com/integrated/{dynamic}.png",
                 "width": 640, "height": 480}] if spec.get("media") else []
    html = readable_html(text=spec.get("text", f"虚构正文 {dynamic}"),
                         title=spec.get("title"), id=dynamic, pictures=pictures)
    return html.replace('"mid":"900719925474099312345"', f'"mid":"{spec.get("uid", UID)}"')


def detail_payload(dynamic, spec):
    payload = detail_item(dynamic, spec.get("uid", UID), source_count(spec))
    oid, kind = locator(spec, dynamic)
    payload["data"]["item"]["basic"] = {
        "comment_id_str": oid, "comment_type": kind, "rid_str": oid}
    payload["data"]["item"]["modules"]["module_author"]["pub_ts"] = FUTURE_CTIME
    return payload


class Source:
    """虚构来源：接口形状取自已版本化样本，按状态文件应答；不访问真实网络。"""

    def __init__(self, role, *, directory=None, state=None):
        self.role = role
        self.directory = directory if directory is not None else DIRECTORY
        self.state = state

    def _armed(self, kind):
        return armed(kind, self.role, self.directory)

    def _state(self):
        if self.state is None:
            return load_state().get("dynamics") or {}
        return self.state.get("dynamics") or self.state

    # ---- 应答 ----

    def payload(self, method, url, *, page=None):
        return self._payload(method, str(url), page)

    def _payload(self, method, url, page=None):
        if method != "GET":
            raise RuntimeError("Unexpected fixture method")
        state = self._state()
        classified = source_request("GET", url)
        kind = classified.endpoint_type if classified is not None else ""
        parsed = httpx.URL(url)
        params = dict(parsed.params)
        path = parsed.path
        if self._armed(kind) or kind in controlled("probe.fail", self.directory):
            return httpx.Response(412, text="")
        if kind == "image_hdslb" or (parsed.host or "").endswith("hdslb.com"):
            return httpx.Response(200, content=MEDIA_BYTES, headers={"content-type": "image/png"})
        if path == "/x/web-interface/card":
            return httpx.Response(200, json={"code": 0, "data": {"card": {
                "mid": params.get("mid", UID), "name": "虚构组合作者",
                "face": "https://example.invalid/avatar.png"}}})
        if path == "/":
            return httpx.Response(200, text="<html></html>")
        if path.endswith("/dynamic") and path.startswith("/"):
            return httpx.Response(200, text="<html></html>")
        if path.startswith("/opus/"):
            dynamic = path.rsplit("/", 1)[-1]
            spec = state.get(dynamic)
            if spec is None:
                return httpx.Response(404)
            if spec.get("page_fail"):
                return httpx.Response(500, text="")
            return httpx.Response(200, text=body_html(dynamic, spec),
                                  headers={"content-type": "text/html"})
        if path == "/x/polymer/web-dynamic/v1/detail":
            dynamic = params.get("id", "")
            spec = state.get(dynamic)
            if spec is None:
                return httpx.Response(404)
            return httpx.Response(200, json=detail_payload(dynamic, spec))
        dynamic = params.get("oid", "")
        spec = state.get(dynamic)
        if spec is None:
            for candidate in state:
                if params.get("oid") in (candidate, "99" + candidate):
                    dynamic, spec = candidate, state[candidate]
                    break
        if spec is None:
            raise RuntimeError("Unexpected fixture source request")
        number = int(params.get("pn", "1"))
        if path == "/x/v2/reply/count":
            return httpx.Response(200, json={"code": 0, "data": {"count": source_count(spec)}})
        if path == "/x/v2/reply":
            if number in set(spec.get("fail_pages") or ()):
                return httpx.Response(500, json={"code": -500})
            items = root_items(dynamic, spec)
            return httpx.Response(200, json={"code": 0, "data": {
                "page": {"num": number, "size": 20, "count": len(items), "acount": len(items)},
                "upper": {"mid": int(spec.get("uid", UID)), "top": None}, "hots": [],
                "replies": copy.deepcopy(items[(number - 1) * 20:number * 20]) or None,
            }})
        if path == "/x/v2/reply/reply":
            if number in set(spec.get("fail_reply_pages") or ()):
                return httpx.Response(500, json={"code": -500})
            root = next((item for item in root_items(dynamic, spec)
                         if item["rpid_str"] == str(params.get("root"))), None)
            if root is None:
                return httpx.Response(404)
            total = int(spec.get("replies", 0)) if spec.get("reply_root", True) else 0
            start = (number - 1) * 20 + 1
            stop = min(number * 20, total)
            items = reply_items(dynamic, spec, start, stop) if start <= stop else []
            payload_root = copy.deepcopy(root)
            payload_root["rcount"] = total
            return httpx.Response(200, json={"code": 0, "data": {
                "page": {"num": number, "size": 20, "count": total},
                "root": payload_root, "replies": copy.deepcopy(items) or None,
            }})
        raise RuntimeError("Unexpected fixture source request")


def _sync_wait(kind, page, directory=None):
    while holding(kind, page, directory):
        time.sleep(0.01)


async def _async_wait(kind, page, directory=None):
    while holding(kind, page, directory):
        await asyncio.sleep(0.01)


def _page_of(url):
    params = dict(httpx.URL(str(url)).params)
    return params.get("pn")


class AsyncSource:
    """HTTPX 侧入口：记账、受控阻塞与状态应答。"""

    def __init__(self, source, *, directory=None, role=None, record=None):
        self.source = source
        self.directory = directory if directory is not None else DIRECTORY
        self.role = role or source.role
        self.record = record

    def _record(self, kind, page, phase, oid):
        if self.record is not None:
            self.record(self.role, kind, page, phase, oid)
        else:
            ledger(kind, page, phase, oid, directory=self.directory, role=self.role)

    async def __call__(self, request):
        classified = source_request(request.method, request.url)
        kind = classified.endpoint_type if classified is not None else ""
        page = _page_of(request.url)
        oid = dict(request.url.params).get("oid", "")
        if classified is not None:
            self._record(kind, page, "send", oid)
        await _async_wait(kind, page, self.directory)
        response = self.source.payload(request.method, request.url, page=page)
        if classified is not None:
            self._record(kind, page, "done", oid)
        return response


def _response_for(kind, page, oid, response, url):
    record = requests.Response()
    record.status_code = response.status_code
    record.headers.update({key: value for key, value in response.headers.items()})
    record._content = response.content
    record._content_consumed = True
    record.url = url
    record.history = []
    return record


def install_requests(source, *, directory=None, role=None, record=None):
    """把 Requests 会话接到同一虚构来源；保留 `_SourceSession.send` 的许可与报告。"""

    base = directory if directory is not None else DIRECTORY
    actor = role or source.role

    def note(kind, page, phase, oid):
        if record is not None:
            record(actor, kind, page, phase, oid)
        else:
            ledger(kind, page, phase, oid, directory=base, role=actor)

    def send(session, request, **kwargs):
        classified = source_request(request.method, request.url)
        kind = classified.endpoint_type if classified is not None else ""
        page = dict(httpx.URL(request.url).params).get("pn")
        oid = dict(httpx.URL(request.url).params).get("oid", "")
        if classified is not None:
            note(kind, page, "send", oid)
        _sync_wait(kind, page, base)
        response = source.payload(request.method, request.url, page=page)
        if classified is not None:
            note(kind, page, "done", oid)
        return _response_for(kind, page, oid, response, request.url)

    return send


def install_httpx(source):
    async def handle(transport, request):
        return await source(request)

    httpx.AsyncHTTPTransport.handle_async_request = handle


class Uploader:
    """OSS 替身：阻塞可受控，完成时记账；不访问真实对象存储。"""

    def __init__(self, role):
        self.role = role

    async def upload(self, key, content, content_type):
        if content != MEDIA_BYTES or content_type != "image/png":
            raise RuntimeError("Unexpected fixture upload")
        if DIRECTORY is not None:
            (DIRECTORY / "upload.blocked").write_text(self.role)
            while (DIRECTORY / "upload.hold").exists():
                await asyncio.sleep(0.01)
        url = f"https://media.example.invalid/{key}"
        if not is_archive_delivery_url(url):
            raise RuntimeError("Invalid fixture media URL")
        if DIRECTORY is not None:
            with (DIRECTORY / "uploads.txt").open("a") as handle:
                handle.write(f"{self.role} {key} {time.time():.6f}\n")
        return url

    async def close(self):
        return None


def create_app():
    database = os.environ.get("BILI_DATABASE_PATH")
    if not database:
        raise RuntimeError("BILI_DATABASE_PATH is required for the integrated fixture")
    clock = FileClock(DIRECTORY)
    source = Source("api")
    async_source = AsyncSource(source)
    install_httpx(async_source)
    requests.Session.send = install_requests(source)
    return production_app(database, media_transport=httpx.MockTransport(async_source),
                          media_uploader=Uploader("api"), risk_clock=clock)


async def serve(database):
    configure_safe_logging()
    clock = FileClock(DIRECTORY)
    source = Source("collector")
    async_source = AsyncSource(source)
    install_httpx(async_source)
    requests.Session.send = install_requests(source)
    async with open_collector(
            database, source_transport=httpx.MockTransport(async_source),
            media_transport=httpx.MockTransport(async_source),
            media_uploader=Uploader("collector"), clock=clock, risk_clock=clock) as collector:
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


def open_gate(database):
    store = Store(database)
    store.migrate()
    return store, RiskGate(store, clock=FileClock(DIRECTORY))


def trigger(database, path, status_code):
    _, gate = open_gate(database)
    classified = source_request("GET", f"https://api.bilibili.com{path}")
    try:
        asyncio.run(gate.report(classified, SourceReport(status_code=status_code)))
    except Exception:
        pass
    print(json.dumps(gate.status(), sort_keys=True))


def claim(database, types):
    _, gate = open_gate(database)
    print(json.dumps(asyncio.run(gate.claim_probe(types)), sort_keys=True))


def finish(database, round_id, owner, passed):
    _, gate = open_gate(database)
    status = asyncio.run(gate.finish_probe(
        {"round": round_id, "owner": owner}, passed == "true"))
    print(json.dumps(status, sort_keys=True))


def observe(database, seconds):
    """模拟采集进程的一次成功业务请求＋一拍观察心跳；不伪造 HTTP 传输事实。"""
    _, gate = open_gate(database)
    gate.note_business_success("comment_count")
    print(json.dumps(asyncio.run(gate.observing_tick(seconds)), sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description="Isolated integrated risk-control fixture")
    parser.add_argument("--database", required=True)
    parser.add_argument("--task",
                        choices=("collector", "trigger", "claim", "finish", "observe"),
                        default="collector")
    parser.add_argument("--path", default="/x/v2/reply/count")
    parser.add_argument("--status", type=int, default=412)
    parser.add_argument("--types", default="")
    parser.add_argument("--round", default="")
    parser.add_argument("--owner", default="")
    parser.add_argument("--passed", default="true")
    parser.add_argument("--seconds", type=float, default=0)
    arguments = parser.parse_args()
    try:
        if arguments.task == "trigger":
            trigger(arguments.database, arguments.path, arguments.status)
        elif arguments.task == "claim":
            claim(arguments.database, [kind for kind in arguments.types.split(",") if kind])
        elif arguments.task == "finish":
            finish(arguments.database, arguments.round, arguments.owner, arguments.passed)
        elif arguments.task == "observe":
            observe(arguments.database, arguments.seconds)
        else:
            asyncio.run(serve(arguments.database))
    except KeyboardInterrupt:
        pass
    except Exception:
        raise SystemExit("Integrated fixture failed") from None


if __name__ == "__main__":
    main()
