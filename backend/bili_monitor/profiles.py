"""公开 card 协议解析；仅传输可替换，不制造默认成功资料。"""

from urllib.parse import urlsplit

import httpx

from .contracts import APIError


async def fetch_profile(client, uid):
    try:
        response = await client.get(
            "https://api.bilibili.com/x/web-interface/card",
            params={"mid": uid},
        )
        response.raise_for_status()
        payload = response.json()
        if (
            not isinstance(payload, dict)
            or type(payload.get("code")) is not int
            or payload["code"] != 0
        ):
            raise ValueError("Invalid profile response")
        profile = payload["data"]["card"]
        mid = profile["mid"]
        if type(mid) not in (int, str) or str(mid) != uid:
            raise ValueError("Mismatched profile")
        name, face = profile["name"], profile["face"]
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Missing name")
        if (
            not isinstance(face, str)
            or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in face)
            or "\\" in face
        ):
            raise ValueError("Invalid avatar URL")
        url = urlsplit(face)
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username is not None
            or url.password is not None
        ):
            raise ValueError("Invalid avatar URL")
        # 访问 port 触发非法端口校验，但不跟随该 URL 发起任何请求。
        _ = url.port
        return name, face
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        raise APIError("PROFILE_UNAVAILABLE") from None
