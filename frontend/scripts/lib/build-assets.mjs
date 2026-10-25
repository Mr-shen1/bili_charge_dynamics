// 构建产物命名的共享判定：交付脚本与产物隔离检查必须用同一套规则，
// 否则一处放宽、一处收紧会让“产物完整”变成两套互相矛盾的说法。
export const MIN_ROUTE_CHUNKS = 6;

// Vite 输出：<名字>-<8 位以上内容哈希>.<扩展名>；/assets 下不允许未版本化文件。
export const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|svg|png|jpe?g|webp)$/;

// 路由级 chunk：六条正式路由各自拆包，入口脚本之外仍需逐个可达。
export const ROUTE_CHUNK = /Page-[A-Za-z0-9_-]+\.js$/;

export function routeChunkNames(names) {
  return names.filter(name => ROUTE_CHUNK.test(name));
}
