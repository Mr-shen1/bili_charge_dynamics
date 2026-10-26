"""票据 10：三进程（API＋独立采集＋独立通知）集成装配，只替换外部来源/媒体/上传。

生产代码路径不变：`create_app` 返回真实 FastAPI 应用（仅注入受控来源与媒体传输），
`python -m backend.tests.delivery_fixture --database PATH` 运行真实 Collector 的锁、
固定节拍与信号处理；通知进程仍是 `python -m backend.bili_monitor.notifier`。

受控状态文件（`DELIVERY_FIXTURE_STATE`，JSON）允许测试在两个采集节拍之间切换正文版本、
评论/回复集合与受控分页失败，不需要重启任何进程：

    {"dynamics": {
       "123": {
         "uid": "202", "title": "虚构标题", "version": "v1", "text": "第一版正文",
         "comments": {"size": 45, "fresh": [1], "fresh_other": [30],
                      "pure_image": 2, "long": 3, "fail_pages": [2],
                      "reply_root": "860001", "reply_size": 25,
                      "fresh_replies": [22], "fail_reply_pages": []},
         "media_fail": false}}}

`DELIVERY_FIXTURE_REQUESTS`（可选）记录本进程累计的外部来源请求，供“只读读取不触发采集”断言。
身份、动态、评论、媒体与凭据全部虚构；不读取真实配置，也不访问真实 B 站或飞书。
"""

import argparse
import asyncio
import copy
import json
import os
from pathlib import Path
import signal
import time

import httpx

from backend.bili_monitor.app import create_app as production_app
from backend.bili_monitor.collector import Collector
from backend.bili_monitor.media import ImageDownloader
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import readable_html
from backend.tests.root_notification_support import detail_item, reply_item, root_comment


STATE_PATH_NAME = "state.json"
REQUESTS_PATH_NAME = "source-requests.log"
MEDIA_SOURCE = "https://i0.hdslb.com/delivery-fixture/source.png"
PUBLIC_MEDIA = "https://media.example.invalid/delivery.png"
MEDIA_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x04\x00\x00\x00"
    b"\xb5\x1c\x0c\x02\x00\x00\x00\x0bIDATx\xdac\xfc\xff\x1f\x00\x03\x03\x02\x00\xef\xa3E\x99"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)
EDIT_TIMES = {"v1": "2026年10月26日 09:01", "v2": "2026年10月26日 09:02", "v3": "2026年10月26日 09:03"}


def state_path():
    path = os.environ.get("DELIVERY_FIXTURE_STATE")
    if not path:
        raise RuntimeError("DELIVERY_FIXTURE_STATE is required for the delivery fixture")
    return Path(path)


def load_state():
    path = state_path()
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {"dynamics": {}}


def record_request(request):
    path = os.environ.get("DELIVERY_FIXTURE_REQUESTS")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as log:
        log.write(f"{request.url.path}\n")


def fresh_ctime():
    return int(time.time()) + 60


def page_html(spec, uid, dynamic):
    """正文页面：标题缺失时省略 TITLE 模块（生产解析回退动态 ID），版本决定可信编辑时间。"""
    media = [] if spec.get("media_fail") else [{"url": MEDIA_SOURCE, "width": 640, "height": 480}]
    html = readable_html(text=spec.get("text", f"虚构正文 {dynamic}"), id=dynamic,
                         title=spec.get("title"), pictures=media)
    html = html.replace('"mid":"900719925474099312345"', f'"mid":"{uid}"')
    edited = EDIT_TIMES.get(spec.get("version", "v1"), EDIT_TIMES["v1"])
    return html.replace('"pub_time":"编辑于 2026年10月09日 13:01"', f'"pub_time":"编辑于 {edited}"')


