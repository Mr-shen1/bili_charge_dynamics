import type { User } from '../data/contracts';
import type { ManagedUp } from './managementApi';

/** 列表与单 UP 页共用同一状态文案：删除配置后身份仍在，因此不是“未监控”。 */
export function manageStatus(up: ManagedUp): string {
  if (!up.monitor) return '配置已删除';
  return up.monitor.enabled ? '监控已启用' : '监控已停止';
}

/** 昵称只作展示文字；空白昵称按未知用户处理，头像地址为空时由 UserAvatar 兜底。 */
export function manageUser(up: ManagedUp): User {
  return { id: up.uid, nickname: up.name?.trim() ? up.name : null, avatarUrl: up.avatarUrl };
}
