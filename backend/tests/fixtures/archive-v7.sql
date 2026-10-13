-- 已发布 v7 的固定结构；迁移输入，不从当前 Store 生成。
CREATE TABLE identities(uid TEXT PRIMARY KEY, name TEXT, avatar_url TEXT);
CREATE TABLE monitors(uid TEXT PRIMARY KEY REFERENCES identities(uid), mode TEXT NOT NULL DEFAULT 'recent', recent_n INTEGER NOT NULL DEFAULT 10, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE targets(uid TEXT NOT NULL REFERENCES monitors(uid) ON DELETE CASCADE, id TEXT NOT NULL, PRIMARY KEY(uid,id));
CREATE TABLE archives(id TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES identities(uid), document TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0);
CREATE TABLE archive_pages(token TEXT PRIMARY KEY, batch_limit INTEGER NOT NULL, document TEXT NOT NULL, expires_at INTEGER NOT NULL DEFAULT 0, resource TEXT NOT NULL DEFAULT 'dynamics:all:published-desc:id-binary:v1');
CREATE INDEX archive_pages_expiry ON archive_pages(expires_at);
CREATE TABLE root_comments(dynamic_id TEXT NOT NULL REFERENCES archives(id), id TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(dynamic_id,id));
CREATE TABLE root_comment_pages(token TEXT PRIMARY KEY, resource TEXT NOT NULL, batch_limit INTEGER NOT NULL, document TEXT NOT NULL);
CREATE TABLE replies(dynamic_id TEXT NOT NULL, root_id TEXT NOT NULL, id TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(dynamic_id,root_id,id), FOREIGN KEY(dynamic_id,root_id) REFERENCES root_comments(dynamic_id,id));
CREATE TABLE reply_sync(dynamic_id TEXT NOT NULL, root_id TEXT NOT NULL, status TEXT NOT NULL, synced_source_reply_count INTEGER, PRIMARY KEY(dynamic_id,root_id), FOREIGN KEY(dynamic_id,root_id) REFERENCES root_comments(dynamic_id,id));
CREATE TABLE reply_pages(token TEXT PRIMARY KEY, resource TEXT NOT NULL, document TEXT NOT NULL);
PRAGMA user_version = 7;