def root_items(dynamic, spec):
    comments = spec.get("comments") or {}
    size = int(comments.get("size", 0))
    fresh = set(comments.get("fresh") or ())
    fresh_other = set(comments.get("fresh_other") or ())
    pure_image = comments.get("pure_image")
    long_index = comments.get("long")
    owner_name = spec.get("name", "虚构作者")
    items = []
    for index in range(1, size + 1):
        self_authored = index in fresh
        other_authored = index in fresh_other
        author = spec["uid"] if self_authored else spec.get("other_uid", "707") if other_authored else "909001"
        nickname = owner_name if self_authored else "虚构串门 UP" if other_authored else "虚构楼主"
        ctime = fresh_ctime() if self_authored or other_authored else 1791513496 - index
        text = f"虚构一级评论 {index}\n第二行：换行与 emoji 🙂"
        pictures = []
        if pure_image == index:
            text, pictures = "", [MEDIA_SOURCE]
        if long_index == index:
            text = "超长正文" + "。".join(["内容较长"] * 6000) + "结尾"
        item = root_comment(860000 + index, author=author, nickname=nickname, ctime=ctime,
                            text=text, pictures=pictures, like=size - index)
        item["rcount"] = 0
        items.append(item)
    if comments.get("reply_root"):
        root = next((item for item in items if item["rpid_str"] == comments["reply_root"]), None)
        if root is not None:
            root["rcount"] = int(comments.get("reply_size", 0))
    return items


def reply_items(dynamic, spec, root_id):
    comments = spec.get("comments") or {}
    size = int(comments.get("reply_size", 0))
    fresh = set(comments.get("fresh_replies") or ())
    owner_name = spec.get("name", "虚构作者")
    items = []
    for index in range(1, size + 1):
        self_authored = index in fresh
        author = spec["uid"] if self_authored else "909002"
        nickname = owner_name if self_authored else "虚构回复者"
        ctime = fresh_ctime() if self_authored else 1791513600 + index
        item = reply_item(960000 + index, root=root_id, author=author, nickname=nickname,
                          ctime=ctime, text=f"虚构回复 {index}\n第二行：换行与 emoji 🙂")
        items.append(item)
    return items


class DeliverySource:
    """按状态文件实时应答页面/detail/计数/根评论/楼中楼；状态变化不需要重启进程。"""

    def __call__(self, request):
        record_request(request)
        state = load_state().get("dynamics") or {}
        path = request.url.path
        if path == "/x/web-interface/card":
            return self.profile(request, state)
        if path.startswith("/opus/"):
            dynamic = path.rsplit("/", 1)[-1]
            spec = state.get(dynamic)
            if spec is None:
                return httpx.Response(404)
            return httpx.Response(200, text=page_html(spec, spec["uid"], dynamic))
        if path == "/x/polymer/web-dynamic/v1/detail":
            dynamic = request.url.params.get("id", "")
            spec = state.get(dynamic)
            if spec is None:
                return httpx.Response(404)
            count = int((spec.get("comments") or {}).get("size", 0))
            return httpx.Response(200, json=detail_item(dynamic, spec["uid"], count))
        if path == "/x/v2/reply/count":
            dynamic = self.dynamic_for(request.url.params.get("oid", ""), state)
            spec = state.get(dynamic) if dynamic else None
            count = int((spec.get("comments") or {}).get("size", 0)) if spec else 0
            return httpx.Response(200, json={"code": 0, "data": {"count": count}})
        if path == "/x/v2/reply":
            dynamic = self.dynamic_for(request.url.params.get("oid", ""), state)
            spec = state.get(dynamic) if dynamic else None
            if spec is None:
                return httpx.Response(404)
            comments = spec.get("comments") or {}
            page = int(request.url.params.get("pn", "1"))
            if page in set(comments.get("fail_pages") or ()):
                raise httpx.ReadError("FICTIONAL_DELIVERY_COMMENT_PAGE")
            items = root_items(dynamic, spec)
            return httpx.Response(200, json={"code": 0, "data": {
                "page": {"num": page, "size": 20, "count": len(items), "acount": len(items)},
                "upper": {"mid": int(spec["uid"]), "top": None}, "hots": [],
                "replies": copy.deepcopy(items[(page - 1) * 20:page * 20]) or None,
            }})
        if path == "/x/v2/reply/reply":
            dynamic = self.dynamic_for(request.url.params.get("oid", ""), state)
            spec = state.get(dynamic) if dynamic else None
            if spec is None:
                return httpx.Response(404)
            comments = spec.get("comments") or {}
            root_id = request.url.params.get("root", "")
            roots = root_items(dynamic, spec)
            root = next((item for item in roots if item["rpid_str"] == root_id), None)
            if root is None:
                return httpx.Response(404)
            page = int(request.url.params.get("pn", "1"))
            if page in set(comments.get("fail_reply_pages") or ()):
                raise httpx.ReadError("FICTIONAL_DELIVERY_REPLY_PAGE")
            items = reply_items(dynamic, spec, root_id)
            payload_root = copy.deepcopy(root)
            payload_root["rcount"] = len(items)
            return httpx.Response(200, json={"code": 0, "data": {
                "page": {"num": page, "size": 20, "count": len(items)},
                "root": payload_root,
                "replies": copy.deepcopy(items[(page - 1) * 20:page * 20]) or None,
            }})
        raise RuntimeError("Unexpected delivery fixture request")

    @staticmethod
    def profile(request, state):
        mid = request.url.params.get("mid")
        if mid == "303":
            raise httpx.ConnectError("FAKE_DELIVERY_SECRET_10_NEVER_REAL", request=request)
        known = {spec["uid"]: spec for spec in state.values()}
        spec = known.get(mid)
        if spec is None:
            return httpx.Response(200, json={"code": -404})
        return httpx.Response(200, json={"code": 0, "data": {"card": {
            "mid": mid, "name": spec.get("name", "虚构作者"),
            "face": "https://example.invalid/avatar.png",
        }}})

    @staticmethod
    def dynamic_for(oid, state):
        for dynamic in state:
            if oid in (dynamic, "99" + dynamic):
                return dynamic
        return None


