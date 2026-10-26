"""严格输入与固定、脱敏的错误契约。"""

from typing import Annotated, Literal

from fastapi.responses import JSONResponse
from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from .identifiers import is_valid_id


def validate_uid(value):
    if not is_valid_id(value):
        raise ValueError("Invalid UID")
    return value


UID = Annotated[str, Field(strict=True), AfterValidator(validate_uid)]


class AddUP(BaseModel):
    model_config = ConfigDict(extra="forbid")
    uid: UID


class AddTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UID


class MonitorConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["recent", "specified"]
    recent_n: Annotated[int, Field(strict=True, ge=1, le=9007199254740991)]
    enabled: Annotated[bool, Field(strict=True)]


class NotificationSwitch(BaseModel):
    """通知状态：三态枚举之一，禁止额外字段，非法入参统一 422。

    `all` 发送业务与系统消息；`system_only` 只发心跳/告警；`off` 一条都不发。
    """

    model_config = ConfigDict(extra="forbid")
    state: Literal["all", "system_only", "off"]


ERRORS = {
    "INVALID_INPUT": (422, "输入无效"),
    "CURSOR_INVALID": (422, "评论读取标记无效，请重新开始读取"),
    "NOT_FOUND": (404, "未找到身份或监控配置"),
    "UNKNOWN_UP": (404, "未找到 UP 身份"),
    "ALREADY_MONITORED": (409, "已存在监控配置"),
    "PROFILE_UNAVAILABLE": (502, "无法取得完整公开资料"),
    "TARGET_AUTHOR_MISMATCH": (409, "动态作者与所选 UP 不符"),
    "TARGET_UNVERIFIED": (502, "无法确认动态归属"),
    "STORAGE_UNAVAILABLE": (503, "存储暂不可用"),
    "INTERNAL_ERROR": (500, "服务暂不可用"),
}


class APIError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def error_response(code):
    default_status, message = ERRORS[code]
    return JSONResponse(
        status_code=default_status,
        content={
            "error": {"code": code, "message": message},
        },
    )
