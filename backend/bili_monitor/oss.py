"""阿里云 OSS V4 上传适配器；凭据只从服务端环境读取，不创建资源或开放 ACL。"""

import os
import re
from urllib.parse import quote, urlsplit

import oss2
from anyio import to_thread

from .media import is_archive_delivery_url
from .source import safe_url


class OSSUploader:
    def __init__(self, *, endpoint, region, bucket, access_key_id, access_key_secret,
                 public_base_url, security_token=None):
        endpoint_url = urlsplit(endpoint)
        if (safe_url(endpoint) is None or endpoint_url.query or endpoint_url.fragment
                or endpoint_url.path not in ("", "/") or endpoint_url.port is not None
                or not (endpoint_url.hostname or "").endswith(".aliyuncs.com")
                or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", bucket)
                or not re.fullmatch(r"[a-z0-9-]+", region)
                or not is_archive_delivery_url(public_base_url)
                or not access_key_id or not access_key_secret):
            raise ValueError("Invalid OSS configuration")
        auth = (oss2.StsAuth(access_key_id, access_key_secret, security_token, auth_version=oss2.AUTH_VERSION_4)
                if security_token else oss2.AuthV4(access_key_id, access_key_secret))
        self._session = oss2.Session()
        self._session.session.trust_env = False
        self._bucket = oss2.Bucket(auth, endpoint, bucket, region=region, connect_timeout=30, session=self._session)
        self._public_base_url = public_base_url.rstrip("/")

    @classmethod
    def from_environment(cls):
        names = {
            "endpoint": "BILI_OSS_ENDPOINT", "region": "BILI_OSS_REGION", "bucket": "BILI_OSS_BUCKET",
            "access_key_id": "BILI_OSS_ACCESS_KEY_ID", "access_key_secret": "BILI_OSS_ACCESS_KEY_SECRET",
            "public_base_url": "BILI_OSS_PUBLIC_BASE_URL", "security_token": "BILI_OSS_SECURITY_TOKEN",
        }
        values = {key: os.environ.get(name) for key, name in names.items()}
        if not any(value is not None for value in values.values()):
            return None
        if any(not value for key, value in values.items() if key != "security_token"):
            raise ValueError("Incomplete OSS configuration")
        return cls(**values)

    def close(self):
        self._session.session.close()

    async def upload(self, key, content, content_type):
        # SDK 是同步外部 I/O，绝不占用事件循环或数据库事务。
        await to_thread.run_sync(lambda: self._bucket.put_object(key, content, headers={"Content-Type": content_type}))
        return self._public_base_url + "/" + quote(key, safe="/")
