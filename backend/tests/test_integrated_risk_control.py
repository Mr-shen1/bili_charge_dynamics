"""10：多进程组合验收 —— 真实 API＋独立采集＋独立通知＋同一临时 SQLite。

只替换外部来源、图片 CDN、OSS 上传与飞书 HTTP；生产检查、单路重型调度、发送／目标
租约、风控状态机、按类型探测、归档提交、发件箱与投递全部走真实实现。身份、动态、
评论、媒体与凭据全部虚构；不连接真实 B 站／OSS／飞书，不部署、不重启任何现有服务。
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

from backend.bili_monitor.comment_status import epoch_from_iso
from backend.bili_monitor.risk import PROBE_LEASE_SECONDS, RiskGate
from backend.bili_monitor.storage import Store
from backend.tests.integrated_fixture import FileClock, HUGE, TARGETS, UID, reply_id
from backend.tests.notification_process_support import (
    FeishuStub, NotifierProcess, business_events,
)
from backend.tests.notification_support import query


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = "backend.tests.integrated_fixture"
DYNAMIC = "91002"
CLOCK_BASE = 1_800_000_000


def config_mapping(stub, *, rooms=True):
    destinations = {"system": {"webhook": stub.url_for("system")}}
    ups = {UID: {"up": "up"}}
    destinations["up"] = {"webhook": stub.url_for("up")}
    if rooms:
        ups[UID]["all"] = "all"
        destinations["all"] = {"webhook": stub.url_for("all")}
    return {"base_url": "https://archive.example.invalid", "ups": ups,
            "system": "system", "destinations": destinations}


class Stack:
    """三进程临时装配：所有控制文件、SQLite 与日志都只存在于本次运行目录。"""

    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.database = self.directory / "integrated.sqlite"
        self.state_file = self.directory / "state.json"
        self.config = self.directory / "notifications.json"
        self.environment = {
            name: value for name, value in os.environ.items()
            if not name.startswith(("BILI_", "INTEGRATED_", "UVICORN_", "DELIVERY_"))
            and name != "WEB_CONCURRENCY"
        }
        self.environment.update({
            "BILI_DATABASE_PATH": str(self.database),
            "INTEGRATED_DIR": str(self.directory),
            "INTEGRATED_STATE": str(self.state_file),
            "BILI_COLLECTOR_CADENCE_SECONDS": "1",
            "BILI_COLLECTOR_PAGE_CHECK_SECONDS": "600",
            "PYTHONUNBUFFERED": "1",
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
        })
        if os.environ.get("INTEGRATED_CLOCK_SLEEP"):
            # 仅在需要受控节拍的用例里显式注入；不由测试改名生产默认值。
            self.environment["INTEGRATED_CLOCK_SLEEP"] = os.environ["INTEGRATED_CLOCK_SLEEP"]
        self.processes, self.logs, self.client = {}, {}, None
        # 明确的运行／请求预算：回放失效时在预算处失败，而不是无限等待或无限请求。
        self.started = time.monotonic()
        self.max_requests = 6000
        self.max_seconds = 300

    # ---- 状态 ----

    def write_state(self, value):
        temporary = self.state_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False))
        temporary.replace(self.state_file)

    def state(self, *, targets=TARGETS, roots=1, replies=0, huge_replies=10000, media=True,
              text="第一版正文", locator_type=17, reply_root=True,
              fresh_roots=(), fresh_replies=()):
        dynamics = {}
        for dynamic in targets:
            dynamics[dynamic] = {
                "uid": UID, "name": "虚构组合作者",
                "text": f"{text} {dynamic}", "version": "v1", "title": f"标题 {dynamic}",
                "roots": roots, "replies": huge_replies if dynamic == HUGE else replies,
                "reply_root": reply_root, "media": media, "locator_type": locator_type,
                "fresh_roots": list(fresh_roots), "fresh_replies": list(fresh_replies),
            }
        return {"dynamics": dynamics}

    def mutate(self, dynamic, **changes):
        value = json.loads(self.state_file.read_text())
        value["dynamics"][dynamic].update(changes)
        self.write_state(value)

    def write_config(self, value):
        self.config.write_text(json.dumps(value, ensure_ascii=False))

    def write_clock(self, epoch):
        (self.directory / "clock.txt").write_text(str(int(epoch)))

    def control(self, name, value="x"):
        (self.directory / name).write_text(value)

    def clear(self, name):
        path = self.directory / name
        if path.exists():
            path.unlink()

    def open_notifications(self):
        store = Store(self.database)
        store.migrate()
        store.update_notification_switch("all")

    # ---- 子进程 ----

    def spawn(self, role, *arguments):
        log = self.directory / f"{role}-{len(self.processes)}.log"
        with log.open("wb") as output:
            process = subprocess.Popen(
                [sys.executable, *arguments], cwd=ROOT,
                env={**self.environment, "INTEGRATED_ROLE": role},
                stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)
        self.processes[role if role not in self.processes else f"{role}-{len(self.processes)}"] = process
        self.logs[role if role not in self.logs else f"{role}-{len(self.processes)}"] = log
        return process

    def run_task(self, *arguments, role="task", timeout=120):
        result = subprocess.run(
            [sys.executable, "-m", FIXTURE, "--database", str(self.database), *arguments],
            cwd=ROOT, env={**self.environment, "INTEGRATED_ROLE": role},
            capture_output=True, text=True, timeout=timeout)
        assert result.returncode == 0, result.stdout + result.stderr
        return json.loads(result.stdout.strip().splitlines()[-1])

    def start_api(self):
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        self.api = self.spawn(
            "api", "-m", "uvicorn", f"{FIXTURE}:create_app", "--factory",
            "--host", "127.0.0.1", "--port", str(port))
        self.client = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=10, trust_env=False)
        self.wait(lambda: self.client.get("/api/manage/ups").status_code == 200,
                  self.api, 20, "API 就绪")
        return self.client

    def start_collector(self, name="collector"):
        process = self.spawn(name, "-m", FIXTURE, "--database", str(self.database))
        return process

    def start_notifier(self, name="notifier", **environment):
        process = NotifierProcess(self.directory, self.database, self.config, **environment)
        self.processes[name] = process
        return process

    def stop(self, process, *, kill=False):
        if hasattr(process, "handle"):
            process.kill() if kill else process.stop()
            return
        if process.poll() is None:
            process.kill() if kill else process.terminate()
            try:
                process.wait(timeout=10)
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

    # ---- 配置与读取 ----

    def configure(self, targets=TARGETS):
        assert self.client.post("/api/manage/ups", json={"uid": UID}).status_code == 201
        assert self.client.patch(f"/api/manage/ups/{UID}/monitor", json={
            "mode": "specified", "recent_n": 10, "enabled": True}).status_code == 200
        for dynamic in targets:
            assert self.client.post(f"/api/manage/ups/{UID}/targets",
                                    json={"id": dynamic}).status_code == 201

    def archive(self, dynamic):
        response = self.client.get(f"/api/archive/dynamics/{dynamic}")
        return response.json() if response.status_code == 200 else None

    def checks(self):
        return self.client.get(f"/api/manage/ups/{UID}/checks").json()["checks"]

    def complete(self, expected=len(TARGETS)):
        rows = self.checks()
        return len(rows) == expected and all(row["work"] == "complete" for row in rows)

    def status(self):
        store = Store(self.database)
        return RiskGate(store, clock=FileClock(self.directory)).status()

    # ---- 观测 ----

    def check_budget(self, *, requests=None, seconds=None):
        rows = self.ledger()
        limit = requests if requests is not None else self.max_requests
        assert len(rows) <= limit, f"来源请求超出预算：{len(rows)} > {limit}"
        elapsed = time.monotonic() - self.started
        wall = seconds if seconds is not None else self.max_seconds
        assert elapsed <= wall, f"回放超出时间预算：{elapsed:.1f}s > {wall}s"

    def ledger(self, role=None):
        path = self.directory / "ledger.txt"
        if not path.exists():
            return []
        rows = []
        for line in path.read_text().splitlines():
            if not line.strip():
                continue
            actor, kind, page, phase, stamp, oid = line.split()
            if role is not None and actor != role:
                continue
            rows.append({"role": actor, "kind": kind, "page": page, "phase": phase,
                         "at": float(stamp), "oid": oid})
        return rows

    def uploads(self):
        path = self.directory / "uploads.txt"
        return path.read_text().splitlines() if path.exists() else []

    def log_text(self, role=None):
        paths = [self.logs[role]] if role in self.logs else list(self.logs.values())
        return "\n".join(path.read_text() for path in paths if path.exists())

    def wait(self, predicate, process=None, timeout=25, description=""):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if process is not None and not self._running(process):
                pytest.fail(f"进程提前退出：{description}\n{self.log_text()}")
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


@pytest.fixture
def stack(tmp_path):
    instance = Stack(tmp_path / "integrated")
    try:
        yield instance
    finally:
        instance.close()


def complete_reply_archive(archive, roots, replies):
    """来源总数、本地根数与楼中楼回复数分别对齐；不用通知基线或检查时间替代。"""
    return (archive["source_comment_count"] == archive["synced_comment_count"] == roots + replies
            and archive["local_comment_count"] == roots
            and archive["local_reply_count"] == replies
            and archive["synced_reply_comment_count"] >= replies)


def reply_windows(rows):
    """按发送顺序配对楼中楼 send/done；账本来自两个进程，只按时间排序。"""
    windows, pending = [], []
    for row in sorted((row for row in rows if row["kind"] == "replies"), key=lambda item: item["at"]):
        if row["phase"] == "send":
            pending.append(row)
        elif pending:
            windows.append((pending.pop(0), row))
    return windows


def test_three_processes_archive_eight_targets_and_ten_thousand_replies(stack):
    """RC-01／02／03／10：8 目标全量归档、跨进程单路、页后 100ms、日志可串联。"""
    stack.write_state(stack.state(huge_replies=10000))
    stack.start_api()
    stack.configure()
    stack.open_notifications()
    with FeishuStub() as stub:
        stack.write_config(config_mapping(stub))
        notifier = stack.start_notifier()
        collector = stack.start_collector()
        stack.wait(stack.complete, notifier, 240, "8 目标全量归档")
        # 巨大目标：一万条楼中楼完整、计数与本地一致。
        huge = stack.archive(HUGE)
        assert complete_reply_archive(huge, 1, 10000)
        assert huge["work"]["replies"] == "success" and huge["work"]["media"] == "success"
        for dynamic in TARGETS[1:]:
            archive = stack.archive(dynamic)
            assert archive["work"]["comments"] == archive["work"]["replies"] == "success"
            assert archive["local_reply_count"] == 0
            assert archive["media"][0]["public_url"].startswith("https://media.example.invalid/")
        assert len(stack.uploads()) == len(TARGETS)

        rows = stack.ledger()
        assert {row["role"] for row in rows} == {"api", "collector"}
        # 任一时刻只有一个真实来源请求：跨进程 source 租约没有被绕过。
        ordered = sorted((row for row in rows), key=lambda item: item["at"])
        active, deepest = 0, 0
        for row in ordered:
            active += 1 if row["phase"] == "send" else -1
            deepest = max(deepest, active)
        assert deepest == 1, ordered
        # 每次真实楼中楼请求完成后至少 100ms 才有下一次发送（含另一进程）。
        windows = reply_windows(rows)
        assert len(windows) >= 500
        sends = [row["at"] for row in ordered if row["phase"] == "send"]
        for _, done in windows:
            following = next((stamp for stamp in sends if stamp > done["at"]), None)
            if following is not None:
                assert following - done["at"] >= 0.095
        # 公平轮转：其他目标在巨大目标第 2 页回复之前都获得过正文机会。
        huge_reply_two = next(index for index, row in enumerate(ordered)
                              if row["phase"] == "send" and row["kind"] == "replies"
                              and row["page"] == "2")
        body_requests = [index for index, row in enumerate(ordered)
                         if row["phase"] == "send" and row["kind"] == "opus_page"]
        assert len(body_requests) >= len(TARGETS)
        assert max(body_requests) < huge_reply_two
        # 轻量检查在重型分页之间仍有进展（count 请求贯穿）。
        assert sum(1 for row in rows if row["kind"] == "comment_count" and row["phase"] == "send") >= len(TARGETS)

        # 日志能串起目标、分页、ID、等待与断点；不输出秘密／URL／令牌。
        log = stack.log_text("collector")
        assert "reply_page_saved" in log and "root_page_saved" in log
        assert "wait_ms=100" in log
        assert "reply_ids=[" in log
        assert "dispatch_turn" in log
        assert "http://" not in log and "https://" not in log
        assert "FAKE_" not in log and "Cookie" not in log and "cookie" not in log
        # 不记录 owner／租约令牌；重型回合只记是否由本进程持有。
        assert "heavy_held=true" in log
        assert "owner=" not in log and "lease" not in log

        # 首次归档只建立通知基线：没有业务消息，也没有风控系统告警。
        assert business_events(stack.database) == []
        assert query(stack.database,
                     "SELECT COUNT(*) AS total FROM notification_events WHERE kind = 'alert'") == [
            {"total": 0}]
        stack.check_budget()
        stack.stop(collector)
        stack.stop(notifier)


def test_one_process_412_pauses_every_source_but_keeps_local_commit_and_upload(stack):
    """RC-05／09：采集进程触发 412 后另一进程停止发送；本地读取、停用与 OSS 上传仍可用。"""
    stack.write_state(stack.state(roots=1, replies=200))
    stack.control("upload.hold")
    # 冻结风控“现在”并让采集节拍快速推进：测试窗口内冷却不会到期望，也不等待真实分钟。
    stack.write_clock(CLOCK_BASE)
    stack.environment["INTEGRATED_CLOCK_SLEEP"] = "0.2"
    stack.start_api()
    stack.configure()
    stack.open_notifications()
    with FeishuStub() as stub:
        stack.write_config(config_mapping(stub))
        notifier = stack.start_notifier()
        collector = stack.start_collector()
        # 先等已下载的图片进入上传并阻塞；此时风控尚未触发。
        stack.wait(lambda: (stack.directory / "upload.blocked").exists(), collector, 60,
                   "媒体下载完成并进入 OSS 上传")
        stack.control("risk.arm", "collector:comment_count")
        stack.wait(lambda: stack.status()["state"] == "cooldown", collector, 60, "采集进程触发 412")
        status = stack.status()
        assert status["last_trigger"]["endpoint_type"] == "comment_count"
        assert status["last_trigger"]["http_status"] == 412
        assert status["backoff_step"] == 1

        # 另一进程不再发送任何来源请求（含预热／图片）：全部在同一份持久状态上被拒绝。
        before = stack.ledger()
        api_before = [row for row in before if row["role"] == "api"]
        time.sleep(0.6)
        assert stack.ledger() == before
        assert [row for row in stack.ledger("api")] == api_before

        # 需要来源的管理操作明确暂不可用，且不产生半成品／伪成功统计。
        new_up = stack.client.post("/api/manage/ups", json={"uid": "303"})
        assert new_up.status_code == 503 and new_up.json()["error"]["code"] == "SOURCE_RISK_PAUSED"
        assert new_up.headers["retry-after"]
        assert stack.client.post("/api/manage/ups/303/targets", json={"id": "999"}).status_code == 404
        assert stack.client.post(f"/api/manage/ups/{UID}/targets", json={"id": "91009"}).status_code == 503
        assert [row["uid"] for row in stack.client.get("/api/manage/ups").json()["ups"]] == [UID]
        assert stack.client.get("/api/manage/risk").json()["state"] == "cooldown"

        # 纯本地读取与管理停用／删除仍可用。
        assert stack.client.get(f"/api/archive/dynamics/{HUGE}").status_code == 200
        assert stack.client.get(f"/api/archive/dynamics/{HUGE}/comments").status_code == 200
        assert stack.client.delete(f"/api/manage/ups/{UID}/targets/91009").status_code == 204
        assert stack.client.delete(f"/api/manage/ups/{UID}/targets/91008").status_code == 204

        # 已取得的图片在保护态下仍完成 OSS 上传与本地提交，不产生半成品。
        stack.clear("upload.hold")
        stack.wait(lambda: stack.uploads(), collector, 60, "保护态下 OSS 上传完成")
        assert stack.status()["state"] == "cooldown"
        uploaded = stack.uploads()[0].split()[1].split("/")[2]
        stack.wait(lambda: ((stack.archive(uploaded) or {}).get("media") or [{}])[0].get("status")
                   == "success", collector, 60, "已下载内容提交")
        archive = stack.archive(uploaded)
        assert archive["media"][0]["public_url"].startswith("https://media.example.invalid/")
        assert archive["work"]["media"] == "success"
        assert archive["work"]["replies"] in ("pending", "success")
        # 采集进程的步骤机在暂停后释放租约；此后手动初始化与媒体重试明确暂不可用。
        stack.wait(lambda: not query(stack.database,
                                     "SELECT name FROM dispatch_leases WHERE name LIKE 'target:%'"),
                   collector, 30, "暂停后释放目标租约")
        initial = stack.client.post("/api/sync/initial", json={"uid": UID})
        assert initial.status_code == 503
        assert initial.json()["error"]["code"] == "SOURCE_RISK_PAUSED"
        assert stack.client.post(f"/api/sync/media/{HUGE}").status_code == 503
        # 没有为被拒绝的操作创建身份或目标，也没有伪造成功统计。
        assert query(stack.database, "SELECT uid FROM identities") == [{"uid": UID}]
        assert query(stack.database,
                     "SELECT id FROM targets WHERE uid = ? ORDER BY id", (UID,)) == [
            {"id": dynamic} for dynamic in TARGETS[:-1]]
        # 风控生命周期只发系统群一条；业务群没有新消息。
        stack.wait(lambda: stub.count("system") >= 1, notifier, 30, "系统群告警投递")
        assert stub.count("up") == 0 and stub.count("all") == 0
        messages = [json.dumps(payload, ensure_ascii=False) for payload in stub.payloads("system")]
        assert any("来源触发风控保护，已在冷却中" in message for message in messages)
        stack.check_budget()
        stack.stop(collector)
        stack.stop(notifier)



def probe_results(stack):
    return [(item["endpoint_type"], item["status"]) for item in stack.status()["probe"]["results"]]


def test_killed_pagination_resumes_confirmed_pages_and_keeps_new_observation(stack):
    """RC-04／06：分页中强杀后从已确认页续采；新计数与新根不被吞；来源缩小不清旧档。"""
    stack.write_state(stack.state(targets=(HUGE,), roots=2, replies=80, media=False))
    stack.write_clock(CLOCK_BASE)
    stack.environment["INTEGRATED_CLOCK_SLEEP"] = "0.05"
    stack.start_api()
    stack.configure(targets=(HUGE,))
    collector = stack.start_collector()
    stack.wait(lambda: any(row["kind"] == "replies" and row["phase"] == "done"
                           and row["page"] == "3" for row in stack.ledger()),
               collector, 60, "前三页楼中楼完成")
    # 第 4 页进入在途后强杀：已确认页已提交，未确认页保留 running 领取。
    stack.control("hold.replies.4")
    stack.wait(lambda: any(row["kind"] == "replies" and row["phase"] == "send"
                           and row["page"] == "4" for row in stack.ledger()),
               collector, 60, "第 4 页在途")
    stack.stop(collector, kill=True)
    stack.clear("hold.replies.4")
    first = [row for row in stack.ledger() if row["kind"] == "replies" and row["phase"] == "send"]
    for page in ("1", "2", "3"):
        assert sum(row["page"] == page for row in first) == 1
    # 停机期间出现新观察：来源计数增加 20 条回复。
    stack.mutate(HUGE, replies=100)
    stack.write_clock(CLOCK_BASE + 301)  # 让被强杀进程的目标／重型租约过期后接管
    restored = stack.start_collector()
    stack.wait(lambda: (stack.archive(HUGE) or {}).get("local_reply_count") == 100
               and (stack.archive(HUGE) or {}).get("work", {}).get("replies") == "success",
               restored, 120, "续采到新回复总数")
    archive = stack.archive(HUGE)
    assert archive["local_comment_count"] == 2
    sends = [row for row in stack.ledger() if row["kind"] == "replies" and row["phase"] == "send"]
    # 第 1 页已确认且未变化，不再重下；增量从末页倒序并向前重叠校验到已知页，
    # 所以在途页与重叠页可安全重读，但不是无条件整楼全扫。
    assert sum(row["page"] == "1" for row in sends) == 1
    assert sum(row["page"] == "5" for row in sends) >= 1
    assert sum(row["page"] in ("2", "3", "4") for row in sends) <= 3 * 2
    # 新观察插入新根（真实页移动）：允许重定位，但不得丢内容或制造假完成。
    stack.mutate(HUGE, roots=3, fresh_roots=[3])
    stack.write_clock(CLOCK_BASE + 302)
    stack.wait(lambda: (stack.archive(HUGE) or {}).get("local_comment_count") == 3
               and (stack.archive(HUGE) or {}).get("work", {}).get("replies") == "success",
               restored, 120, "页移动后根集合完整")
    archive = stack.archive(HUGE)
    assert archive["local_reply_count"] == 100
    # 来源缩小（删除回复与根）不清除已取得内容，也不因差额无限重扫。
    stack.mutate(HUGE, replies=40, roots=2)
    stack.write_clock(CLOCK_BASE + 305)
    before = len(stack.ledger())
    time.sleep(3)
    archive = stack.archive(HUGE)
    assert archive["local_reply_count"] == 100 and archive["local_comment_count"] == 3
    assert archive["replies_error"] in (None, "REPLIES_FAILED")
    assert len(stack.ledger()) - before < 100
    stack.check_budget()
    stack.stop(restored)


def test_cooldown_deadline_probe_lease_and_observation_survive_kills(stack):
    """RC-06：冷却期限持久、探测 owner 终止后接管、旧 owner 结果被拒、观察重启重新累计。"""
    stack.write_state(stack.state(targets=(HUGE,), roots=1, replies=40, huge_replies=40, media=False))
    stack.write_clock(CLOCK_BASE)
    stack.environment["INTEGRATED_CLOCK_SLEEP"] = "0.05"
    stack.start_api()
    stack.configure(targets=(HUGE,))
    collector = stack.start_collector()
    stack.wait(lambda: stack.complete(1), collector, 90, "初始档建立探测样本")
    stack.stop(collector)

    entry = stack.run_task("--task", "trigger", "--path", "/x/v2/reply/count")
    assert entry["state"] == "cooldown" and entry["backoff_step"] == 1
    deadline = entry["next_probe_at"]
    # 冷却中重启：期限与档位原样保留。
    paused = stack.start_collector()
    stack.wait(lambda: "collector_tick" in stack.log_text(), paused, 30, "采集已启动")
    time.sleep(0.2)
    stack.stop(paused, kill=True)
    status = stack.status()
    assert status["state"] == "cooldown" and status["next_probe_at"] == deadline

    # 到期后由一次性真实进程领取探测；租约未过期前采集进程不能接管。
    expiry = int(epoch_from_iso(deadline))
    stack.write_clock(expiry)
    stack.control("probe.fail", "comment_count")
    old = stack.run_task("--task", "claim", "--types", "comment_count,root_comments")
    assert old is not None and old["origin"] == "cooldown"
    assert stack.run_task("--task", "claim", "--types", "comment_count") is None
    stack.write_clock(expiry + PROBE_LEASE_SECONDS + 1)
    takeover = stack.start_collector()
    stack.wait(lambda: stack.status()["backoff_step"] == 2, takeover, 60, "接管后探测失败推进一档")
    status = stack.status()
    assert status["state"] == "cooldown" and status["backoff_step"] == 2
    assert status["probe"]["round"] != old["round"]
    # 旧 owner 的迟到结果不能覆盖新代次。
    late = stack.run_task("--task", "finish", "--round", old["round"], "--owner", old["owner"],
                          "--passed", "false")
    assert late is None
    assert stack.status()["backoff_step"] == 2 and stack.status()["probe"]["round"] != old["round"]

    # 下一档全部类型通过 → 观察态；重启保留档位但观察时间重新累计。
    deadline = stack.status()["next_probe_at"]
    stack.write_clock(int(epoch_from_iso(deadline)))
    stack.clear("probe.fail")
    stack.wait(lambda: stack.status()["state"] == "observing", takeover, 90, "探测通过进入观察期")
    assert stack.status()["backoff_step"] == 2
    stack.stop(takeover)
    restarted = stack.start_collector()
    stack.wait(lambda: "source_risk_observation_restarted" in stack.log_text(),
               restarted, 60, "重启观察期重新累计")
    status = stack.status()
    assert status["state"] == "observing" and status["backoff_step"] == 2
    assert status["observation"]["active_ms"] == 0
    stack.check_budget()
    stack.stop(restarted)


def test_six_step_ladder_manual_probe_observation_and_business_notifications(stack):
    """RC-06／07／08／11：六档逐档探测、失败短路、转人工、人工通过、599→600、告警与通知隔离。"""
    stack.write_state(stack.state(targets=(HUGE,), roots=1, replies=40, huge_replies=40, media=False))
    stack.write_clock(CLOCK_BASE)
    stack.environment["INTEGRATED_CLOCK_SLEEP"] = "0.02"
    stack.start_api()
    stack.configure(targets=(HUGE,))
    stack.open_notifications()
    with FeishuStub() as stub:
        stack.write_config(config_mapping(stub))
        notifier = stack.start_notifier()
        collector = stack.start_collector()
        stack.wait(lambda: stack.complete(1), collector, 90, "初始档建立探测样本")

        entry = stack.run_task("--task", "trigger", "--path", "/x/v2/reply/count")
        assert entry["state"] == "cooldown" and entry["backoff_step"] == 1
        stack.control("probe.fail", "comment_count")
        for step in range(1, 7):
            deadline = stack.status()["next_probe_at"]
            assert deadline is not None
            stack.write_clock(int(epoch_from_iso(deadline)))
            if step < 6:
                stack.wait(lambda: stack.status()["backoff_step"] == step + 1,
                           collector, 60, f"第 {step} 档失败推进")
                # 触发类型先探测；失败后其余类型保持 pending，不再请求。
                first = stack.status()["probe"]["results"][0]
                assert first["endpoint_type"] == "comment_count"
                assert first["status"] == "failed" and first["http_status"] == 412
                assert first["reason"] == "source_risk"
                assert all(item["status"] == "pending"
                           for item in stack.status()["probe"]["results"][1:])
            else:
                stack.wait(lambda: stack.status()["state"] == "manual", collector, 60, "第六档转人工")
        status = stack.status()
        assert status["backoff_step"] == 6 and status["state"] == "manual"
        # 每档等待与每类结果不刷群：只有触发与转人工两条风控消息。
        stack.wait(lambda: sum("风控" in json.dumps(payload, ensure_ascii=False)
                               for payload in stub.payloads("system")) >= 2, notifier, 30, "触发与转人工告警")
        risk_messages = [message for message in
                         (json.dumps(payload, ensure_ascii=False) for payload in stub.payloads("system"))
                         if "来源触发风控保护" in message or "自动恢复耗尽" in message]
        assert len(risk_messages) == 2
        assert stub.count("up") == 0 and stub.count("all") == 0

        # 人工入口只登记一轮，重复登记幂等；采集进程未运行时保持已登记、不排多轮。
        stack.clear("probe.fail")
        stack.stop(collector)
        first = stack.client.post("/api/manage/risk/probe")
        assert first.status_code == 202 and first.json()["manual"]["probe_registered"] is True
        assert stack.client.post("/api/manage/risk/probe").json() == first.json()
        resumed = stack.start_collector()
        stack.wait(lambda: stack.status()["state"] == "observing", resumed, 90, "人工探测通过进入观察期")
        status = stack.status()
        assert status["backoff_step"] == 6
        assert all(item["status"] == "passed" for item in status["probe"]["results"])
        # 探测不产生业务通知：业务群仍为零。
        assert stub.count("up") == 0 and stub.count("all") == 0

        # 观察期只有活跃采集才累计；停掉采集进程后用真实 RiskGate 心跳推进 599→600。
        stack.stop(resumed)
        stack.run_task("--task", "observe", "--seconds", "300")
        stack.run_task("--task", "observe", "--seconds", "299")
        status = stack.status()
        assert status["state"] == "observing" and status["observation"]["active_ms"] == 599_000
        stack.run_task("--task", "observe", "--seconds", "1")
        status = stack.status()
        assert status["state"] == "normal" and status["backoff_step"] == 0
        stack.wait(lambda: any("连续正常采集后已稳定恢复" in json.dumps(payload, ensure_ascii=False)
                               for payload in stub.payloads("system")), notifier, 30, "稳定恢复告警")

        # 恢复后新的一级评论仍按既有通知资格投递，不被风控告警或探测改变。
        stack.mutate(HUGE, roots=2, fresh_roots=[2])
        stack.write_clock(CLOCK_BASE + 4000)
        resumed = stack.start_collector()
        stack.wait(lambda: stub.count("up") >= 1 and stub.count("all") >= 1, resumed, 90,
                   "新评论按既有资格投递业务群")
        assert any("虚构一级评论 2" in json.dumps(payload, ensure_ascii=False)
                   for payload in stub.payloads("up"))
        # 系统群只收到风控生命周期与既有心跳，不混入业务评论。
        for payload in stub.payloads("system"):
            assert "虚构一级评论 2" not in json.dumps(payload, ensure_ascii=False)
        stack.check_budget()
        stack.stop(resumed)
        stack.stop(notifier)


def test_observing_retrigger_reuses_the_next_step_and_sixth_goes_manual(tmp_path):
    """RC-08：观察期再拦截沿用当前档的下一档；第六档后再次触发直接转人工。"""
    import asyncio

    from backend.bili_monitor.risk import SourceRiskPaused
    from backend.bili_monitor.source_gate import SourceReport, source_request
    from backend.tests.collector_clock import ControlledClock

    store = Store(tmp_path / "retrigger.sqlite")
    store.migrate()
    store.update_notification_switch("system_only")
    clock = ControlledClock()
    gate = RiskGate(store, clock=clock)
    request = source_request("GET", "https://api.bilibili.com/x/v2/reply/count")

    def epoch_now():
        return epoch_from_iso(clock.now())

    def trigger():
        try:
            asyncio.run(gate.report(request, SourceReport(status_code=412)))
        except SourceRiskPaused:
            pass

    def pass_probe(expected_step):
        deadline = epoch_from_iso(gate.status()["next_probe_at"])
        clock.advance(clock.value + max(0, deadline - epoch_now()) + 1)
        claim = asyncio.run(gate.claim_probe(["comment_count"]))
        assert claim is not None
        status = asyncio.run(gate.finish_probe(claim, True))
        assert status["state"] == "observing" and status["backoff_step"] == expected_step

    trigger()
    assert gate.status()["backoff_step"] == 1
    for step in range(2, 7):
        pass_probe(step - 1)
        trigger()
        status = gate.status()
        assert status["state"] == "cooldown" and status["backoff_step"] == step
    pass_probe(6)
    trigger()
    status = gate.status()
    assert status["state"] == "manual" and status["backoff_step"] == 6
    categories = [row["version"].split(":", 1)[0] for row in query(
        store.path, "SELECT version FROM notification_events WHERE kind = 'alert'")]
    assert categories.count("risk_triggered") == 1  # 30 分钟窗口内合并，不逐档刷群
    assert categories.count("risk_manual") == 1
    assert "risk_recovered" not in categories


def test_locator_change_after_kill_regenerates_without_mixing_resources(stack):
    """RC-04：评论定位资源改变后旧断点被识别，重新校验而不把不同资源拼接成假完成。"""
    stack.write_state(stack.state(targets=(HUGE,), roots=1, replies=40, huge_replies=40,
                                  media=False, locator_type=17))
    stack.write_clock(CLOCK_BASE)
    stack.environment["INTEGRATED_CLOCK_SLEEP"] = "0.05"
    stack.start_api()
    stack.configure(targets=(HUGE,))
    collector = stack.start_collector()
    stack.wait(lambda: any(row["kind"] == "replies" and row["phase"] == "done"
                           and row["page"] == "1" for row in stack.ledger()),
               collector, 60, "第 1 页回复完成")
    stack.control("hold.replies.2")
    stack.wait(lambda: any(row["kind"] == "replies" and row["phase"] == "send"
                           and row["page"] == "2" for row in stack.ledger()),
               collector, 60, "第 2 页在途")
    stack.stop(collector, kill=True)
    stack.clear("hold.replies.2")
    # 定位从 basic（99+动态）切到动态 ID 兜底，并让页面信号本轮不可用：
    # 检查必须重新读 detail 识别新定位，旧断点不能继续拼接。
    stack.mutate(HUGE, locator_type=11, page_fail=True)
    stack.write_clock(CLOCK_BASE + 601)
    restored = stack.start_collector()
    stack.wait(lambda: ((stack.archive(HUGE) or {}).get("comment_locator") or {}).get("oid") == HUGE,
               restored, 90, "定位变化被识别")
    stack.mutate(HUGE, page_fail=False)
    stack.write_clock(CLOCK_BASE + 602)
    stack.wait(lambda: (stack.archive(HUGE) or {}).get("local_reply_count") == 40
               and (stack.archive(HUGE) or {}).get("work", {}).get("replies") == "success",
               restored, 120, "定位变化后完整续采")
    archive = stack.archive(HUGE)
    locator = archive["comment_locator"]
    assert locator["oid"] == HUGE and int(locator["type"]) == 11
    assert archive["local_comment_count"] == 1
    stored = Store(stack.database).reply_ids(HUGE)
    assert set().union(*stored.values()) == {reply_id(HUGE, index) for index in range(1, 41)}
    assert "locator_changed" in stack.log_text() or "relocat" in stack.log_text()
    stack.check_budget()
    stack.stop(restored)
