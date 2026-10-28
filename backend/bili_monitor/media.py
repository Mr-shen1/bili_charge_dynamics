"""动态图与根评论图共用的外部 I/O；网络与上传均在 SQLite 事务外执行。"""

from uuid import uuid4
from urllib.parse import urlsplit
from typing import Protocol

from anyio import to_thread

from .source import safe_url
from .source_endpoints import IMAGE_DOMAINS, image_endpoint_type, note_business_success
from .contracts import APIError
from .collector_logging import collector_event, collector_failure, source_refs
from .risk import SourceRiskPaused


class MediaUploader(Protocol):
    async def upload(self, key: str, content: bytes, content_type: str) -> str: ...


IMAGE_SOURCE_DOMAINS = tuple(domain for domain, _ in IMAGE_DOMAINS)
IMAGE_EXTENSIONS = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/pjpeg": ".jpg",
    "image/png": ".png", "image/x-png": ".png", "image/apng": ".apng",
    "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif",
    "image/bmp": ".bmp", "image/x-ms-bmp": ".bmp", "image/tiff": ".tiff",
    "image/svg+xml": ".svg", "image/x-icon": ".ico", "image/vnd.microsoft.icon": ".ico",
    "image/heic": ".heic", "image/heif": ".heif", "image/jxl": ".jxl",
}


def is_image_source_host(host):
    return image_endpoint_type(host) is not None


def is_archive_delivery_url(url):
    """校验无签名归档交付地址，不保证真实对象已可匿名访问。"""
    if safe_url(url) is None:
        return False
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    return not (parsed.query or parsed.fragment or is_image_source_host(host)
                or host == "bilibili.com" or host.endswith(".bilibili.com"))


def _comment_version_count(version):
    """根评论媒体版本形如 comments:<来源评论总数>；无法解析时返回 -1（视为不领先）。"""
    if not isinstance(version, str) or not version.startswith("comments:"):
        return -1
    try:
        return int(version.split(":", 1)[1])
    except ValueError:
        return -1


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


