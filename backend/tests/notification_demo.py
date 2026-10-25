"""01 隔离演示：真实采集/归档/通知模块 + 临时 SQLite + 受控飞书接收端。

    demo_dir=$(mktemp -d)
    uv run python -m backend.tests.notification_demo --database "$demo_dir/monitor.sqlite"

同一路径再次运行会看到普通重启不重复投递。演示只替换 B 站/飞书 HTTP 传输，
不接真实上游、不读取真实凭据、不访问网络；输出为公开归档读取与受控接收端结果。
"""

import argparse
import asyncio
import json

import httpx

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.notifications import Dispatcher, NotificationConfig
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client
from backend.tests.collector_support import configured
from backend.tests.management_support import UID
from backend.tests.notification_support import (
    BASE_URL, DYNAMIC, Source, config_mapping, deliveries, message_text,
)

WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/fictional-demo"


class DemoReceiver:
    """受控接收端：记录请求并返回官方业务成功响应，不访问网络。"""

    def __init__(self):
        self.received = []

    def __call__(self, request):
        self.received.append({"url": str(request.url), "payload": json.loads(request.content)})
        return httpx.Response(200, json={"code": 0, "msg": "success"})


def notify_config():
    mapping = config_mapping(up=WEBHOOK)
    mapping["base_url"] = BASE_URL
    return NotificationConfig.from_mapping(mapping)


async def demonstrate(path):
    store = Store(path)
    store.migrate()
    if not store.read(UID):
        configured(path)

    async def archive(version, *, body_error=False):
        source = Source(version)
        source.body_error = body_error
        # 演示按 0 秒采样间隔驱动页面信号；生产默认仍是 58～62 秒。
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(store, client, page_check_seconds=0)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()

    async def dispatch(receiver):
        return await Dispatcher(store, notify_config(), transport=httpx.MockTransport(receiver)).run_once()

    receiver = DemoReceiver()
    if deliveries(path):
        # 同一路径再次运行：已成功投递的记录不会因重启重复发送。
        dispatched = await dispatch(receiver)
        with archive_client(path) as api:
            saved = api.get(f"/api/archive/dynamics/{DYNAMIC}").json()
        print(json.dumps({"step": "restart", "dispatched": dispatched, "delivered": len(receiver.received),
                          "archive_text": saved["text"],
                          "states": [row["state"] for row in deliveries(path)]}, ensure_ascii=False), flush=True)
        return

    await archive("v1")
    await dispatch(receiver)
    with archive_client(path) as api:
        saved = api.get(f"/api/archive/dynamics/{DYNAMIC}").json()
    print(json.dumps({"step": "baseline", "archive_text": saved["text"],
                      "delivered": len(receiver.received)}, ensure_ascii=False), flush=True)

    await archive("v2")
    await dispatch(receiver)
    with archive_client(path) as api:
        saved = api.get(f"/api/archive/dynamics/{DYNAMIC}").json()
    message = message_text(receiver.received[-1]["payload"])
    print(json.dumps({"step": "change", "archive_text": saved["text"],
                      "webhook": receiver.received[-1]["url"], "message": message}, ensure_ascii=False), flush=True)

    before = len(receiver.received)
    dispatched = await dispatch(receiver)
    with archive_client(path) as api:
        api.get(f"/api/archive/dynamics/{DYNAMIC}")
    print(json.dumps({"step": "restart", "dispatched": dispatched, "delivered": len(receiver.received) - before,
                      "states": [row["state"] for row in deliveries(path)]}, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description="Isolated dynamic-change notification demonstration")
    parser.add_argument("--database", required=True)
    arguments = parser.parse_args()
    asyncio.run(demonstrate(arguments.database))


if __name__ == "__main__":
    main()
