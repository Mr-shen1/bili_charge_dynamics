"""01：只替换外部传输与时间的通知测试装配。

真实 SQLite、真实归档/采集入口与真实通知模块；B 站 HTML 使用受控字节，
飞书接收端是进程内替身，凭据全部是虚构值。
"""

import json
import sqlite3
from pathlib import Path

import httpx

from backend.bili_monitor.notifications import NotificationConfig
from backend.tests.collector_support import empty_upstream
from backend.tests.management_support import UID


FIXTURES = Path(__file__).parent / "fixtures" / "versioned_edit"
DYNAMIC = "123"
BASE_URL = "https://archive.example.invalid"
WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/fake-up-token"
ALL_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/fake-all-token"
PIXEL = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x04\x00\x00\x00"
    b"\xb5\x1c\x0c\x02\x00\x00\x00\x0bIDATx\xdac\xfc\xff\x1f\x00\x03\x03\x02\x00\xef\xa3E\x99"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)


def versioned_html(page="v1", *, text=None, title=None, pictures=None, edited=None):
    """在固定版本的页面字节上注入标题/正文/图片/编辑时间，仍由生产解析器解析。"""
    html = (FIXTURES / f"{page}.html").read_text()
    head, rest = html.split("window.__INITIAL_STATE__ = ", 1)
    json_text, tail = rest.split(";</script>", 1)
    detail = json.loads(json_text)
    modules = detail["detail"]["modules"]
    if edited is not None:
        author = next(module for module in modules if module["module_type"] == "MODULE_TYPE_AUTHOR")
        author["module_author"]["pub_time"] = f"编辑于 2026年10月09日 {edited}"
    content = next(module for module in modules if module["module_type"] == "MODULE_TYPE_CONTENT")
    paragraphs = content["module_content"]["paragraphs"]
    if text is not None:
        paragraphs[0]["text"]["nodes"][0]["word"]["words"] = text
    if pictures:
        paragraphs.append({"para_type": 2, "pic": {"pics": pictures}})
    if title is not None:
        modules.insert(0, {"module_type": "MODULE_TYPE_TITLE", "module_title": {"text": title}})
    return head + "window.__INITIAL_STATE__ = " + json.dumps(detail, ensure_ascii=False) + ";</script>" + tail


class Source:
    """可切换版本与受控失败的来源替身；非 /opus/ 请求交给既有虚构上游。"""

    def __init__(self, page="v1", *, text=None, title=None, pictures=None, edited=None):
        self.page = page
        self.text = text
        self.title = title
        self.pictures = pictures
        self.edited = edited
        self.body_error = False
        self.comments_error = False

    def __call__(self, request):
        if request.url.path.startswith("/opus/"):
            if self.body_error:
                raise httpx.ConnectError("fictional body failure", request=request)
            return httpx.Response(200, text=versioned_html(
                self.page, text=self.text, title=self.title, pictures=self.pictures, edited=self.edited))
        if self.comments_error and request.url.path in ("/x/v2/reply/count", "/x/v2/reply"):
            return httpx.Response(500, json={"code": -500})
        return empty_upstream(request)


class FailingUploader:
    """媒体上传持续失败：正文成功仍必须可通知，媒体保持待归档。"""

    def __init__(self):
        self.attempts = 0

    async def upload(self, key, content, content_type):
        self.attempts += 1
        raise RuntimeError("fictional upload failure")


def media_download(request):
    if not request.url.host.endswith("hdslb.com"):
        raise httpx.ConnectError("fictional media origin", request=request)
    return httpx.Response(200, content=PIXEL, headers={"content-type": "image/png"})


class Receiver:
    """受控飞书接收端：记录实际请求，默认返回官方业务成功响应。"""

    def __init__(self, responder=None):
        self.requests = []
        self.responder = responder

    def __call__(self, request):
        body = json.loads(request.content)
        self.requests.append({"url": str(request.url), "payload": body})
        if self.responder is not None:
            return self.responder(request)
        return httpx.Response(200, json={"code": 0, "msg": "success"})

    @property
    def payloads(self):
        return [item["payload"] for item in self.requests]


def config_mapping(*, base_url=BASE_URL, up=WEBHOOK, full=None, overrides=None, system=None):
    """服务端配置形状：UP 默认目标角色 → 目的地引用 → 凭据；系统群单独配置。"""
    ups = {UID: {}}
    destinations = {}
    if up is not None:
        ups[UID]["up"] = "up-room"
        destinations["up-room"] = {"webhook": up}
    if full is not None:
        ups[UID]["all"] = "all-room"
        destinations["all-room"] = {"webhook": full}
    dynamics = {}
    for dynamic_id, webhook in (overrides or {}).items():
        reference = f"up-{dynamic_id}"
        dynamics[dynamic_id] = {"up": reference}
        destinations[reference] = {"webhook": webhook}
    mapping = {"base_url": base_url, "ups": ups, "dynamics": dynamics, "destinations": destinations}
    if system is not None:
        destinations["system-room"] = {"webhook": system}
        mapping["system"] = "system-room"
    return mapping


def config(**sections):
    return NotificationConfig.from_mapping(config_mapping(**sections))


def write_config(path, **sections):
    path.write_text(json.dumps(config_mapping(**sections), ensure_ascii=False))
    return path


def query(path, sql, parameters=()):
    with sqlite3.connect(path) as connection:
        connection.row_factory = sqlite3.Row
        return [dict(row) for row in connection.execute(sql, parameters)]


def deliveries(path):
    rows = query(path, """SELECT d.id AS delivery_id, d.role, d.state, d.attempts, d.due_at,
        d.lease_until, d.token, d.error, d.sent_at, d.failures, d.last_failed_at,
        e.id AS event_id, e.kind, e.uid, e.dynamic_id, e.version, e.snapshot
        FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
        ORDER BY d.id""")
    for row in rows:
        row["snapshot"] = json.loads(row["snapshot"])
    return rows


def events(path):
    return query(path, "SELECT * FROM notification_events ORDER BY id")


def assert_no_credentials(path, *secrets):
    """发件箱与事件不得出现 webhook 等凭据。"""
    with sqlite3.connect(path) as connection:
        for table in ("notification_events", "notification_deliveries"):
            dump = json.dumps([list(row) for row in connection.execute(f"SELECT * FROM {table}")],
                              ensure_ascii=False)
            for secret in secrets:
                assert secret not in dump, f"credential leaked into {table}"


class Clock:
    """通知进程受控时钟：只替换时间来源，不改变领取/租约/退避逻辑。"""

    def __init__(self, now=1_000_000.0):
        self.value = now

    def now(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds

    async def sleep(self, seconds):
        self.advance(seconds)


def message_text(payload):
    """把富文本载荷压成可断言的文本，避免逐字重写整棵节点树。"""
    paragraphs = payload["content"]["post"]["zh_cn"]["content"]
    return "\n".join(
        "".join(node.get("text", "") for node in paragraph) for paragraph in paragraphs)