def download(request):
    if request.method != "GET" or str(request.url) != MEDIA_SOURCE:
        raise RuntimeError("Unexpected delivery fixture media request")
    return httpx.Response(200, content=MEDIA_BYTES, headers={"content-type": "image/png"})


class DeliveryUploader:
    """媒体上传：状态可让本轮上传失败，用来证明正文成功不等待媒体。"""

    async def upload(self, key, content, content_type):
        if content != MEDIA_BYTES or content_type != "image/png":
            raise RuntimeError("Unexpected delivery fixture upload")
        state = load_state().get("dynamics") or {}
        if any(spec.get("media_fail") for spec in state.values()):
            raise RuntimeError("FAKE_DELIVERY_MEDIA_FAILURE")
        return PUBLIC_MEDIA


def source_client():
    return httpx.AsyncClient(transport=httpx.MockTransport(DeliverySource()), trust_env=False)


def media_client():
    return httpx.AsyncClient(transport=httpx.MockTransport(download), trust_env=False)


def create_app():
    database = os.environ.get("BILI_DATABASE_PATH")
    if not database:
        raise RuntimeError("BILI_DATABASE_PATH is required for the delivery fixture")
    # 与生产一致的应用装配，只替换外部来源与媒体传输。
    return production_app(database, profile_transport=httpx.MockTransport(DeliverySource()),
                          media_transport=httpx.MockTransport(download), media_uploader=DeliveryUploader())


async def serve(database):
    async with source_client() as source, media_client() as media:
        collector = Collector(Store(database), source, ImageDownloader(media), DeliveryUploader())
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


def main():
    parser = argparse.ArgumentParser(description="Isolated three-process delivery fixture collector")
    parser.add_argument("--database", required=True)
    arguments = parser.parse_args()
    try:
        asyncio.run(serve(arguments.database))
    except KeyboardInterrupt:
        pass
    except Exception:
        raise SystemExit("Delivery fixture collector failed") from None


if __name__ == "__main__":
    main()
