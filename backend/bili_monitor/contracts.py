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


class ProbeRequest(BaseModel):
    """人工探测登记：绑定当前人工态代次，不接受任何可写状态字段。

    空对象与空请求体都是合法登记；任何 `state`／`backoff_step`／`next_probe_at` 之类字段
    都被拒绝，避免用请求体清零档位或修改截止时间。
    """

    model_config = ConfigDict(extra="forbid")


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
    "SOURCE_RISK_PAUSED": (503, "B 站来源保护中，需要访问来源的操作暂不可用"),
    "RISK_PROBE_NOT_ALLOWED": (409, "当前保护状态不允许登记人工探测"),
    "INTERNAL_ERROR": (500, "服务暂不可用"),
}


class APIError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def error_response(code, details=None, headers=None):
    """固定提示＋可选脱敏状态事实；调用方只能附加已审核的字段，不回显上游原文。"""
    default_status, message = ERRORS[code]
    return JSONResponse(
        status_code=default_status,
        content={
            "error": {"code": code, "message": message, **(details or {})},
        },
        headers=headers,
    )
