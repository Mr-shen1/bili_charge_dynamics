"""04：根评论通知的测试装配 —— 真实归档链、临时 SQLite、受控来源与飞书接收端。

只替换外部 HTTP（B 站页面/detail/评论页、飞书 webhook）与时间来源；正文与评论解析、
检查、归档写事务、通知阶段/候选/事件生成、路由、格式与投递调度全部使用生产代码。
身份、动态、评论与凭据均为虚构值。
"""

import copy
import json
import time

import httpx

from backend.bili_monitor.notifications import Dispatcher
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client, detail_json, readable_html
from backend.tests.collector_support import open_notifications
from backend.tests.management_support import BASE, UID
from backend.tests.notification_support import (  # noqa: F401  重用 01 装配，避免第二套替身
    ALL_WEBHOOK, BASE_URL, WEBHOOK, Clock, Receiver, config, config_mapping, deliveries, events,
    message_text, query,
)

DYNAMIC = "123"
OTHER_DYNAMIC = "456"
SAME_NAME = "虚构星海"

# 固定「晚于任何真实起点」的发表时间：2027-01-01T00:00:00+08:00，用于模板字面断言。
FUTURE_CTIME = 1798732800


def dispatcher(path, *, transport, clock=None, **sections):
    return Dispatcher(Store(path), config(**sections), transport=transport, clock=clock)


def configure(path, source, uid=UID, ids=(DYNAMIC,)):
    """经公开管理 HTTP 建立身份、指定模式与目标；启用即建立通知阶段起点。

    目标归属校验仍走上游（受控来源），不放宽或绕过真实校验。
    """
    with archive_client(path, source) as api:
        assert api.post(BASE, json={"uid": uid}).status_code == 201
        assert api.patch(f"{BASE}/{uid}/monitor",
                         json={"mode": "specified", "recent_n": 10, "enabled": True}).status_code == 200
        for id in ids:
            assert api.post(f"{BASE}/{uid}/targets", json={"id": id}).status_code == 201
    open_notifications(path)


def started_at(path, uid=UID, dynamic_id=DYNAMIC):
    """持久通知起点：边界用例以它为准，不用采集时间冒充发表时间。"""
    rows = query(path, "SELECT started_at FROM notification_phases"
                       " WHERE uid = ? AND dynamic_id = ? AND sealed = 0", (uid, dynamic_id))
    return rows[0]["started_at"]


def root_comment(id, *, author=UID, nickname=SAME_NAME, ctime=FUTURE_CTIME, text="虚构评论",
                 pictures=(), rcount=0, like=0):
    """来源格式的一级评论；缺字段时保持缺失（不伪造），由归档链照常处理。"""
    member = {} if author is None else {"mid": author}
    if nickname is not None:
        member["uname"] = nickname
    item = {
        "rpid_str": str(id), "root": 0, "root_str": "0", "parent": 0, "parent_str": "0",
        "ctime": ctime, "like": like, "rcount": rcount, "member": member,
        "content": {"message": text}, "replies": None,
    }
    if ctime is None:
        item.pop("ctime")
    pictures = list(pictures)
    if pictures is not None:
        item["content"]["pictures"] = [
            {"img_src": url, "img_width": 640, "img_height": 480} for url in pictures]
    return item


def page_html(uid, id):
    html = readable_html(id=id, pictures=[])
    return html.replace('"mid":"900719925474099312345"', f'"mid":"{uid}"')


def detail_item(id, uid, count):
    payload = copy.deepcopy(detail_json())
    item = payload["data"]["item"]
    item["id_str"] = id
    item["basic"] = {"comment_id_str": "99" + id, "comment_type": 17, "rid_str": "99" + id}
    item["modules"]["module_author"]["mid"] = uid
    item["modules"]["module_author"]["pub_ts"] = FUTURE_CTIME
    item["modules"]["module_stat"]["comment"]["count"] = count
    item["modules"]["module_dynamic"]["major"]["opus"]["pics"] = []
    return payload


