import { useState } from 'react';
import { Identity, displayTime } from '../dynamics/DynamicContent';
import type { ManagedUp, ManagementApi, MonitorConfig } from './managementApi';
import type { ManagementRequests } from './useManagementRequests';

export function UpCard({ up, api, requests, onChange }: {
  up: ManagedUp; api: ManagementApi; requests: ManagementRequests; onChange(up: ManagedUp): void;
}) {
  const [mode, setMode] = useState<MonitorConfig['mode']>(up.monitor?.mode ?? 'recent');
  const [recentN, setRecentN] = useState(String(up.monitor?.recentN ?? 10));
  const [notice, setNotice] = useState<{ error: boolean; text: string; action: 'save' | 'toggle' | 'delete' | 'add' } | null>(null);
  const [pending, setPending] = useState<'save' | 'toggle' | 'delete' | 'add' | null>(null);
  const busy = requests.busyUids.has(up.uid);
  async function remove() {
    if (busy || !up.monitor) return;
    setNotice(null); setPending('delete');
    const result = await requests.run(up.uid, signal => api.deleteMonitor({ uid: up.uid, signal }));
    if (!result) return;
    setPending(null);
    if (result.status === 'success') onChange({ ...up, monitor: null });
    else if (result.status === 'error') setNotice({ error: true, text: result.message, action: 'delete' });
  }
  async function reAdd() {
    if (busy || up.monitor) return;
    setNotice(null); setPending('add');
    const result = await requests.run(up.uid, signal => api.addUp({ uid: up.uid, signal }));
    if (!result) return;
    setPending(null);
    if (result.status === 'success') onChange(result.data);
    else if (result.status === 'error') setNotice({ error: true, text: result.message, action: 'add' });
  }
  async function toggle() {
    const monitor = up.monitor;
    if (busy || !monitor) return;
    setNotice(null); setPending('toggle');
    const result = await requests.run(up.uid, signal => api.updateMonitor({ uid: up.uid,
      monitor: { mode: monitor.mode, recentN: monitor.recentN, enabled: !monitor.enabled }, signal }));
    if (!result) return;
    setPending(null);
    if (result.status === 'success') { onChange(result.data); setNotice({ error: false, text: '启停已保存。', action: 'toggle' }); }
    else if (result.status === 'error') setNotice({ error: true, text: result.message, action: 'toggle' });
  }
  async function save() {
    if (busy || !up.monitor) return;
    const n = /^[1-9][0-9]*$/.test(recentN) ? Number(recentN) : NaN;
    if (!Number.isSafeInteger(n) || n < 1) {
      setNotice({ error: true, text: '近期 N 须为正的安全整数，最大 9007199254740991。', action: 'save' }); return;
    }
    setNotice(null); setPending('save');
    const result = await requests.run(up.uid, signal => api.updateMonitor({ uid: up.uid,
      monitor: { mode, recentN: n, enabled: up.monitor?.enabled ?? false }, signal }));
    if (!result) return;
    setPending(null);
    if (result.status === 'success') { onChange(result.data); setNotice({ error: false, text: '保存成功。', action: 'save' }); }
    else if (result.status === 'error') setNotice({ error: true, text: result.message, action: 'save' });
  }
  return <article className="manage-card" aria-label={`UP ${up.uid}`} aria-busy={busy}>
    <Identity user={{ id: up.uid, nickname: up.name?.trim() ? up.name : null, avatarUrl: up.avatarUrl }} />
    <p className="manage-muted">UID：{up.uid}</p>
    <p>最近检查：{up.monitor?.lastCheckedAt ? displayTime(up.monitor.lastCheckedAt) : '未检查'}</p>
    <p>最近成功：{up.monitor?.lastSucceededAt ? displayTime(up.monitor.lastSucceededAt) : '未检查'}</p>
    {up.monitor && <>
      <p>监控：{up.monitor.enabled ? '已启用' : '已停止'}</p>
      <button type="button" disabled={busy} onClick={() => void toggle()}>
        {pending === 'toggle' && busy ? `正在${up.monitor.enabled ? '停止' : '启用'}…`
          : notice?.error && notice.action === 'toggle' ? `重试${up.monitor.enabled ? '停止' : '启用'}`
          : up.monitor.enabled ? '停止监控' : '启用监控'}
      </button>
      <p className="manage-muted">启停立即生效，使用已保存配置，不会保存下方草稿。</p>
    </>}
    {up.monitor && <form noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy}>
        <legend>监控配置</legend>
        <label htmlFor={`manage-mode-${up.uid}`}>监控模式</label>
        <select id={`manage-mode-${up.uid}`} value={mode} onChange={event => {
          const value = event.target.value;
          if (value === 'recent' || value === 'specified') { setMode(value); setNotice(null); }
        }}>
          <option value="recent">近期 N 条</option><option value="specified">指定动态 ID</option>
        </select>
        {mode === 'recent' ? <div className="manage-field">
          <label htmlFor={`manage-n-${up.uid}`}>近期 N 条</label>
          <input id={`manage-n-${up.uid}`} type="text" inputMode="numeric" value={recentN}
            onChange={event => { setRecentN(event.target.value); setNotice(null); }} />
        </div> : <p className="manage-muted">指定动态目标的增加、移除与归属校验将在后续交付；本期仅保存模式。</p>}
        <button type="submit">{busy && pending === 'save' ? '正在保存…' : notice?.error && notice.action === 'save' ? '重试保存' : '保存配置'}</button>
      </fieldset>
    </form>}
    {up.monitor ? <div className="manage-actions">
      <button className="manage-delete" type="button" disabled={busy} onClick={() => void remove()}>
        {busy && pending === 'delete' ? '正在删除…' : notice?.error && notice.action === 'delete' ? '重试删除' : '删除监控配置'}
      </button>
      <span className="manage-muted">仅删除配置，保留身份和已有归档。</span>
    </div> : <>
      <p>监控配置已删除；身份和已有归档保留。</p>
      <button type="button" disabled={busy} onClick={() => void reAdd()}>
        {busy && pending === 'add' ? '正在重新添加…' : notice?.error && notice.action === 'add' ? '重试重新添加' : '重新添加监控'}
      </button>
    </>}
    {notice && <p role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
  </article>;
}
