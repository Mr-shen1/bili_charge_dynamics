"""管理、归档读取与显式一次初始化 HTTP；不含周期调度。"""

import os
import sqlite3
from contextlib import asynccontextmanager

import httpx
from anyio import to_thread
from fastapi import FastAPI, Query, Request, Response
from typing import Annotated, Literal
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException

from .contracts import UID, AddUP, AddTarget, APIError, MonitorConfig, error_response
from .profiles import fetch_profile
from .safety import configure_safe_logging
from .storage import Store
from .source import verify_author
from .sync import initialize
from .media import ImageDownloader, MediaUploader, sync_media
from .oss import OSSUploader


async def run_store(function, *args):
    return await to_thread.run_sync(function, *args)


def validate_query(request, allowed=()):
    keys = [key for key, _ in request.query_params.multi_items()]
    if set(keys) - set(allowed) or len(keys) != len(set(keys)):
        raise APIError("INVALID_INPUT")


def create_app(
    database_path: str | os.PathLike[str],
    profile_transport: httpx.AsyncBaseTransport | None = None,
    media_transport: httpx.AsyncBaseTransport | None = None,
    media_uploader: MediaUploader | None = None,
) -> FastAPI:
    """启动 lifespan 时迁移指定文件数据库；transport 只替换外部 HTTP。"""
    configure_safe_logging()
    store = Store(database_path)

    @asynccontextmanager
    async def lifespan(application):
        try:
            await run_store(store.migrate)
        except (sqlite3.Error, OSError):
            raise RuntimeError("Database initialization failed") from None
        try:
            uploader = media_uploader if media_uploader is not None else OSSUploader.from_environment()
            async with httpx.AsyncClient(
                transport=profile_transport, timeout=10, trust_env=False
            ) as profiles, httpx.AsyncClient(
                transport=media_transport, timeout=30, trust_env=False
            ) as media_client:
                application.state.profiles = profiles
                application.state.downloader = ImageDownloader(media_client)
                application.state.media_uploader = uploader
                try:
                    yield
                finally:
                    if media_uploader is None and uploader is not None:
                        await to_thread.run_sync(uploader.close)
        except Exception:
            raise RuntimeError("Application lifecycle failed") from None

    application = FastAPI(lifespan=lifespan)

    @application.middleware("http")
    async def safe_failures(request, call_next):
        try:
            return await call_next(request)
        except sqlite3.Error:
            return error_response("STORAGE_UNAVAILABLE")
        except Exception:
            # 在 ASGI ServerErrorMiddleware 之前消化异常，避免服务器记录原始 traceback。
            return error_response("INTERNAL_ERROR")

    @application.exception_handler(RequestValidationError)
    async def invalid_input(request, exception):
        return error_response("INVALID_INPUT")

    @application.exception_handler(HTTPException)
    async def http_error(request, exception):
        code = "NOT_FOUND" if exception.status_code == 404 else "INVALID_INPUT"
        return error_response(code)

    @application.exception_handler(APIError)
    async def domain_error(request, exception):
        return error_response(exception.code)

    @application.post("/api/manage/ups", status_code=201)
    async def add_up(body: AddUP):
        uid = body.uid
        saved = await run_store(store.read, uid)
        if saved and saved[0]["monitor"] is not None:
            raise APIError("ALREADY_MONITORED")
        name, avatar_url = await fetch_profile(application.state.profiles, uid)
        return await run_store(store.add, uid, name, avatar_url)

    @application.get("/api/manage/ups")
    async def list_ups(request: Request):
        validate_query(request)
        return {"ups": await run_store(store.read)}

    @application.get("/api/manage/ups/{uid}")
    async def get_up(uid: UID, request: Request):
        validate_query(request)
        saved = await run_store(store.read, uid)
        if not saved:
            raise APIError("NOT_FOUND")
        return saved[0]

    @application.patch("/api/manage/ups/{uid}/monitor")
    async def update_monitor(uid: UID, body: MonitorConfig):
        return await run_store(
            store.update, uid, body.mode, body.recent_n, body.enabled
        )

    @application.delete("/api/manage/ups/{uid}/monitor", status_code=204)
    async def delete_monitor(uid: UID):
        await run_store(store.delete_monitor, uid)
        return Response(status_code=204)

    @application.post("/api/manage/ups/{uid}/targets", status_code=201)
    async def add_target(uid: UID, body: AddTarget):
        saved = await run_store(store.read, uid)
        if not saved or saved[0]["monitor"] is None:
            raise APIError("NOT_FOUND")
        # 重复关联仍复核来源，避免把已存在状态伪装成这次验证成功。
        author_id = await verify_author(application.state.profiles, body.id)
        if author_id != uid:
            raise APIError("TARGET_AUTHOR_MISMATCH")
        return await run_store(store.add_target, uid, body.id)

    @application.get("/api/manage/ups/{uid}/checks")
    async def list_checks(uid: UID, request: Request):
        validate_query(request)
        return {"checks": await run_store(store.read_checks, uid)}

    @application.get("/api/manage/ups/{uid}/targets")
    async def list_targets(uid: UID, request: Request):
        validate_query(request)
        return {"targets": await run_store(store.targets, uid)}

    @application.delete("/api/manage/ups/{uid}/targets/{id}", status_code=204)
    async def delete_target(uid: UID, id: UID):
        await run_store(store.delete_target, uid, id)
        return Response(status_code=204)

    @application.post("/api/sync/initial")
    async def initial_sync(body: AddUP):
        return await initialize(store, application.state.profiles, body.uid,
                                application.state.downloader, application.state.media_uploader)

    @application.post("/api/sync/media/{id}")
    async def retry_media(
        id: UID, request: Request,
        media_id: Annotated[str | None, Query(pattern=r"^[a-f0-9]{32}$", min_length=32, max_length=32)] = None,
    ):
        validate_query(request, ("media_id",))
        return await sync_media(store, application.state.downloader, application.state.media_uploader, id, media_id=media_id)

    @application.post("/api/sync/media/{id}/comments/{root_id}")
    async def retry_comment_media(
        id: UID, root_id: UID, request: Request,
        media_id: Annotated[str | None, Query(pattern=r"^[a-f0-9]{32}$", min_length=32, max_length=32)] = None,
    ):
        validate_query(request, ("media_id",))
        return await sync_media(store, application.state.downloader, application.state.media_uploader,
                                id, media_id=media_id, root_id=root_id)

    @application.get("/api/archive/ups")
    async def archive_ups(request: Request):
        validate_query(request)
        return {"ups": await run_store(store.archive_ups)}

    @application.get("/api/archive/dynamics")
    async def list_archive(
        request: Request,
        limit: Annotated[int, Query(ge=1, le=10)] = 10,
        cursor: Annotated[str | None, Query(max_length=64)] = None,
        scope: Literal["all", "up"] = "all",
        uid: Annotated[UID | None, Query()] = None,
    ):
        validate_query(request, ("scope", "uid", "limit", "cursor"))
        if (scope == "all" and uid is not None) or (scope == "up" and uid is None):
            raise APIError("INVALID_INPUT")
        return await run_store(store.list_archives, limit, cursor, uid)

    @application.get("/api/archive/dynamics/{id}")
    async def read_archive(id: UID, request: Request):
        validate_query(request)
        saved = await run_store(store.read_archive, id)
        if saved is None:
            raise APIError("NOT_FOUND")
        return saved

    @application.get("/api/archive/dynamics/{id}/comments")
    async def read_comments(
        id: UID, request: Request,
        sort: Literal["hot", "latest"] = "hot",
        limit: Annotated[int, Query(ge=1, le=20)] = 20,
        cursor: Annotated[str | None, Query(max_length=64)] = None,
    ):
        validate_query(request, ("sort", "limit", "cursor"))
        return await run_store(store.list_roots, id, sort, limit, cursor)

    @application.get("/api/archive/dynamics/{id}/comments/{root_id}/replies")
    async def read_replies(
        id: UID, root_id: UID, request: Request,
        limit: Annotated[int | None, Query(ge=1, le=10)] = None,
        cursor: Annotated[str | None, Query(max_length=64)] = None,
    ):
        validate_query(request, ("limit", "cursor"))
        expected_limit = 3 if cursor is None else 10
        if limit is not None and limit != expected_limit:
            raise APIError("INVALID_INPUT" if cursor is None else "CURSOR_INVALID")
        return await run_store(store.list_replies, id, root_id, cursor)

    return application


app = create_app(os.environ.get("BILI_DATABASE_PATH", "backend/data/monitor.sqlite"))
