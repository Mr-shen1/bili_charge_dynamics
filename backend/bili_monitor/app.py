"""管理 HTTP 应用；不含采集或周期调度。"""

import os
import sqlite3
from contextlib import asynccontextmanager

import httpx
from anyio import to_thread
from fastapi import FastAPI, Response
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException

from .contracts import UID, AddUP, APIError, MonitorConfig, error_response
from .profiles import fetch_profile
from .safety import configure_safe_logging
from .storage import Store


async def run_store(function, *args):
    return await to_thread.run_sync(function, *args)


def create_app(
    database_path: str | os.PathLike[str],
    profile_transport: httpx.AsyncBaseTransport | None = None,
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
            async with httpx.AsyncClient(
                transport=profile_transport, timeout=10, trust_env=False
            ) as profiles:
                application.state.profiles = profiles
                yield
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
    async def list_ups():
        return {"ups": await run_store(store.read)}

    @application.get("/api/manage/ups/{uid}")
    async def get_up(uid: UID):
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

    return application


app = create_app(os.environ.get("BILI_DATABASE_PATH", "backend/data/monitor.sqlite"))
