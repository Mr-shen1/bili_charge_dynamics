"""仓库外登录 Cookie 配置；只用于限定的 HTTPS 来源 GET，不输出凭据。"""

import getpass
import os
import re
import stat
import sys
import tempfile
import warnings
from pathlib import Path

import httpx


MAX_COOKIE_BYTES = 16 * 1024
_SOURCE_HOSTS = frozenset({"api.bilibili.com", "www.bilibili.com"})
_REPOSITORY = Path(__file__).resolve().parents[2]
_CONFIG_ERROR = "Invalid source Cookie file configuration"
_COOKIE_NAME = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")


def _outside_repository(value):
    path = Path(value)
    if not path.is_absolute() or path.resolve().is_relative_to(_REPOSITORY):
        raise ValueError(_CONFIG_ERROR)
    return path


def _require_private_directory(directory):
    info = directory.lstat()
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        raise ValueError(_CONFIG_ERROR)


def _cookie_value(raw):
    # 允许文本编辑器补一个行尾，其他 CR/LF、控制字符一律拒绝。
    if raw.endswith(b"\r\n"):
        raw = raw[:-2]
    elif raw.endswith(b"\n"):
        raw = raw[:-1]
    if not raw or len(raw) > MAX_COOKIE_BYTES:
        raise ValueError(_CONFIG_ERROR)
    value = raw.decode("ascii")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError(_CONFIG_ERROR)
    value = value.strip(" ")
    pairs = [part.strip() for part in value.split(";") if part.strip()]
    if not pairs:
        raise ValueError(_CONFIG_ERROR)
    for pair in pairs:
        name, separator, _ = pair.partition("=")
        if not separator or _COOKIE_NAME.fullmatch(name.strip()) is None:
            raise ValueError(_CONFIG_ERROR)
    return value


def _read_cookie_file(value):
    path = _outside_repository(value)
    _require_private_directory(path.parent)
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_nlink != 1
        ):
            raise ValueError(_CONFIG_ERROR)
        return _cookie_value(stream.read(MAX_COOKIE_BYTES + 3))


def _allowed_source_request(request):
    return (
        request.method == "GET"
        and request.url.scheme == "https"
        and request.url.host in _SOURCE_HOSTS
        and request.url.port in (None, 443)
        and not request.url.username
        and not request.url.password
    )


def load_source_cookie_pairs():
    """启动时读取私有文件，按参考脚本分别 strip 名称和值；绝不回显内容。"""
    configured = os.environ.get("BILI_COOKIE_FILE")
    if configured is None:
        return ()
    try:
        cookie = _read_cookie_file(configured)
        pairs = []
        for pair in cookie.split(";"):
            if pair.strip():
                name, _, value = pair.partition("=")
                pairs.append((name.strip(), value.strip()))
        return tuple(pairs)
    except (OSError, ValueError, RuntimeError):
        raise RuntimeError(_CONFIG_ERROR) from None


def source_cookie_event_hooks(*, cookie_pairs=None):
    """HTTPX 来源信号的独立受控 jar，不与 Requests 或媒体共享可变会话。"""
    jar = httpx.Cookies()
    pairs = load_source_cookie_pairs() if cookie_pairs is None else cookie_pairs
    for name, value in pairs:
        jar.set(name, value, domain=".bilibili.com", path="/")

    async def apply_cookie(request):
        # 清除 client 自带 jar、手工头或重定向可能生成的 Cookie，只允许受控会话。
        request.headers.pop("cookie", None)
        if _allowed_source_request(request):
            jar.set_cookie_header(request)

    async def remember_cookie(response):
        if _allowed_source_request(response.request):
            # 与参考脚本的 Session 相同，保留更新/过期删除，不每次恢复文件中的旧值。
            jar.extract_cookies(response)

    return {"request": [apply_cookie], "response": [remember_cookie]}


def _write_cookie_file(value):
    path = _outside_repository(value)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    _require_private_directory(path.parent)
    if os.path.lexists(path) or not sys.stdin.isatty():
        raise ValueError(_CONFIG_ERROR)
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        cookie = getpass.getpass("仅在本机输入 Cookie 请求头的值（隐藏输入，不含 Cookie: 前缀）：")
    content = _cookie_value(cookie.encode("ascii")).encode("ascii")
    descriptor, temporary = tempfile.mkstemp(prefix=".source-cookie-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        # 原子发布且拒绝覆盖已有文件；最终文件不保留额外硬链接。
        os.link(temporary, path, follow_symlinks=False)
    finally:
        os.unlink(temporary)


def main():
    # 固定用法错误，不让 argparse 将误粘到命令参数的秘密回显。
    if len(sys.argv) != 3 or sys.argv[1] != "--write":
        raise SystemExit("Usage: python -m backend.bili_monitor.source_cookies --write ABSOLUTE_PATH")
    os.umask(0o077)
    try:
        _write_cookie_file(sys.argv[2])
    except (OSError, ValueError, RuntimeError, EOFError, getpass.GetPassWarning, KeyboardInterrupt):
        raise SystemExit("Cookie file was not written; check path, permissions and input locally") from None
    print("Cookie file saved. No service was started or restarted; no network request was made.")


if __name__ == "__main__":
    main()
