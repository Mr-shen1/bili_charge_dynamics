"""01：飞书载荷、业务响应判定与通知配置的协议核验。

依据官方自定义机器人文档：富文本 `post` 的 `zh_cn.content` 段落支持
`{"tag": "a", "text": ..., "href": ...}`；业务成功以响应体 `code=0`（或旧版
`StatusCode=0`）为准，不能只看 HTTP 200；请求体上限 20 KB；超限会返回
HTTP 429 或 11232 等限流业务码。
"""

import json

import pytest

from backend.bili_monitor.notifications import Dispatcher, NotificationConfig, NotificationConfigError
from backend.bili_monitor.notifications import delivery, message
from backend.tests.notification_support import BASE_URL, DYNAMIC, WEBHOOK, config_mapping, message_text


def test_dynamic_change_payload_uses_clickable_link_and_title_or_id():
    payload = message.dynamic_changed({"dynamic_id": DYNAMIC, "title": "虚构标题"}, BASE_URL)
    paragraphs = payload["content"]["post"]["zh_cn"]["content"]
    assert paragraphs[0] == [{"tag": "text", "text": "动态【虚构标题】发生变化"}]
    assert paragraphs[1][1] == {
        "tag": "a", "text": "查看动态", "href": f"{BASE_URL}/dynamics/{DYNAMIC}"}
    assert payload["msg_type"] == "post"
    # 不生成 @ 提及或图片节点：来源文本不会变成意外操作。
    assert "at" not in json.dumps(payload)
    assert "img" not in json.dumps(payload)


@pytest.mark.parametrize("title", [None, "", "   ", "\n\t "])
def test_missing_or_blank_title_falls_back_to_dynamic_id(title):
    payload = message.dynamic_changed({"dynamic_id": DYNAMIC, "title": title}, BASE_URL)
    assert message_text(payload).splitlines()[0] == f"动态【{DYNAMIC}】发生变化"


def test_untrusted_title_is_shown_as_text_without_control_characters():
    payload = message.dynamic_changed(
        {"dynamic_id": DYNAMIC, "title": "<b>伪造</b>\x00 <at id=all>\r\n第二行"}, BASE_URL)
    line = message_text(payload).splitlines()[0]
    assert line == "动态【<b>伪造</b> <at id=all> 第二行】发生变化"
    assert "\x00" not in json.dumps(payload)


def test_over_long_title_is_clipped_but_link_and_limit_are_kept():
    payload = message.dynamic_changed({"dynamic_id": DYNAMIC, "title": "长" * 20_000}, BASE_URL)
    assert len(message.encoded(payload)) <= message.PAYLOAD_LIMIT_BYTES
    paragraphs = payload["content"]["post"]["zh_cn"]["content"]
    assert paragraphs[1][1]["href"] == f"{BASE_URL}/dynamics/{DYNAMIC}"
    assert paragraphs[0][0]["text"].endswith(f"{message.ELLIPSIS}】发生变化")


@pytest.mark.parametrize("status, body, expected", [
    (200, {"code": 0, "msg": "success", "StatusCode": 0}, (True, None)),
    (200, {"code": 0, "msg": "success"}, (True, None)),
    (200, {"StatusCode": 0, "StatusMessage": "success"}, (True, None)),
    (200, {"code": 9499, "msg": "Bad Request"}, (False, "platform_rejected")),
    (200, {"code": 11232, "msg": "rate limited"}, (False, "rate_limited")),
    (200, {"code": 19024, "msg": "Key Words Not Found"}, (False, "platform_rejected")),
    (500, {}, (False, "http_error")),
    (200, "not-json", (False, "invalid_response")),
    (200, {"msg": "success"}, (False, "platform_rejected")),
])
def test_business_success_requires_platform_code(status, body, expected):
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    result = message.outcome(status, {}, raw)
    assert (result.sent, result.error) == expected


def test_rate_limit_uses_platform_reset_header():
    result = message.outcome(429, {"x-ogw-ratelimit-reset": "45"}, b'{"code": 99991400}')
    assert (result.sent, result.error, result.retry_after) == (False, "rate_limited", 45.0)
    fallback = message.outcome(429, {}, b"")
    assert fallback.retry_after == message.RATE_LIMIT_FALLBACK_SECONDS


def test_config_prefers_dynamic_override_and_never_reprs_credentials():
    mapping = config_mapping(overrides={DYNAMIC: "https://open.feishu.cn/open-apis/bot/v2/hook/fake-dynamic"})
    config = NotificationConfig.from_mapping(mapping)
    assert config.webhook("900719925474099312345", DYNAMIC, "up").endswith("fake-dynamic")
    assert config.webhook("900719925474099312345", "999", "up") == WEBHOOK
    assert config.webhook("900719925474099312345", DYNAMIC, "all") is None
    assert "fake-up-token" not in repr(config) and "fake-dynamic" not in repr(config)


def test_config_rejects_credential_bearing_or_malformed_values_without_echo():
    for mapping in (
        {"base_url": "https://user:secret@archive.example", "destinations": {}},
        {"base_url": "archive.example", "destinations": {}},
        {"base_url": BASE_URL, "destinations": {"up-room": {"webhook": "file:///secret"}}},
        {"base_url": BASE_URL, "destinations": {"up-room": {}}},
    ):
        with pytest.raises(NotificationConfigError) as failure:
            NotificationConfig.from_mapping(mapping)
        assert "secret" not in str(failure.value)


def test_documented_runtime_defaults_are_finite_and_one_second_polling():
    # 默认每秒一轮、有限批量、有限租约；网络超时不占用数据库事务。
    assert delivery.POLL_SECONDS == 1.0
    assert 0 < delivery.BATCH <= 32
    assert 0 < delivery.LEASE_SECONDS <= 300
    assert delivery.RETRY_BASE_SECONDS > 0 and delivery.RETRY_CAP_SECONDS >= delivery.RETRY_BASE_SECONDS
    dispatcher = Dispatcher(object(), NotificationConfig.from_mapping(config_mapping()))
    assert (dispatcher.batch, dispatcher.poll_seconds) == (delivery.BATCH, delivery.POLL_SECONDS)


def test_config_loads_from_file_and_reports_missing_file(tmp_path):
    path = tmp_path / "notifications.json"
    path.write_text(json.dumps(config_mapping()))
    assert NotificationConfig.load(path).webhook("900719925474099312345", DYNAMIC, "up") == WEBHOOK
    with pytest.raises(NotificationConfigError):
        NotificationConfig.load(tmp_path / "missing.json")