class Source:
    """受控来源：每个动态自带作者、根评论与可控分页失败，只替换外部 HTTP。"""

    def __init__(self):
        self.dynamics = {}
        self.calls = []

    def add(self, dynamic, roots, *, uid=UID, count=None):
        for item in roots:
            item["oid"], item["type"] = int("99" + dynamic), 17
        self.dynamics[dynamic] = {
            "uid": uid, "roots": list(roots),
            "count": len(roots) if count is None else count, "fail_pages": set(),
            "reply_threads": {}}
        return self

    def replace(self, dynamic, roots):
        return self.add(dynamic, roots, uid=self.dynamics[dynamic]["uid"])

    def replies(self, dynamic, root_id, items, *, fail_pages=()):
        """登记某楼完整回复集合；根页 rcount 与楼中楼 count 都按登记条数下发。"""
        spec = self.dynamics[dynamic]
        items = list(items)
        for item in items:
            # 来源按请求回显资源身份；不一致的条目会被生产解析器当作其它资源拒绝。
            item["oid"], item["type"] = int("99" + dynamic), 17
        spec["reply_threads"][root_id] = {"items": items, "fail_pages": set(fail_pages)}
        root = next((item for item in spec["roots"] if item["rpid_str"] == root_id), None)
        if root is not None:
            root["rcount"] = len(items)
        return self

    def replace_replies(self, dynamic, root_id, items, *, fail_pages=()):
        return self.replies(dynamic, root_id, items, fail_pages=fail_pages)

    def spec(self, dynamic):
        return self.dynamics[dynamic]

    def by_oid(self, oid):
        return next((spec for dynamic, spec in self.dynamics.items()
                     if oid in ("99" + dynamic, dynamic)), None)

    def __call__(self, request):
        path = request.url.path
        self.calls.append((path, dict(request.url.params)))
        if path.startswith("/opus/"):
            dynamic = path.rsplit("/", 1)[-1]
            spec = self.dynamics.get(dynamic)
            if spec is None:
                return httpx.Response(404)
            return httpx.Response(200, text=page_html(spec["uid"], dynamic))
        if path == "/x/polymer/web-dynamic/v1/detail":
            dynamic = request.url.params["id"]
            spec = self.dynamics.get(dynamic)
            if spec is None:
                return httpx.Response(404)
            return httpx.Response(200, json=detail_item(dynamic, spec["uid"], spec["count"]))
        if path == "/x/v2/reply/count":
            spec = self.by_oid(request.url.params["oid"])
            return httpx.Response(200, json={"code": 0, "data": {"count": spec["count"] if spec else 0}})
        if path == "/x/v2/reply":
            spec = self.by_oid(request.url.params["oid"])
            if spec is None:
                raise AssertionError("Unexpected comment resource")
            page = int(request.url.params["pn"])
            if page in spec["fail_pages"]:
                raise httpx.ReadError("FICTIONAL_SECRET_COMMENT_PAGE")
            roots = spec["roots"]
            return httpx.Response(200, json={"code": 0, "data": {
                "page": {"num": page, "size": 20, "count": len(roots), "acount": len(roots)},
                "upper": {"mid": int(spec["uid"]), "top": None}, "hots": [],
                "replies": copy.deepcopy(roots[(page - 1) * 20:page * 20]) or None,
            }})
        if path == "/x/v2/reply/reply":
            # 楼中楼页：未登记回复的楼回确认空页，仍回显同根身份。
            spec = self.by_oid(request.url.params["oid"])
            if spec is None:
                raise AssertionError("Unexpected reply resource")
            root_id = request.url.params["root"]
            root = next((item for item in spec["roots"] if item["rpid_str"] == root_id), None)
            if root is None:
                return httpx.Response(404)
            page = int(request.url.params["pn"])
            thread = spec["reply_threads"].get(root_id) or {"items": [], "fail_pages": set()}
            if page in thread["fail_pages"]:
                raise httpx.ReadError("FICTIONAL_SECRET_REPLY_PAGE")
            items = thread["items"]
            payload_root = copy.deepcopy(root)
            payload_root["rcount"] = len(items)
            return httpx.Response(200, json={"code": 0, "data": {
                "page": {"num": page, "size": 20, "count": len(items)},
                "root": payload_root,
                "replies": copy.deepcopy(items[(page - 1) * 20:page * 20]) or None,
            }})
        raise AssertionError("Unexpected upstream request")


