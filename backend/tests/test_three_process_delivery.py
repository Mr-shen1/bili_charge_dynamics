"""10：真实 API＋独立采集＋独立通知三个进程共享一个临时 SQLite 的组合回归。

页面、检查/归档写事务、通知阶段/候选/事件、发件箱与投递调度都走生产实现；只替换
外部来源、媒体传输、上传与飞书 HTTP。通知进程是本机受控 HTTP 接收端之前的真实
子进程（生产入口 `python -m backend.bili_monitor.notifier`），采集进程是
`python -m backend.tests.delivery_fixture`（真实 Collector 锁、节拍与信号处理），
API 是真实 FastAPI 应用（仅注入受控来源/媒体传输）。身份、动态、评论、媒体与凭据
全部虚构；不读取真实配置，也不访问真实 B 站、飞书或 OSS。
"""

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import httpx
import pytest

from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_content
from backend.tests.notification_process_support import FeishuStub, NotifierProcess, wait_for
from backend.tests.notification_support import deliveries, events, message_text, query

ROOT = Path(__file__).resolve().parents[2]
DYNAMIC = "123"
OTHER_DYNAMIC = "124"
UP = "202"
OTHER_UP = "707"
TITLE = "虚构三进程标题"
BASE_URL = "https://archive.example.invalid"
SECRET = "FAKE_DELIVERY_SECRET_10_NEVER_REAL"


def mapping(*, rooms=True, extra=None):
    """两个 UP 的默认双群路由＋系统群；目的地只存引用，凭据仍只在 destinations。"""
    destinations = {
        "up-202": {"webhook": extra["up-202"]},
        "all-202": {"webhook": extra["all-202"]},
        "up-707": {"webhook": extra["up-707"]},
        "all-707": {"webhook": extra["all-707"]},
        "system-10": {"webhook": extra["system-10"]},
    }
    ups = {UP: {"up": "up-202"}, OTHER_UP: {"up": "up-707"}}
    if rooms:
        ups[UP]["all"] = "all-202"
        ups[OTHER_UP]["all"] = "all-707"
    return {"base_url": BASE_URL, "ups": ups, "system": "system-10", "destinations": destinations}


def state(*, version="v1", comments=None, other_comments=None):
    """受控来源状态：正文版本、标题与两个 UP 的评论集合。"""
    return {"dynamics": {
        DYNAMIC: {
            "uid": UP, "name": "虚构晨光", "title": TITLE, "version": version,
            "text": "第一版正文" if version == "v1" else "第二版正文",
            "comments": comments or {},
        },
        OTHER_DYNAMIC: {
            "uid": OTHER_UP, "name": "虚构晚风", "title": None, "version": version,
            "text": "另一条第一版正文" if version == "v1" else "另一条第二版正文",
            "comments": other_comments or {},
        },
    }}


