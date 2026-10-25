"""小时心跳：北京时间每小时第 40 分钟向系统群报告本地可观察状态。

不变量：
- 时段身份是北京时间的 `YYYY-MM-DDTHH`，持久记录在 `notification_heartbeats`；
  同一小时的重复调度、进程重启都不重复生成，不是进程内标记。
- 时段只在第 40 分钟这一分钟内成立（`:40:00`–`:40:59`，给 1 秒轮询留整分钟窗口，
  不要求精确到秒）；之前不提前生成，之后（`:41` 起）首次启动也不为本小时补一笔。
- 停机错过的时段不补发：没有「当前时段之外的生成」入口。已生成待发的心跳不受窗口影响，
  仍可在有效期前按退避重试。
- 有效期到下一个时段开始（下一个 :40），不跨时段；业务事件没有有效期。
- 只读本地已记录的事实（纳管目标、检查状态、待同步工作），不访问上游，
  也不把通知进程存活当成采集成功。
"""

from dataclasses import dataclass
from datetime import datetime, timedelta

from ..source import BEIJING

SLOT_MINUTE = 40
SLOT_WINDOW = timedelta(minutes=1)


@dataclass(frozen=True)
class Slot:
    identity: str
    label: str
    starts_at: float
    expires_at: float


def slot(now):
    """当前北京时间所在的心跳时段；只有第 40 分钟窗口内返回，其余时间返回 None。

    窗口是整分钟（`:40:00`–`:40:59`），不以“>= 40 分”为条件：否则 ``:41``–``:59``
    之间首次启动会为一个从未运行过的时段补发心跳，违反“停机错过不追赶”。
    """
    moment = datetime.fromtimestamp(now, BEIJING)
    start = moment.replace(minute=SLOT_MINUTE, second=0, microsecond=0)
    if not start <= moment < start + SLOT_WINDOW:
        return None
    return Slot(start.strftime("%Y-%m-%dT%H"), start.strftime("%Y-%m-%d %H:%M"),
                start.timestamp(), (start + timedelta(hours=1)).timestamp())


def _beijing(value):
    """采集写入的是 UTC ISO 字符串；心跳按北京时间展示，解析不了就如实留空。"""
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(
            BEIJING).isoformat(sep=" ", timespec="seconds").split("+")[0]
    except ValueError:
        return None


def observe(connection):
    """本地已记录的可观察事实：纳管目标、已检查目标、最近一次失败与待同步工作。"""
    # 延迟导入：入选模块反向依赖发件箱，放在函数内避免包初始化顺序耦合。
    from ..selection import SELECTED_TARGETS

    selected = connection.execute(f"SELECT COUNT(*) FROM ({SELECTED_TARGETS})").fetchone()[0]
    row = connection.execute("""SELECT COUNT(*) AS checked,
            COALESCE(SUM(CASE WHEN check_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
            COALESCE(SUM(CASE WHEN work <> 'complete' THEN 1 ELSE 0 END), 0) AS pending,
            MAX(last_checked_at) AS last_checked_at FROM target_checks""").fetchone()
    return {
        "selected": selected,
        "checked": row["checked"],
        "failed": row["failed"],
        "pending": row["pending"],
        "last_checked_at": _beijing(row["last_checked_at"]),
    }