def archive_text(path, dynamic=DYNAMIC):
    document = Store(path).read_archive(dynamic)
    return document["text"]


def root_documents(path, dynamic=DYNAMIC):
    return {row["id"]: json.loads(row["document"]) for row in query(
        path, "SELECT id, document FROM root_comments WHERE dynamic_id = ? ORDER BY id", (dynamic,))}


def reply_documents(path, dynamic=DYNAMIC):
    return {row["id"]: json.loads(row["document"]) for row in query(
        path, "SELECT id, document FROM replies WHERE dynamic_id = ? ORDER BY id", (dynamic,))}


def phase_start_epoch(path, uid=UID, dynamic_id=DYNAMIC):
    return time.time() if not query(path, "SELECT 1 FROM notification_phases") else started_at(
        path, uid, dynamic_id)


def reply_item(id, *, root=None, author=UID, nickname="虚构回复者", ctime=FUTURE_CTIME,
               text="虚构回复", parent=None, pictures=()):
    """来源格式的楼中楼回复；缺字段时保持缺失（不伪造），由归档链照常处理。

    `root` 是所属根评论；`parent` 缺省即直接回根（不附带父评论正文）。
    """
    member = {} if author is None else {"mid": author}
    if nickname is not None:
        member["uname"] = nickname
    item = {
        "rpid_str": str(id), "root": 0, "root_str": str(root), "parent": 0,
        "parent_str": str(root if parent is None else parent),
        "ctime": ctime, "like": 0, "rcount": 0, "member": member,
        "content": {"message": text}, "replies": None,
    }
    if ctime is None:
        item.pop("ctime")
    pictures = list(pictures)
    if pictures is not None:
        item["content"]["pictures"] = [
            {"img_src": url, "img_width": 640, "img_height": 480} for url in pictures]
    return item


def reply_locate(payload):
    """从富文本载荷的链接节点取实际生成的回复入口身份（所属根，目标回复）。"""
    for paragraph in payload["content"]["post"]["zh_cn"]["content"]:
        for node in paragraph:
            if node.get("tag") != "a":
                continue
            path = node["href"].split("://", 1)[-1].split("/", 1)[-1].split("/")
            if (len(path) == 7 and path[0] == "dynamics" and path[2] == "comments"
                    and path[4] == "replies" and path[6] == "locate"):
                return path[3], path[5]
    return None


def delivered_replies(receiver):
    """实际发往哪个目的地、携带哪条回复：只统计回复消息，一级评论不计入。"""
    located = ((reply_locate(payload), request["url"])
               for request, payload in zip(receiver.requests, receiver.payloads))
    return sorted(item for item in located if item[0] is not None)


OTHER_UID = "202"
OTHER_UP_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/fake-up-202"
OTHER_ALL_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/fake-all-202"
SYSTEM_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/fake-system"


def two_up_mapping(*, up=WEBHOOK, full=ALL_WEBHOOK, other_up=OTHER_UP_WEBHOOK,
                   other_all=OTHER_ALL_WEBHOOK, system=SYSTEM_WEBHOOK):
    """两个 UP 的默认双群路由＋顶层系统群；目的地只存引用，凭据仍只在 destinations。"""
    mapping = config_mapping(up=up, full=full)
    mapping["ups"][OTHER_UID] = {"up": "up-202", "all": "all-202"}
    mapping["system"] = "system-room"
    mapping["destinations"].update({
        "up-202": {"webhook": other_up}, "all-202": {"webhook": other_all},
        "system-room": {"webhook": system},
    })
    return mapping


def comment_id(payload):
    """从富文本载荷的链接节点取实际生成的评论身份，不重新拼一遍入口。"""
    for paragraph in payload["content"]["post"]["zh_cn"]["content"]:
        for node in paragraph:
            if node.get("tag") != "a":
                continue
            path = node["href"].split("://", 1)[-1].split("/", 1)[-1].split("/")
            if len(path) == 5 and path[0] == "dynamics" and path[2] == "comments" and path[4] == "locate":
                return path[3]
    return None


def delivered(receiver):
    """实际发往哪个目的地、携带哪条评论：以接收端收到的请求为准。"""
    return sorted((comment_id(payload), request["url"])
                  for request, payload in zip(receiver.requests, receiver.payloads))
