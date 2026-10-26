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
from backend.tests.management_support import UID
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
        {"base_url": BASE_URL, "destinations": []},
        {"base_url": BASE_URL, "ups": {"900719925474099312345": "up-room"}, "destinations": {}},
    ):
        with pytest.raises(NotificationConfigError) as failure:
            NotificationConfig.from_mapping(mapping)
        assert "secret" not in str(failure.value)


def test_single_malformed_destination_only_pauses_that_target():
    """整份配置可用，只有写错的目的地等修复：其他群不受牵连。"""
    for entry in ({"webhook": "file:///secret"}, {}, "up-room", {"webhook": WEBHOOK, "secret": 5}):
        loaded = NotificationConfig.from_mapping(
            {"base_url": BASE_URL, "ups": {UID: {"up": "up-room"}}, "destinations": {"up-room": entry}})
        assert (loaded.webhook(UID, DYNAMIC, "up"), loaded.route_error(UID, DYNAMIC, "up")) == (
            None, "route_invalid")
    loaded = NotificationConfig.from_mapping({"base_url": BASE_URL, "ups": {UID: {"up": "nope"}}})
    assert loaded.route_error(UID, DYNAMIC, "up") == "route_invalid"
    loaded = NotificationConfig.from_mapping({"base_url": BASE_URL, "ups": {UID: {}}})
    assert (loaded.webhook(UID, DYNAMIC, "up"), loaded.route_error(UID, DYNAMIC, "up")) == (
        None, "route_missing")


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


COMMENT = {"dynamic_id": DYNAMIC, "title": "虚构标题", "comment_id": "860001",
           "author": {"id": "900719925474099312345", "nickname": "虚构星海"},
           "published_at": "2027-01-01T00:00:00+08:00", "text": "第一行\n回复 @虚构读者：第二行",
           "has_media": False}


def test_root_comment_payload_is_one_message_with_clickable_locate_link():
    payload = message.root_comment(COMMENT, BASE_URL)
    assert payload["msg_type"] == "post"
    paragraphs = payload["content"]["post"]["zh_cn"]["content"]
    assert paragraphs[0] == [{"tag": "text", "text": "动态：虚构标题"}]
    assert paragraphs[1] == [{"tag": "text", "text": "评论人：【虚构星海】"}]
    assert paragraphs[2] == [{"tag": "text", "text": "时间：2027-01-01 00:00:00"}]
    # 原文换行与“回复 @某人”上下文按来源保留，不拆多条消息。
    assert message_text(payload) == (
        "动态：虚构标题\n评论人：【虚构星海】\n时间：2027-01-01 00:00:00\n"
        "内容：第一行\n回复 @虚构读者：第二行\n链接：查看该条评论")
    assert paragraphs[-1][1] == {
        "tag": "a", "text": "查看该条评论",
        "href": f"{BASE_URL}/dynamics/{DYNAMIC}/comments/860001/locate"}


def test_root_comment_time_is_beijing_seconds_regardless_of_source_offset():
    payload = message.root_comment({**COMMENT, "published_at": "2026-12-31T17:00:05+00:00"}, BASE_URL)
    assert "时间：2027-01-01 01:00:05" in message_text(payload)


@pytest.mark.parametrize("title", [None, "", "   "])
def test_root_comment_blank_title_falls_back_to_dynamic_id(title):
    payload = message.root_comment({**COMMENT, "title": title}, BASE_URL)
    assert message_text(payload).splitlines()[0] == f"动态：{DYNAMIC}"


@pytest.mark.parametrize("nickname", [None, "", "  "])
def test_root_comment_missing_nickname_falls_back_to_author_uid(nickname):
    payload = message.root_comment({**COMMENT, "author": {"id": "303", "nickname": nickname}}, BASE_URL)
    assert "评论人：【303】" in message_text(payload)


