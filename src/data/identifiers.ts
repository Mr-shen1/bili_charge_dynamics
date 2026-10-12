const validId = /^[1-9][0-9]{0,127}$/;

/** UID 与动态 ID 均以不经数值转换的十进制字符串传递。 */
export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && validId.test(value);
}