def reconcile_media(document, sources, version, *, empty_confirmed=True, owner_type="dynamic"):
    """只由实际提交正文/来源调用，不作为编辑检测器。"""
    previous = document.get("media", [])
    same_version = document.get("media_version") == version
    current = []
    for position, source in enumerate(sources):
        old = next((item for item in previous if item["position"] == position
                    and item["source_url"] == source["url"]), None)
        # 新版本的未完成关联用新 ID fencing；不能接受旧版本的迟到完成。
        item = dict(old) if old and same_version else {
            "id": uuid4().hex, "owner": {"type": owner_type, "id": document["id"]},
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
        # 图片验证成功也是一次成功业务请求；域族只是分类，不影响“确已取到图片”的事实。
        note_business_success(self.client, image_endpoint_type(host))
        return response.content, content_type


async def _download_and_upload(store, downloader, uploader, id, item, token, root_id, *, now=None):
    """单图步骤：下载与上传都不持 SQLite 写事务；来源许可只包住下载。"""
    error, public_url = "MEDIA_DOWNLOAD_FAILED", None
    try:
        content, content_type = await downloader.download(item["source_url"])
        # 来源 URL 可能无后缀或与响应格式不同，按下载响应的 MIME 选择固定后缀。
        extension = IMAGE_EXTENSIONS.get(content_type)
        if extension is None:
            raise ValueError("Unsupported image content type")
        error = "MEDIA_UPLOAD_FAILED"
        owner_path = (f"bili-charge/dynamics/{id}" if root_id is None
                      else f"bili-charge/comments/{id}/{root_id}")
        public_url = await uploader.upload(f"{owner_path}/{item['id']}/{token}{extension}", content, content_type)
        if not is_archive_delivery_url(public_url):
            raise ValueError("Invalid public media URL")
        error = None
    except SourceRiskPaused:
        # 保护暂停不是下载失败：不记账、不继续下一张，已成功的媒体保留。
        raise
    except Exception as exception:
        # 不保存异常文本、HTTP headers、签名 URL 或 OSS 凭据。
        collector_failure("media_sync_failed", exception,
                          stage="download" if error == "MEDIA_DOWNLOAD_FAILED" else "upload",
                          **source_refs(dynamic_id=id, root_id=root_id))
        public_url = None
    accepted = await to_thread.run_sync(store.finish_media, id, item["id"], token, public_url, error, root_id,
                                       now() if now else None)
    return accepted and error is None


async def media_step(store, downloader, uploader, id, root_id=None, *, media_id=None,
                     current_only=False, now=None, skip=()):
    """推进一个可提交的单图步骤；没有可处理图片时返回 None。

    08 把「一张图」当作调度片：下载、提交与 OSS 上传都在这一步完成，但 OSS 上传
    不经过来源许可。返回 `processed/succeeded/failed` 供调度层记录一次让出。
    """
    archive = await to_thread.run_sync(store.read_media_owner, id, root_id)
    if archive is None:
        return None
    items = archive["media"]
    if media_id is not None:
        items = [item for item in items if item["id"] == media_id]
    stale_version = archive["media_version"] != archive["observed_version"]
    if current_only and stale_version and root_id is not None and not items and not archive.get("media_sources"):
        if _comment_version_count(archive["media_version"]) > _comment_version_count(archive["observed_version"]):
            await to_thread.run_sync(store.settle_empty_media, id, root_id, archive["observed_version"])
            return None
    if uploader is None or (current_only and stale_version):
        return None
    skip = set(skip)
    for item in items:
        if item["status"] == "success" or item["id"] in skip:
            continue
        token = await to_thread.run_sync(store.claim_media, id, item["id"], root_id)
        if token is None:
            continue
        succeeded = await _download_and_upload(store, downloader, uploader, id, item, token,
                                               root_id, now=now)
        collector_event("media_sync_finished", processed=1, succeeded=int(succeeded),
                        failed=int(not succeeded), **source_refs(dynamic_id=id, root_id=root_id))
        return {"processed": 1, "succeeded": int(succeeded), "failed": int(not succeeded),
                "media_id": item["id"]}
    return None


async def sync_media(store, downloader, uploader, id, current_only=False, media_id=None, root_id=None, *, now=None):
    archive = await to_thread.run_sync(store.read_media_owner, id, root_id)
    if archive is None:
        raise APIError("NOT_FOUND")
    items = archive["media"]
    if media_id is not None:
        items = [item for item in items if item["id"] == media_id]
        if not items:
            raise APIError("NOT_FOUND")
    result = {"processed": 0, "succeeded": 0, "failed": 0}
    stale_version = archive["media_version"] != archive["observed_version"]
    if current_only and stale_version and root_id is not None and not items and not archive.get("media_sources"):
        # 只有「媒体版本反而领先观察版本」（计数回落）才结算：此时新快照不可能新增图片。
        # 观察版本更新但媒体还没跟上时不结算，避免用未成功的观察推进媒体。
        if _comment_version_count(archive["media_version"]) > _comment_version_count(archive["observed_version"]):
            await to_thread.run_sync(store.settle_empty_media, id, root_id, archive["observed_version"])
            return result
    if uploader is None or (current_only and stale_version):
        return result
    for item in items:
        if item["status"] == "success":
            continue
        token = await to_thread.run_sync(store.claim_media, id, item["id"], root_id)
        if token is None:
            continue
        result["processed"] += 1
        if await _download_and_upload(store, downloader, uploader, id, item, token, root_id, now=now):
            result["succeeded"] += 1
        else:
            result["failed"] += 1
    if result["processed"]:
        # 每轮媒体处理一条摘要：每张图的逐条结果仍在失败事件与新下载提交里。
        collector_event("media_sync_finished", processed=result["processed"], succeeded=result["succeeded"],
                        failed=result["failed"], **source_refs(dynamic_id=id, root_id=root_id))
    return result
