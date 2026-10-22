import { useState } from 'react';
import { UserAvatar } from '../dynamics/UserAvatar';
import type { ManagedUp, ManagementApi, MonitorConfig } from './managementApi';
import type { ManagementRequests } from './useManagementRequests';
import { TargetManager } from './TargetManager';
import { CheckStatusPanel } from './CheckStatusPanel';
import { DiscoveryStatusPanel } from './DiscoveryStatusPanel';

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
  const user = { id: up.uid, nickname: up.name?.trim() ? up.name : null, avatarUrl: up.avatarUrl };
  return <article className="manage-card manage-up" aria-label={`UP ${up.uid}`} aria-busy={busy}>
    <header className="manage-identity">
      <UserAvatar user={user} className="manage-avatar" />
      <div className="manage-identity-text">
        <h2 className="manage-author">{user.nickname ?? '未知用户'}</h2>
        <p className="manage-muted">UID：{up.uid}</p>
      </div>
      <span className="manage-badge">{up.monitor ? up.monitor.enabled ? '监控已启用' : '监控已停止' : '配置已删除'}</span>
    </header>
    <div className="manage-control-row manage-summary-row">
      <p>监控：{up.monitor ? up.monitor.enabled ? '已启用' : '已停止' : '无配置'}</p>
      {up.monitor
        ? <button type="button" disabled={busy} onClick={() => void toggle()}>
          {pending === 'toggle' && busy ? `正在${up.monitor.enabled ? '停止' : '启用'}…`
            : notice?.error && notice.action === 'toggle' ? `重试${up.monitor.enabled ? '停止' : '启用'}`
            : up.monitor.enabled ? '停止监控' : '启用监控'}
        </button>
        : <button type="button" disabled={busy} onClick={() => void reAdd()}>
          {busy && pending === 'add' ? '正在重新添加…' : notice?.error && notice.action === 'add' ? '重试重新添加' : '重新添加监控'}
        </button>}
    </div>
    {notice && <p className="manage-feedback" role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    <details className="manage-details">
      <summary>详细设置</summary>
      <section className="manage-section" aria-label="监控配置">
        <h2>监控配置</h2>
        {up.monitor ? <>
          <p>已保存模式：{up.monitor.mode === 'recent' ? <>近期 N 条；N：{up.monitor.recentN}</> : '指定动态 ID'}。</p>
          <p className="manage-muted">启停立即生效，使用已保存配置，不会保存下方草稿。</p>
          <form noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
            <fieldset disabled={busy}>
              <legend className="manage-sr-only">配置草稿</legend>
              <div className={`manage-config-fields${mode === 'specified' ? ' manage-config-specified' : ''}`}>
                <div className="manage-field">
                  <label htmlFor={`manage-mode-${up.uid}`}>监控模式</label>
                  <select id={`manage-mode-${up.uid}`} value={mode} onChange={event => {
                    const value = event.target.value;
                    if (value === 'recent' || value === 'specified') { setMode(value); setNotice(null); }
                  }}>
                    <option value="recent">近期 N 条</option><option value="specified">指定动态 ID</option>
                  </select>
                </div>
                {mode === 'recent' && <div className="manage-field">
                  <label htmlFor={`manage-n-${up.uid}`}>近期 N 条</label>
                  <input id={`manage-n-${up.uid}`} type="text" inputMode="numeric" value={recentN}
                    onChange={event => { setRecentN(event.target.value); setNotice(null); }} />
                </div>}
                <button className="manage-primary" type="submit">{busy && pending === 'save' ? '正在保存…' : notice?.error && notice.action === 'save' ? '重试保存' : '保存配置'}</button>
              </div>
              {mode === 'specified' && <p className="manage-muted">保存指定模式后仅监控下方关联目标；不附加近期动态。</p>}
            </fieldset>
          </form>
        </> : <p className="manage-muted">暂无监控配置，重新添加后可编辑。</p>}
      </section>
      {up.monitor && mode === 'specified' ? <TargetManager uid={up.uid} api={api} requests={requests} />
        : <section className="manage-section" aria-label="指定动态目标">
          <h2>指定动态目标</h2>
          <p className="manage-muted">{up.monitor ? '近期模式按已保存的 N 值监控；切换指定模式可管理关联目标。' : '配置已删除，不再监控目标；已有归档保留。'}</p>
        </section>}
      <DiscoveryStatusPanel key={`${up.uid}:${up.monitor?.mode}:${up.monitor?.recentN}:${up.monitor?.enabled}`}
        uid={up.uid} api={api} />
      <CheckStatusPanel uid={up.uid} api={api} monitor={up.monitor} />
      <footer className="manage-section manage-footer">
        {up.monitor ? <div className="manage-actions">
          <button className="manage-delete" type="button" disabled={busy} onClick={() => void remove()}>
            {busy && pending === 'delete' ? '正在删除…' : notice?.error && notice.action === 'delete' ? '重试删除' : '删除监控配置'}
          </button>
          <span className="manage-muted">仅删除配置，保留身份和已有归档。</span>
        </div> : <p>监控配置已删除；身份和已有归档保留。</p>}
      </footer>
    </details>
  </article>;
}
