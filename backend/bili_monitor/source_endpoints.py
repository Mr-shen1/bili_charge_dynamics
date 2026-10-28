"""分页读取、发送节奏、风控探测与业务成功上报共用的上游端点与接口类型。

接口类型是「主机 + 路径模板」的固定分类：query 里的资源 ID 和页码不产生新类型。
Gate 的分类、页后等待、探测集合、业务成功上报与日志都引用这里的同一份常量，改一类
接口只需要改一处。本模块不导入其他业务模块，供传输接入点、业务解析与探测层共用。
"""

FEED_URL = "https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space"
ROOT_COMMENTS_URL = "https://api.bilibili.com/x/v2/reply"
REPLIES_URL = "https://api.bilibili.com/x/v2/reply/reply"

# 正式设计 §4.4 的接口类型：同一类型的不同资源、页码不扩增类型。
COMMENT_COUNT = "comment_count"
ROOT_COMMENTS = "root_comments"
REPLIES = "replies"
FEED = "feed"
DETAIL = "detail"
PROFILE = "profile"
OPUS_PAGE = "opus_page"
HOMEPAGE_WARMUP = "homepage_warmup"
SPACE_WARMUP = "space_warmup"
# 图片按受信域族区分：两族代表不同 CDN 拦截面，探测与日志不能互相代替。
IMAGE_HDSLB = "image_hdslb"
IMAGE_BILIIMG = "image_biliimg"
IMAGE_TYPES = (IMAGE_HDSLB, IMAGE_BILIIMG)
IMAGE_DOMAINS = (("hdslb.com", IMAGE_HDSLB), ("biliimg.com", IMAGE_BILIIMG))
# 白名单内、但尚无专门模板的来源路径仍须经过许可，不因分类缺失而放行。
OTHER_SOURCE = "source_other"
# 会话预热只是业务请求的前置，不算一次成功业务请求，也不能让观察期凭预热清零。
WARMUP_TYPES = (HOMEPAGE_WARMUP, SPACE_WARMUP)


def note_business_success(reporter, endpoint_type):
    """把「一次真实请求已通过业务解析／资源校验」报告给同一 Gate。

    观察期只认这类事实：HTTP 2xx／3xx 本身不代表正文、评论或图片真的解析成功
    （`200 + code=-352` 的评论拒绝、错误页或跳转都不是）。`reporter` 可以是接入 Gate
    的来源客户端，也可以是 Gate 本身；没有这项能力（隔离解析单测、纯账本替身）时静默
    忽略：宁可少记一次成功，也不凭传输状态冒充业务成功。
    """
    report = getattr(reporter, "note_business_success", None)
    if report is not None:
        report(endpoint_type)


def image_endpoint_type(host):
    """受信图片域族 → 接口类型；非受信域返回 None（不受源站许可控制）。"""
    return next((kind for domain, kind in IMAGE_DOMAINS
                 if host == domain or host.endswith("." + domain)), None)
