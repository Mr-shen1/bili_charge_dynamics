"""动态图的独立外部 I/O；网络与上传均在 SQLite 事务外执行。"""

from uuid import uuid4
from urllib.parse import urlsplit
from typing import Protocol

from anyio import to_thread

from .source import safe_url
from .contracts import APIError


class MediaUploader(Protocol):
    async def upload(self, key: str, content: bytes, content_type: str) -> str: ...


IMAGE_SOURCE_DOMAINS = ("hdslb.com", "biliimg.com")


def is_image_source_host(host):
    return any(host == domain or host.endswith("." + domain) for domain in IMAGE_SOURCE_DOMAINS)


def is_archive_delivery_url(url):
    """校验无签名归档交付地址，不保证真实对象已可匿名访问。"""
    if safe_url(url) is None:
        return False
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    return not (parsed.query or parsed.fragment or is_image_source_host(host)
                or host == "bilibili.com" or host.endswith(".bilibili.com"))


def refresh_media_progress(document, *, empty_confirmed=True):
    """按单图结果聚合；迁移中没有成功正文的空来源不能确认媒体成功空。"""
    items = document["media"]
    complete = (bool(items) or empty_confirmed) and all(item["status"] == "success" for item in items)
    document["work"]["media"] = (
        "success" if complete and document.get("observed_version") == document["media_version"] else "pending"
    )
    document["media_last_attempt"] = (
        "success" if complete else "failed" if any(item["status"] == "failed" for item in items) else "pending"
    )
    document.setdefault("synced_media_version", None)
    if complete:
        document["synced_media_version"] = document["media_version"]


def reconcile_media(document, sources, version, *, empty_confirmed=True):
    """只由实际提交正文/来源调用，不作为编辑检测器。"""
    previous = document.get("media", [])
    same_version = document.get("media_version") == version
    current = []
    for position, source in enumerate(sources):
        old = next((item for item in previous if item["position"] == position
                    and item["source_url"] == source["url"]), None)
        # 新版本的未完成关联用新 ID fencing；不能接受旧版本的迟到完成。
        item = dict(old) if old and same_version else {
            "id": uuid4().hex, "owner": {"type": "dynamic", "id": document["id"]},
            "position": position, "source_url": source["url"],
            "public_url": None, "status": "pending", "error": None,
        }
        item.update(width=source["width"], height=source["height"], version=version)
        current.append(item)
    retained = document.setdefault("previous_media", [])
    ids = {item["id"] for item in current + retained}
    retained.extend(item for item in previous if item["status"] == "success" and item["id"] not in ids)
    document.update(media=current, media_version=version)
    refresh_media_progress(document, empty_confirmed=empty_confirmed)


class ImageDownloader:
    def __init__(self, client):
        self.client = client

    async def download(self, url):
        # 来源是上游数据，不允许据此访问任意主机、内部服务或携带鉴权参数。
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        default_port = 443 if parsed.scheme == "https" else 80
        if (safe_url(url, allow_http=True) is None or parsed.port not in (None, default_port)
                or not is_image_source_host(host)):
            raise ValueError("Unsupported media origin")
        response = await self.client.get(url)
        response.raise_for_status()
        content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if not content_type.startswith("image/") or not response.content:
            raise ValueError("Invalid image response")
        return response.content, content_type


async def sync_media(store, downloader, uploader, id, current_only=False, media_id=None):
    archive = await to_thread.run_sync(store.read_archive, id)
    if archive is None:
        raise APIError("NOT_FOUND")
    items = archive["media"]
    if media_id is not None:
        items = [item for item in items if item["id"] == media_id]
        if not items:
            raise APIError("NOT_FOUND")
    result = {"processed": 0, "succeeded": 0, "failed": 0}
    if uploader is None or (current_only and archive["media_version"] != archive["observed_version"]):
        return result
    for item in items:
        if item["status"] == "success":
            continue
        token = await to_thread.run_sync(store.claim_media, id, item["id"])
        if token is None:
            continue
        result["processed"] += 1
        error, public_url = "MEDIA_DOWNLOAD_FAILED", None
        try:
            content, content_type = await downloader.download(item["source_url"])
            error = "MEDIA_UPLOAD_FAILED"
            public_url = await uploader.upload(f"dynamics/{id}/{item['id']}/{token}", content, content_type)
            if not is_archive_delivery_url(public_url):
                raise ValueError("Invalid public media URL")
            error = None
        except Exception:
            # 不保存异常文本、HTTP headers、签名 URL 或 OSS 凭据。
            public_url = None
        accepted = await to_thread.run_sync(store.finish_media, id, item["id"], token, public_url, error)
        result["succeeded" if accepted and error is None else "failed"] += 1
    return result
