"""主动限速：先算预算再发送，而不是等飞书返回 429 再退避。

限速键是**目的地**：同一条 webhook（同一个群）共用一份额度，不同群互不占用。
系统角色（心跳与告警）用独立键，因此业务积压不会挤掉系统消息的额度。

额度取飞书自定义机器人官方值：单机器人 5 次/秒、100 次/分钟。超预算不等待、
不重试、不阻塞其他目的地：调用方把记录的 `due_at` 顺延一个轮询步长，留在
`pending` 由下一轮自然重领（顺延不算失败，见 `outbox.defer_delivery`）。

本模块只做内存里的滑动窗口计算，不打开数据库连接、不持有事务、不做网络 I/O；
窗口状态随进程存活。单实例 `flock` 保证同一库只有一个投递进程，因此重启会
丢失窗口历史——边界见 `docs/backend/api/notification-process.md` §5.2。
"""

import math
from collections import deque

# 官方额度：单租户单机器人 100 次/分钟、5 次/秒。
PER_SECOND = 5
PER_MINUTE = 100
SECOND_WINDOW = 1.0
MINUTE_WINDOW = 60.0
# 顺延步长与投递轮询间隔一致：超预算记录在下一轮被重新领取，不再额外等待。
DEFER_STEP_SECONDS = 1.0
# 单次顺延的上界：分钟窗口满时最多等一个完整窗口再加一个步长。
MAX_DEFER_SECONDS = MINUTE_WINDOW + DEFER_STEP_SECONDS
# 时间戳是浮点秒：窗口边界上的舍入噪声不能变成一次 1 秒的顺延。
_EPSILON = 1e-6


class RateLimiter:
    """按目的地键的滑动窗口限速器。

    `defer_seconds(key, now)` 返回 0 表示现在可以发送，正数表示应顺延的秒数
    （1 秒步长）；`record(key, now)` 在真正发送前记账。检查与记账都是同步的，
    因此在单线程事件循环里天然原子：并发投递不会把同一份额度超卖。
    """

    def __init__(self, *, per_second=PER_SECOND, per_minute=PER_MINUTE):
        if not 0 < per_second <= per_minute:
            raise ValueError("per_second must be positive and not exceed per_minute")
        self.per_second = per_second
        self.per_minute = per_minute
        self._sent = {}

    def defer_seconds(self, key, now):
        stamps = self._window(key, now)
        if not stamps:
            return 0.0
        wait = 0.0
        if len(stamps) >= self.per_second:
            wait = max(wait, stamps[-self.per_second] + SECOND_WINDOW - now)
        if len(stamps) >= self.per_minute:
            wait = max(wait, stamps[-self.per_minute] + MINUTE_WINDOW - now)
        if wait <= _EPSILON:
            return 0.0
        # 上界是契约的一部分：分钟窗口满时最多等一个完整窗口再加一个步长。
        return min(MAX_DEFER_SECONDS,
                   max(DEFER_STEP_SECONDS, math.ceil(wait / DEFER_STEP_SECONDS) * DEFER_STEP_SECONDS))

    def record(self, key, now):
        """记一次外发尝试：占用额度的是请求，不是成功响应。"""
        stamps = self._window(key, now)
        if stamps is None:
            stamps = self._sent[key] = deque(maxlen=self.per_minute)
        stamps.append(now)

    def _window(self, key, now):
        """丢弃分钟窗口之外的记账；只保留分钟上限条，避免无界增长。"""
        stamps = self._sent.get(key)
        if stamps is None:
            return None
        horizon = now - MINUTE_WINDOW
        while stamps and stamps[0] <= horizon:
            stamps.popleft()
        return stamps
