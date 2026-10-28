"""安全读取普通页面初始化 JSON；仅传输替换，不执行 JavaScript。"""

import json
import re
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from urllib.parse import urlsplit

from .contracts import APIError, validate_uid
from .risk import SourceRiskPaused
from .identifiers import is_valid_id
from .source_endpoints import DETAIL, OPUS_PAGE, note_business_success


class HtmlScriptCollector(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.inside = False
        self.parts = []
        self.scripts = []

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            self.inside = True
            self.parts = []

    def handle_data(self, data):
        if self.inside:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.inside:
            self.scripts.append("".join(self.parts))
            self.inside = False


def initial_detail(html, id):
    parser = HtmlScriptCollector()
    parser.feed(html)
    values = []
    for script in parser.scripts:
        match = re.search(r"(?:window\s*\.\s*)?__INITIAL_STATE__\s*=\s*", script)
        if match:
            value, end = json.JSONDecoder().raw_decode(script[match.end():])
            tail = script[match.end() + end:].lstrip()
            if tail and not tail.startswith(";"):
                raise ValueError("Not a JSON assignment")
            values.append(value)
    if len(values) != 1:
        raise ValueError("Missing or ambiguous initial state")
    detail = values[0]["detail"]
    if detail["id_str"] != id or not isinstance(detail["modules"], list):
        raise ValueError("Invalid detail")
    return detail


def module_data(detail, kind):
    matches = [item for item in detail["modules"] if isinstance(item, dict)
               and item.get("module_type") == "MODULE_TYPE_" + kind]
    if len(matches) != 1:
        raise ValueError("Missing or ambiguous module")
    return matches[0]["module_" + kind.lower()]


async def fetch_page(client, id):
    response = await client.get(f"https://www.bilibili.com/opus/{id}")
    response.raise_for_status()
    detail = initial_detail(response.text, id)
    # 只有按原解析通过（正文页确实是该动态的合法初始状态）才算成功业务请求。
    note_business_success(client, OPUS_PAGE)
    return detail


BEIJING = timezone(timedelta(hours=8))


def published_time(value):
    if type(value) not in (int, str) or not re.fullmatch(r"[0-9]+", str(value)):
        return None
    try:
        return datetime.fromtimestamp(int(value), BEIJING).isoformat(timespec="seconds")
    except (ValueError, OverflowError, OSError):
        return None


def edited_time(value):
    if not isinstance(value, str) or not value.strip():
        return None, "unknown"
    normalized = " ".join(value.split())
    if "编辑于" not in normalized:
        return None, "unknown"
    match = re.fullmatch(r"编辑于\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(\d{1,2}):(\d{2})", normalized)
    if match:
        try:
            time = datetime(*map(int, match.groups()), tzinfo=BEIJING)
            return time.isoformat(timespec="minutes"), "observed"
        except ValueError:
            pass
    return None, "error"


def page_metadata(detail, uid):
    author = module_data(detail, "AUTHOR")
    if type(author.get("mid")) not in (int, str) or str(author["mid"]) != uid:
        raise ValueError("Mismatched author")
    edited, status = edited_time(author.get("pub_time"))
    metadata = {"edit_status": status, "author": {
        "id": uid,
        "nickname": author.get("name") if isinstance(author.get("name"), str) else None,
        "avatar_url": safe_url(author.get("face")),
    }}
    # 受限页没有正文模块；可见性变化驱动受限登记的重领，转公开时恢复完整同步。
    try:
        module_data(detail, "CONTENT")
        metadata["content_visible"] = True
    except ValueError:
        metadata["content_visible"] = False
    try:
        title_module = module_data(detail, "TITLE")
        title = title_module.get("text") if isinstance(title_module, dict) else None
        if isinstance(title, str):
            metadata["title"] = title
    except ValueError:
        pass
    if edited is not None:
        metadata.update(edited_at=edited, observed_version=edited)
    published = published_time(author.get("pub_ts"))
    if published is not None:
        metadata["published_at"] = published
    try:
        count = module_data(detail, "STAT")["comment"]["count"]
        if type(count) is int and count >= 0:
            metadata["source_comment_count"] = count
    except (ValueError, KeyError, TypeError):
        pass
    return metadata


async def verify_author(client, id):
    try:
        author = module_data(await fetch_page(client, id), "AUTHOR")
        mid = author["mid"]
        if type(mid) not in (str, int):
            raise ValueError("Unknown author")
        return validate_uid(str(mid))
    except SourceRiskPaused:
        # 保护状态不是「作者未确认」：先报告再交给原错误处理，不借兜底再发一次请求。
        raise
    except Exception:
        try:
            item = await fetch_item(client, id)
            mid = item["modules"]["module_author"]["mid"]
            if type(mid) not in (str, int):
                raise ValueError("Unknown author")
            return validate_uid(str(mid))
        except SourceRiskPaused:
            raise
        except Exception:
            raise APIError("TARGET_UNVERIFIED") from None


def safe_url(value, *, allow_http=False):
    if not isinstance(value, str) or any(c.isspace() or ord(c) < 32 for c in value) or "\\" in value:
        return None
    try:
        url = urlsplit(value)
        _ = url.port
        if url.scheme in (("http", "https") if allow_http else ("https",)) and url.hostname and url.username is None and url.password is None:
            return value
    except ValueError:
        pass
    return None


def media_sources(pictures, url_field="url", dimension_prefix=""):
    if not isinstance(pictures, list):
        raise ValueError("Invalid pictures")
    media = []
    for picture in pictures:
        url = safe_url(picture[url_field], allow_http=True)
        if url is None:
            raise ValueError("Invalid media URL")
        media.append({"url": url, **{
            key: picture[dimension_prefix + key]
            if type(picture.get(dimension_prefix + key)) is int and picture[dimension_prefix + key] > 0 else None
            for key in ("width", "height")
        }})
    return media


def page_body(detail):
    paragraphs = module_data(detail, "CONTENT")["paragraphs"]
    if not isinstance(paragraphs, list):
        raise ValueError("Invalid paragraphs")
    texts, media = [], []
    for paragraph in paragraphs:
        kind = paragraph["para_type"]
        if type(kind) is not int:
            raise ValueError("Invalid paragraph type")
        if kind == 1:
            nodes = paragraph["text"]["nodes"]
            if not isinstance(nodes, list):
                raise ValueError("Invalid text nodes")
            words = []
            for node in nodes:
                if node["type"] == "TEXT_NODE_TYPE_WORD":
                    text = node["word"]["words"]
                elif node["type"] == "TEXT_NODE_TYPE_RICH":
                    text = node["rich"]["text"]
                else:
                    raise ValueError("Unsupported text node")
                if not isinstance(text, str):
                    raise ValueError("Invalid text")
                words.append(text)
            texts.append("".join(words))
        elif kind == 2:
            media.extend(media_sources(paragraph["pic"]["pics"]))
        else:
            # 未有证据的结构不静默丢失并伪装全文成功。
            raise ValueError("Unsupported paragraph")
    titles = [item for item in detail["modules"] if isinstance(item, dict) and item.get("module_type") == "MODULE_TYPE_TITLE"]
    title = None
    if len(titles) == 1:
        module_title = titles[0].get("module_title")
        if isinstance(module_title, dict) and isinstance(module_title.get("text"), str):
            title = module_title["text"]
    return {"title": title, "text": "\n".join(texts), "media_sources": media}


async def fetch_item(client, id):
    response = await client.get(
        "https://api.bilibili.com/x/polymer/web-dynamic/v1/detail",
        params={"id": id, "features": "itemOpusStyle,opusBigCover,onlyfansVote,endFooterHidden,decorationCard,onlyfansAssetsV2,ugcDelete,onlyfansQaCard,commentsNewVersion"},
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or type(payload.get("code")) is not int or payload["code"] != 0:
        raise ValueError("Invalid detail response")
    item = payload["data"]["item"]
    if item["id_str"] != id:
        raise ValueError("Mismatched detail")
    note_business_success(client, DETAIL)
    return item


COMMENT_LOCATOR_VERSION = 1


def comment_target(item):
    """参考 get_comment_target 的字段优先级；调用者须先核对动态 ID 和作者。"""
    basic = item.get("basic")
    basic = basic if isinstance(basic, dict) else {}
    oid, kind = basic.get("comment_id_str"), basic.get("comment_type", 11)
    oid = str(oid) if type(oid) is int else oid
    source = "basic"
    if not (is_valid_id(oid) and type(kind) is int and kind > 0):
        dynamic = item.get("modules", {}).get("module_dynamic", {})
        major = dynamic.get("major") if isinstance(dynamic, dict) else None
        major = major if isinstance(major, dict) else {}
        opus = major.get("opus")
        opus_id = opus.get("id") if isinstance(opus, dict) else None
        opus_id = str(opus_id) if type(opus_id) is int else opus_id
        if major.get("type") == "MAJOR_TYPE_OPUS" and is_valid_id(opus_id):
            oid, kind, source = opus_id, 11, "opus_fallback"
        else:
            oid, kind, source = item.get("id_str"), 11, "dynamic_id_fallback"
    if not is_valid_id(oid) or type(kind) is not int or kind < 1:
        raise ValueError("Invalid comment locator")
    return {"oid": oid, "type": kind, "source": source, "policy_version": COMMENT_LOCATOR_VERSION}


async def fetch_detail(client, id, uid):
    """读取独立身份、计数、评论定位和媒体 metadata，不把摘要当完整正文。"""
    item = await fetch_item(client, id)
    modules = item["modules"]
    if type(modules["module_author"]["mid"]) not in (str, int) or str(modules["module_author"]["mid"]) != uid:
        raise ValueError("Mismatched detail")
    metadata = {}
    author = modules["module_author"]
    published = published_time(author.get("pub_ts"))
    if published is not None:
        metadata["published_at"] = published
    nickname = author.get("name")
    avatar = safe_url(author.get("face"))
    metadata["author"] = {"id": uid, "nickname": nickname if isinstance(nickname, str) else None, "avatar_url": avatar}
    stat = modules.get("module_stat")
    comment = stat.get("comment") if isinstance(stat, dict) else None
    count = comment.get("count") if isinstance(comment, dict) else None
    if type(count) is int and count >= 0:
        metadata["source_comment_count"] = count
    metadata["comment_locator"] = comment_target(item)
    dynamic = modules.get("module_dynamic")
    major = dynamic.get("major") if isinstance(dynamic, dict) else None
    major = major if isinstance(major, dict) else {}
    if major.get("type") == "MAJOR_TYPE_BLOCKED":
        return metadata, "restricted"
    try:
        if major["type"] == "MAJOR_TYPE_OPUS":
            metadata["media_sources"] = media_sources(major["opus"]["pics"])
        elif major["type"] == "MAJOR_TYPE_DRAW":
            metadata["media_sources"] = media_sources(major["draw"]["items"], "src")
        else:
            return metadata, "failed"
    except (ValueError, KeyError, TypeError, AttributeError):
        return metadata, "failed"
    # JSON detail summary 是摘要而非全文。正文只能由页面 CONTENT 完整解析确认。
    return metadata, "failed"
