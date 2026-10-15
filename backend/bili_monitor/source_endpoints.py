"""分页读取与发送节奏共用的上游端点，避免地址更新后静默失去等待。"""

FEED_URL = "https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space"
ROOT_COMMENTS_URL = "https://api.bilibili.com/x/v2/reply"
REPLIES_URL = "https://api.bilibili.com/x/v2/reply/reply"