def test_root_comment_image_only_uses_placeholder_and_never_uploads_images():
    payload = message.root_comment({**COMMENT, "text": None, "has_media": True}, BASE_URL)
    assert "内容：【图片评论，点击链接查看】" in message_text(payload)
    assert "img" not in json.dumps(payload)
    # 无文字的纯文本评论不凭空造占位，也不伪装成有图。
    empty = message.root_comment({**COMMENT, "text": "", "has_media": False}, BASE_URL)
    assert "图片评论" not in message_text(empty)


def test_root_comment_untrusted_text_is_shown_as_text_without_mentions():
    payload = message.root_comment(
        {**COMMENT, "text": "<at id=all>提醒</at> <img src=x>\x00\r\n第二行"}, BASE_URL)
    text = message_text(payload)
    assert "<at id=all>提醒</at> <img src=x>" in text
    assert "\x00" not in text
    assert "\r" not in text
    # 载荷里只有 text/a 节点：来源文本不会被当成提及或图片。
    tags = {node["tag"] for paragraph in payload["content"]["post"]["zh_cn"]["content"]
            for node in paragraph}
    assert tags == {"text", "a"}


def test_over_long_comment_clips_only_the_body_and_keeps_the_link():
    snapshot = {**COMMENT, "title": "标" * 20_000, "author": {"id": "303", "nickname": "昵" * 5_000},
                "text": "长" * 40_000}
    payload = message.root_comment(snapshot, BASE_URL)
    assert len(message.encoded(payload)) <= message.PAYLOAD_LIMIT_BYTES
    paragraphs = payload["content"]["post"]["zh_cn"]["content"]
    assert paragraphs[-1][1]["href"] == f"{BASE_URL}/dynamics/{DYNAMIC}/comments/860001/locate"
    text = message_text(payload)
    assert message.LONG_CONTENT in text
    # 一条消息内截断，不拆多条刷屏；其余字段与链接保持存在。
    assert text.startswith("动态：") and "评论人：【" in text and "时间：2027-01-01 00:00:00" in text


def test_signature_follows_the_official_hmac_construction():
    """官方签名校验：`base64(HMAC-SHA256(key="{timestamp}\\n{secret}", msg=""))`，秒级时间戳。"""
    import base64
    import hashlib
    import hmac

    expected = base64.b64encode(hmac.new(b"1599360473\nfake-signing-secret", b"",
                                         digestmod=hashlib.sha256).digest()).decode()
    assert message.signature("fake-signing-secret", 1599360473) == expected

    signed = message.signed({"msg_type": "text", "content": {"text": "虚构"}}, "fake-signing-secret", 1599360473)
    assert signed["timestamp"] == "1599360473"
    assert signed["sign"] == expected
    # 只在请求体外层追加两个字段，消息结构不变。
    assert signed["msg_type"] == "text" and signed["content"] == {"text": "虚构"}


def test_config_without_secret_never_adds_signature_fields():
    loaded = NotificationConfig.from_mapping(config_mapping(up=WEBHOOK))
    assert loaded.secret("900719925474099312345", DYNAMIC, "up") is None
    assert "fake-signing-secret" not in repr(loaded)


def test_business_rate_limit_code_and_signature_failure_are_classified():
    """HTTP 200 也可能被限流（业务码 11232）；签名校验失败（19021）不是成功。"""
    limited = message.outcome(200, None, json.dumps({"code": 11232, "msg": "rate limited"}).encode())
    assert (limited.sent, limited.error, limited.retry_after) == (False, "rate_limited", 60.0)
    rejected = message.outcome(200, None, json.dumps(
        {"code": 19021, "msg": "sign match fail or timestamp is not within one hour from current time"}).encode())
    assert (rejected.sent, rejected.error) == (False, "platform_rejected")
    assert message.outcome(200, None, b"{}").sent is False
    assert message.outcome(200, None, json.dumps({"StatusCode": 0}).encode()).sent is True
