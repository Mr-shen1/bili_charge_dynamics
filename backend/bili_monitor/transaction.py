"""短事务：`BEGIN IMMEDIATE` → 提交，异常回滚后原样抛出。

投递、检查、同步与采集主循环都按「短事务 + 事务外网络」组织：一次 `write()` 只包住
一组必须原子落的写入，网络等待、限流退避与日志都不进入事务。每次取一条独立连接，
调用方不需要自己写 BEGIN/commit/rollback 样板。
"""

from contextlib import contextmanager


@contextmanager
def immediate(connection):
    """在已打开的连接上开一个可写短事务；异常回滚并原样抛出。"""
    connection.execute("BEGIN IMMEDIATE")
    try:
        yield connection
        connection.commit()
    except BaseException:
        connection.rollback()
        raise


@contextmanager
def write(store):
    """取一条独立连接并开可写短事务；退出（含 return）时提交或回滚，然后关连接。"""
    with store.connection() as connection, immediate(connection):
        yield connection
