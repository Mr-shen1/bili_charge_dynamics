"""动态图的独立外部 I/O；网络与上传均在 SQLite 事务外执行。"""

from uuid import uuid4
from urllib.parse import urlsplit
from typing import Protocol

from anyio import to_thread

from .source import safe_url
from .contracts import APIError


class MediaUploader(Protocol):
    async def upload(self, key: str, content: bytes, content_type: str) -> str: ...


def is_public_media_url(url):
    if safe_url(url) is None:
        return False
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    return not (parsed.query or parsed.fragment or any(
        host == domain or host.endswith("." + domain)
        for domain in ("hdslb.com", "biliimg.com", "bilibili.com")
    ))


def reconcile_media(document, sources, version):
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
    complete = all(item["status"] == "success" for item in current)
    document["work"]["media"] = (
        "success" if complete and document.get("observed_version") == version else "pending"
    )
    document["media_last_attempt"] = "success" if complete else "pending"
    document.setdefault("synced_media_version", None)
    if complete:
        document["synced_media_version"] = version


class ImageDownloader:
    def __init__(self, client):
        self.client = client

    async def download(self, url):
        # 来源是上游数据，不允许据此访问任意主机、内部服务或携带鉴权参数。
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        default_port = 443 if parsed.scheme == "https" else 80
        if (safe_url(url, allow_http=True) is None or parsed.port not in (None, default_port)
                or not any(host.endswith("." + domain) or host == domain
                           for domain in ("hdslb.com", "biliimg.com"))):
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
            if not is_public_media_url(public_url):
                raise ValueError("Invalid public media URL")
            error = None
        except Exception:
            # 不保存异常文本、HTTP headers、签名 URL 或 OSS 凭据。
            public_url = None
        accepted = await to_thread.run_sync(store.finish_media, id, item["id"], token, public_url, error)
        result["succeeded" if accepted and error is None else "failed"] += 1
    return result