class Stack:
    """三进程临时装配：临时 SQLite、状态文件与真实 HTTP 端口，全部在本次运行内。"""

    def __init__(self, directory):
        self.directory = directory
        self.database = directory / "delivery.sqlite"
        self.state_file = directory / "state.json"
        self.requests_log = directory / "api-source-requests.log"
        self.collector_requests_log = directory / "collector-source-requests.log"
        self.config_path = directory / "notifications.json"
        self.environment = {
            name: value for name, value in os.environ.items()
            if not name.startswith(("BILI_", "DELIVERY_", "DEPLOYMENT_FIXTURE_", "UVICORN_"))
            and name != "WEB_CONCURRENCY"
        }
        self.environment.update({
            "BILI_DATABASE_PATH": str(self.database),
            "DELIVERY_FIXTURE_STATE": str(self.state_file),
            "DELIVERY_FIXTURE_REQUESTS": str(self.requests_log),
            "BILI_COLLECTOR_CADENCE_SECONDS": "1",
            "BILI_COLLECTOR_PAGE_CHECK_SECONDS": "0",
            "PYTHONUNBUFFERED": "1",
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
        })
        self.processes = {}
        self.logs = {}
        self.client = None

    def write_state(self, value):
        temporary = self.state_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False))
        temporary.replace(self.state_file)

    def write_config(self, value):
        temporary = self.config_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False))
        temporary.replace(self.config_path)

    def spawn(self, name, *arguments):
        log = self.directory / f"{name}.log"
        with log.open("wb") as output:
            process = subprocess.Popen(
                [sys.executable, *arguments], cwd=ROOT, env=self.environment,
                stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
            )
        self.processes[name] = process
        self.logs[name] = log
        return process

    def start_api(self):
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        self.api = self.spawn(
            "api", "-m", "uvicorn", "backend.tests.delivery_fixture:create_app", "--factory",
            "--host", "127.0.0.1", "--port", str(port),
        )
        self.client = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=5, trust_env=False)
        self.wait(lambda: self.client.get("/api/manage/ups").status_code == 200,
                  self.processes["api"], 15)
        return self.client

    def start_collector(self):
        # 采集进程按固定节拍持续采样；单独记账，避免混进“只读读取不触发采集”的断言。
        environment = dict(self.environment, DELIVERY_FIXTURE_REQUESTS=str(self.collector_requests_log))
        log = self.directory / "collector.log"
        self.logs["collector"] = log
        with log.open("wb") as output:
            process = subprocess.Popen(
                [sys.executable, "-m", "backend.tests.delivery_fixture", "--database", str(self.database)],
                cwd=ROOT, env=environment, stdin=subprocess.DEVNULL,
                stdout=output, stderr=subprocess.STDOUT,
            )
        self.processes["collector"] = process
        return process

    def start_notifier(self, *, name="notifier", lease=None, config=None):
        environment = {"NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}
        if lease is not None:
            environment["BILI_NOTIFIER_LEASE_SECONDS"] = str(lease)
        process = NotifierProcess(self.directory, self.database, config or self.config_path, **environment)
        # 复用真实通知进程夹具的日志命名，登记到本栈方便统一收尾。
        key = f"notifier-{len([key for key in self.processes if key.startswith('notifier')])}"
        self.processes[key] = process
        return process

    def stop(self, process, *, kill=False):
        if hasattr(process, "handle"):
            process.kill() if kill else process.stop()
        elif process.poll() is None:
            process.kill() if kill else process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    def close(self):
        if self.client is not None:
            self.client.close()
        for process in reversed(list(self.processes.values())):
            try:
                self.stop(process, kill=True)
            except Exception:
                pass

    def wait(self, predicate, process=None, timeout=25, description=""):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if process is not None and not self._running(process):
                pytest.fail(f"进程提前退出：{self.log_text()}\n{description}")
            try:
                value = predicate()
                if value:
                    return value
            except (httpx.TransportError, httpx.HTTPStatusError):
                pass
            time.sleep(0.05)
        pytest.fail(f"等待超时：{description}\n{self.log_text()}")

    @staticmethod
    def _running(process):
        return process.running if hasattr(process, "running") else process.poll() is None

    def log_text(self):
        return "\n".join(path.read_text() for path in self.logs.values() if path.exists())

    # 管理入口：真实 HTTP 配置，不直接写库。
    def configure(self, uid, dynamic):
        assert self.client.post("/api/manage/ups", json={"uid": uid}).status_code == 201
        assert self.client.patch(f"/api/manage/ups/{uid}/monitor", json={
            "mode": "specified", "recent_n": 10, "enabled": True}).status_code == 200
        assert self.client.post(f"/api/manage/ups/{uid}/targets", json={"id": dynamic}).status_code == 201

    def archive(self, dynamic):
        response = self.client.get(f"/api/archive/dynamics/{dynamic}")
        return response.json() if response.status_code == 200 else None

    def archive_text(self, dynamic):
        return ((self.archive(dynamic) or {}).get("text") or "")

    def source_requests(self):
        """API 进程累计的上游请求：归档/定位读取不应产生任何一条。"""
        return len(self.requests_log.read_text().splitlines()) if self.requests_log.exists() else 0

    def collector_requests(self):
        path = self.collector_requests_log
        return len(path.read_text().splitlines()) if path.exists() else 0


@pytest.fixture
def stack(tmp_path):
    instance = Stack(tmp_path)
    try:
        yield instance
    finally:
        instance.close()


def payload_link(payload):
    for paragraph in payload["content"]["post"]["zh_cn"]["content"]:
        for node in paragraph:
            if node.get("tag") == "a":
                return node["href"]
    return None


def payload_links(payloads):
    return [link for link in (payload_link(payload) for payload in payloads) if link]


def path_of(link):
    return link.split("://", 1)[-1].split("/", 1)[-1]


def states(path):
    return {(row["role"], row["kind"], row["comment_id"]): row["state"] for row in deliveries(path)}


def test_three_process_chain_routes_two_ups_and_opens_real_message_links(stack):
    """实际三进程链：正文变化、一级评论与后续页回复分别归档→真实通知→消息链接可读。"""
    stack.write_state(state())
    stack.start_api()
    stack.configure(UP, DYNAMIC)
    stack.configure(OTHER_UP, OTHER_DYNAMIC)
    stack.start_collector()
    # 首次正文只建立基线：静默，不发送任何消息。
    stack.wait(lambda: "第一版正文" in stack.archive_text(DYNAMIC), None, 20, "v1 正文归档")
    stack.wait(lambda: "另一条第一版正文" in stack.archive_text(OTHER_DYNAMIC), None, 20, "124 v1 正文归档")

    with FeishuStub() as stub:
        stack.write_config(mapping(extra={
            "up-202": stub.url_for("up-202"), "all-202": stub.url_for("all-202"),
            "up-707": stub.url_for("up-707"), "all-707": stub.url_for("all-707"),
            "system-10": stub.url_for("system-10"),
        }))
        notifier = stack.start_notifier()
        time.sleep(1.5)
        assert stub.requests == []  # 首次正文静默，不补发旧版本

        # 第二版正文＋评论/回复集合：第 1 条是 UP 本人、第 30 条是另一 UP 串门、
        # 第 2 条纯图、第 3 条超长；第 2 页首次失败用来证明已提交页仍通知。
        stack.write_state(state(version="v2", comments={
            "size": 45, "fresh": [1, 2, 3], "fresh_other": [30], "pure_image": 2, "long": 3,
            "fail_pages": [2], "reply_root": "860001", "reply_size": 25, "fresh_replies": [22],
        }, other_comments={"size": 1, "fresh": [1]}))
        stack.wait(lambda: "第二版正文" in stack.archive_text(DYNAMIC), notifier, 30, "v2 正文归档")
        stack.wait(lambda: stub.count("up-202") >= 1, notifier, 30, "动态变化进入 UP 群")
        # 第 1 页（含 UP 本人与纯图/超长评论）已提交并投递；第 2 页失败不收回资格。
        stack.wait(lambda: stub.count("all-202") >= 3, notifier, 30, "第 1 页评论投递")
        assert stack.archive(DYNAMIC)["root_comments_error"] in (None, "ROOT_COMMENTS_FAILED")
        assert all("860030" not in (payload_link(payload) or "")
                   for payload in stub.payloads("all-202"))
        # 修复分页后第 2 页归档：串门 UP 的评论只进全员群，不因“是另一个 UP”进 UP 群。
        current = state(version="v2", comments={
            "size": 45, "fresh": [1, 2, 3], "fresh_other": [30], "pure_image": 2, "long": 3,
            "reply_root": "860001", "reply_size": 25, "fresh_replies": [22],
        }, other_comments={"size": 1, "fresh": [1]})
        stack.write_state(current)
        stack.wait(lambda: any("860030" in (payload_link(payload) or "")
                               for payload in stub.payloads("all-202")), notifier, 40, "第 2 页评论投递")
        stack.wait(lambda: any("960022" in (payload_link(payload) or "")
                               for payload in stub.payloads("all-202")), notifier, 40, "后续页回复投递")
        stack.wait(lambda: any("960022" in (payload_link(payload) or "")
                               for payload in stub.payloads("up-202")), notifier, 40, "本人回复进入 UP 群")
        # 124 的正文变化只进其 UP 群；标题缺失时回退动态 ID，不把正文当标题。
        stack.wait(lambda: stub.count("up-707") >= 2, notifier, 40, "124 动态变化与本人评论")
        for token in ("all-707", "up-707"):
            assert all("880300" not in json.dumps(payload, ensure_ascii=False)
                       for payload in stub.payloads(token))

        # 路由矩阵：动态变化只在 UP 群；本人评论双群；他人/串门/纯图/超长只进全员群。
        up_links = payload_links(stub.payloads("up-202"))
        all_links = payload_links(stub.payloads("all-202"))
        assert f"{BASE_URL}/dynamics/{DYNAMIC}" in up_links
        assert f"{BASE_URL}/dynamics/{DYNAMIC}" not in all_links
        assert f"{BASE_URL}/dynamics/{DYNAMIC}/comments/860001/locate" in up_links
        assert f"{BASE_URL}/dynamics/{DYNAMIC}/comments/860001/locate" in all_links
        assert f"{BASE_URL}/dynamics/{DYNAMIC}/comments/860030/locate" not in up_links
        assert f"{BASE_URL}/dynamics/{DYNAMIC}/comments/860030/locate" in all_links
        assert f"{BASE_URL}/dynamics/{DYNAMIC}/comments/860002/locate" in all_links
        reply_path = f"{BASE_URL}/dynamics/{DYNAMIC}/comments/860001/replies/960022/locate"
        assert reply_path in up_links and reply_path in all_links
        other_links = payload_links(stub.payloads("all-707"))
        assert f"{BASE_URL}/dynamics/{OTHER_DYNAMIC}" not in other_links  # 只发 UP 群
        assert f"{BASE_URL}/dynamics/{OTHER_DYNAMIC}/comments/860001/locate" in other_links

        # 模板与快照：标题回退、北京时间到秒、纯图占位、超长截断保留链接、换行保留。
        titles = [message_text(payload) for payload in stub.payloads("up-707")]
        assert any(f"动态【{OTHER_DYNAMIC}】发生变化" in text for text in titles)
        assert any("链接：查看动态" in text for text in titles)
        comments = [message_text(payload) for payload in stub.payloads("all-202")]
        assert any("内容：【图片评论，点击链接查看】" in text for text in comments)
        assert any("……内容过长，点击链接查看全文" in text for text in comments)
        assert any("第二行：换行与 emoji 🙂" in text for text in comments)
        for text in comments:
            assert "时间：" in text
            stamp = next(line for line in text.splitlines() if line.startswith("时间："))
            assert len(stamp.split(" ", 1)[1].split(":")) == 3
        assert SECRET not in json.dumps(deliveries(stack.database), ensure_ascii=False)

        # 用投递产物里的实际链接读取真实 API：动态详情、后续批一级评论、后续页回复。
        assert path_of(f"{BASE_URL}/dynamics/{DYNAMIC}") == f"dynamics/{DYNAMIC}"
        assert stack.client.get(f"/api/archive/dynamics/{DYNAMIC}").status_code == 200
        locate_root = path_of(f"{BASE_URL}/dynamics/{DYNAMIC}/comments/860030/locate")
        assert locate_root == f"dynamics/{DYNAMIC}/comments/860030/locate"
        locate_reply = path_of(reply_path)
        assert locate_reply == f"dynamics/{DYNAMIC}/comments/860001/replies/960022/locate"
        comments_api = stack.client.get(f"/api/archive/dynamics/{DYNAMIC}/comments/860030/location?sort=hot")
        assert comments_api.status_code == 200
        assert comments_api.json()["items"][0]["id"] == "860030"
        reply_api = stack.client.get(
            f"/api/archive/dynamics/{DYNAMIC}/comments/860001/replies/960022/location")
        assert reply_api.status_code == 200
        assert reply_api.json()["page"] == 3
        assert reply_api.json()["items"][-1]["id"] == "960022"

        # 只读 API 读取不再触发来源采集（三进程共享库时同样成立）。
        before = stack.source_requests()
        for _ in range(3):
            stack.client.get(f"/api/archive/dynamics/{DYNAMIC}")
            stack.client.get(f"/api/archive/dynamics/{DYNAMIC}/comments")
            stack.client.get(f"/api/archive/dynamics/{DYNAMIC}/comments/860030/location")
        assert stack.source_requests() == before

        # 真实采集进程终止/重启：不重建阶段与基线、不重复生成事件、不改已成功目标。
        phase = query(stack.database, "SELECT token, started_at, comment_started_at, sealed"
                                     " FROM notification_phases WHERE dynamic_id = ? ORDER BY started_at",
                      (DYNAMIC,))
        counts = (stub.count("up-202"), stub.count("all-202"), len(events(stack.database)))
        stack.stop(stack.processes["collector"])
        restarted = stack.start_collector()
        time.sleep(3)
        assert query(stack.database, "SELECT token, started_at, comment_started_at, sealed"
                                    " FROM notification_phases WHERE dynamic_id = ? ORDER BY started_at",
                     (DYNAMIC,)) == phase
        assert (stub.count("up-202"), stub.count("all-202"), len(events(stack.database))) == counts
        stack.stop(restarted)
        stack.stop(notifier)


def test_route_repair_keeps_queue_phase_and_sent_targets(stack):
    """缺一个业务目标时只暂停该目标；修配置重启通知进程后补发，不重置起点、不重发成功目标。"""
    stack.write_state(state(comments={"size": 1, "fresh": [1]}))
    stack.start_api()
    stack.configure(UP, DYNAMIC)
    stack.start_collector()
    stack.wait(lambda: "第一版正文" in stack.archive_text(DYNAMIC), None, 20, "v1 正文归档")
    with FeishuStub() as stub:
        stack.write_config(mapping(rooms=False, extra={
            "up-202": stub.url_for("up-202"), "all-202": stub.url_for("all-202"),
            "up-707": stub.url_for("up-707"), "all-707": stub.url_for("all-707"),
            "system-10": stub.url_for("system-10"),
        }))
        notifier = stack.start_notifier()
        stack.wait(lambda: stub.count("up-202") >= 1, notifier, 30, "UP 群收到本人评论")
        stack.wait(lambda: states(stack.database).get(("all", "root_comment", "860001")) == "waiting_config",
                   notifier, 30, "全员群等待配置")
        assert stub.count("all-202") == 0
        before = query(stack.database,
                       "SELECT token, started_at, comment_started_at FROM notification_phases"
                       " WHERE dynamic_id = ? AND sealed = 0", (DYNAMIC,))
        snapshot = [row["snapshot"] for row in deliveries(stack.database)
                    if row["kind"] == "root_comment"]
        stack.stop(notifier)

        # 修复配置 = 写入完整路由并重启通知进程；记录、阶段和快照都保留。
        stack.write_config(mapping(extra={
            "up-202": stub.url_for("up-202"), "all-202": stub.url_for("all-202"),
            "up-707": stub.url_for("up-707"), "all-707": stub.url_for("all-707"),
            "system-10": stub.url_for("system-10"),
        }))
        repaired = stack.start_notifier(name="notifier-repaired")
        stack.wait(lambda: stub.count("all-202") >= 1, repaired, 30, "修复后补发全员群")
        stack.wait(lambda: states(stack.database).get(("all", "root_comment", "860001")) == "sent",
                   repaired, 30, "全员群成功")
        assert query(stack.database,
                     "SELECT token, started_at, comment_started_at FROM notification_phases"
                     " WHERE dynamic_id = ? AND sealed = 0", (DYNAMIC,)) == before
        assert [row["snapshot"] for row in deliveries(stack.database)
                if row["kind"] == "root_comment"] == snapshot
        # 已成功的 UP 群不重发；历史不补发；快照仍是登记时的正文。
        assert stub.count("up-202") == 1
        assert len([row for row in events(stack.database)
                    if row["kind"] == "root_comment"]) == 1
        stack.stop(repaired)


def resource_reading(pid):
    status = Path(f"/proc/{pid}/status").read_text()
    rss = next(int(line.split()[1]) for line in status.splitlines() if line.startswith("VmRSS:"))
    stat = Path(f"/proc/{pid}/stat").read_text().split()
    ticks = os.sysconf("SC_CLK_TCK")
    return {"rss_kb": rss, "cpu_seconds": round((int(stat[13]) + int(stat[14])) / ticks, 2)}


def database_size(path):
    total = Path(path).stat().st_size
    for suffix in ("-wal", "-shm"):
        candidate = Path(str(path) + suffix)
        if candidate.exists():
            total += candidate.stat().st_size
    return total


def test_blocked_feishu_keeps_other_processes_writing_and_recovers_after_kill(stack):
    """飞书阻塞时 API 与采集仍完成写入；真实强杀后租约恢复、成功目标保持。"""
    stack.write_state(state(comments={"size": 1, "fresh": [1]}))
    stack.start_api()
    stack.configure(UP, DYNAMIC)
    stack.start_collector()
    stack.wait(lambda: "第一版正文" in stack.archive_text(DYNAMIC), None, 20, "v1 正文归档")
    with FeishuStub() as stub:
        stub.block("up-202")
        stack.write_config(mapping(extra={
            "up-202": stub.url_for("up-202"), "all-202": stub.url_for("all-202"),
            "up-707": stub.url_for("up-707"), "all-707": stub.url_for("all-707"),
            "system-10": stub.url_for("system-10"),
        }))
        notifier = stack.start_notifier(lease=2)
        stack.wait(lambda: stub.entered("up-202").is_set(), notifier, 30, "飞书请求进入阻塞")
        stack.wait(lambda: states(stack.database).get(("all", "root_comment", "860001")) == "sent",
                   notifier, 30, "同一轮的全员群已成功")
        assert states(stack.database).get(("up", "root_comment", "860001")) == "inflight"

        # 网络等待期间：另一路 API 写与采集归档仍能完成（飞书请求不持有 SQLite 写事务）。
        started = time.monotonic()
        for index in range(20):
            assert stack.client.patch(f"/api/manage/ups/{UP}/monitor", json={
                "mode": "specified", "recent_n": 10 + (index % 2), "enabled": True}).status_code == 200
        competition = round(time.monotonic() - started, 3)
        stack.write_state(state(version="v2", comments={"size": 1, "fresh": [1]}))
        stack.wait(lambda: "第二版正文" in stack.archive_text(DYNAMIC), notifier, 30,
                   "飞书阻塞期间采集仍归档新正文")
        assert states(stack.database).get(("up", "root_comment", "860001")) == "inflight"

        # 单实例：同一数据库的第二个通知进程必须被生产 flock 拒绝。
        duplicate = stack.start_notifier(name="notifier-duplicate")
        duplicate.handle.wait(timeout=20)
        assert duplicate.handle.returncode != 0
        assert "Notifier already running" in duplicate.text
        assert notifier.running

        metrics = {
            "api": resource_reading(stack.processes["api"].pid),
            "collector": resource_reading(stack.processes["collector"].pid),
            "notifier": resource_reading(notifier.handle.pid),
            "database_bytes": database_size(stack.database),
            "api_writes": 20,
            "api_writes_seconds": competition,
            "events": len(events(stack.database)),
            "deliveries": len(deliveries(stack.database)),
            "api_source_requests": stack.source_requests(),
            "collector_source_requests": stack.collector_requests(),
        }
        print("DELIVERY-METRICS " + json.dumps(metrics, ensure_ascii=False), flush=True)

        # 真实强杀（SIGKILL）后放行接收端：租约过期被重新领取，已成功目标不重发。
        checkpoint = Store(stack.database).read_archive(DYNAMIC)
        notifier.kill()
        killed = {(row["role"], row["comment_id"]): row for row in deliveries(stack.database)}
        assert killed[("up", "860001")]["state"] == "inflight"
        assert killed[("all", "860001")]["state"] == "sent"
        stub.release("up-202")
        recovered = stack.start_notifier(name="notifier-recovered", lease=2)
        stack.wait(lambda: states(stack.database).get(("up", "root_comment", "860001")) == "sent",
                   recovered, 30, "租约恢复后补发阻塞目标")
        # 被杀那次已到达接收端（重投意味着外部可能重复）；阻塞期间新增的正文变化也只进 UP 群。
        assert stub.count("up-202") == 3
        assert stub.count("all-202") == 1  # 已成功目标保持成功
        assert Store(stack.database).read_archive(DYNAMIC) == checkpoint
        rows = {(row["role"], row["comment_id"]): row for row in deliveries(stack.database)}
        assert rows[("up", "860001")]["token"] is None
        assert rows[("up", "860001")]["failures"] == 0
        assert rows[("all", "860001")]["sent_at"] is not None
        stack.stop(recovered)


def test_repeated_migration_keeps_archive_configuration_and_checkpoints(stack, tmp_path):
    """隔离迁移演练：三进程写出的库在停机后重复迁移，归档/配置/检查状态与通知队列都不变。"""
    import shutil

    stack.write_state(state(comments={"size": 2, "fresh": [1]}))
    stack.start_api()
    stack.configure(UP, DYNAMIC)
    stack.start_collector()
    stack.wait(lambda: "第一版正文" in stack.archive_text(DYNAMIC), None, 20, "v1 正文归档")
    stack.wait(lambda: stack.archive(DYNAMIC)["local_comment_count"] == 2, None, 20, "评论归档")
    stack.wait(lambda: stack.client.get(f"/api/manage/ups/{UP}/checks").json()["checks"][0]["work"] == "complete",
               None, 20, "归档与分项完成")
    archive = stack.archive(DYNAMIC)
    checks = stack.client.get(f"/api/manage/ups/{UP}/checks").json()
    saved = stack.client.get(f"/api/manage/ups/{UP}").json()
    deliveries_before = deliveries(stack.database)
    phase_before = query(stack.database,
                         "SELECT token, started_at, comment_started_at, sealed FROM notification_phases")
    stack.close()
    saved_archive = Store(stack.database).read_archive(DYNAMIC)
    assert saved_archive["text"] == archive_content(archive)["text"]

    migrated = tmp_path / "migrated.sqlite"
    shutil.copyfile(stack.database, migrated)
    for _ in range(2):
        assert Store(migrated).migrate() is None
    store = Store(migrated)
    assert store.read_archive(DYNAMIC) == saved_archive
    assert store.enabled_targets() == [{"uid": UP, "id": DYNAMIC}]
    assert query(migrated, "PRAGMA user_version") == [{"user_version": 21}]
    assert query(migrated, "SELECT token, started_at, comment_started_at, sealed"
                           " FROM notification_phases ORDER BY started_at") == phase_before
    assert deliveries(migrated) == deliveries_before
    assert [row["kind"] for row in events(migrated)] == [row["kind"] for row in events(stack.database)]
    # 配置与检查状态按原样保留（迁移不重置监控、不推进检查时间）。
    assert saved["monitor"]["enabled"] is True
    assert checks["checks"][0]["last_checked_at"] is not None
