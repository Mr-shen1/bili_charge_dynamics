import { useEffect, useRef, useState } from 'react';
import { isValidId } from '../data/identifiers';
import { invalidTargetMessage, type ManagedTarget, type ManagementApi } from './managementApi';
import type { ManagementRequests } from './useManagementRequests';

export function TargetManager({ uid, api, requests }: { uid: string; api: ManagementApi; requests: ManagementRequests }) {
  const [targets, setTargets] = useState<readonly ManagedTarget[]>([]);
  const [readState, setReadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [readError, setReadError] = useState('');
  const [id, setId] = useState('');
  const [notice, setNotice] = useState<{ error: boolean; text: string; action: 'add' | 'delete' } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const readRequest = useRef<AbortController | null>(null);
  const lifetime = useRef(new AbortController());
  const busy = requests.busyUids.has(uid);
  async function load() {
    if (readRequest.current) return;
    const request = new AbortController();
    readRequest.current = request;
    setReadState('loading');
    const result = await api.listTargets({ uid, signal: request.signal });
    if (request.signal.aborted || readRequest.current !== request) return;
    readRequest.current = null;
    if (result.status === 'success') { setTargets(result.data); setReadState('ready'); }
    else if (result.status === 'error') { setReadError(result.message); setReadState('error'); }
  }
  useEffect(() => {
    lifetime.current = new AbortController();
    void load();
    return () => {
      lifetime.current.abort();
      readRequest.current?.abort(); readRequest.current = null;
    };
  }, [api, uid]);
  async function add() {
    if (busy || readState !== 'ready') return;
    if (!isValidId(id)) { setNotice({ error: true, text: invalidTargetMessage, action: 'add' }); return; }
    const visit = lifetime.current;
    setNotice(null); setPending('add');
    const result = await requests.run(uid, signal => api.addTarget({ uid, id, signal: AbortSignal.any([signal, visit.signal]) }));
    if (!result || visit.signal.aborted) return;
    setPending(null);
    if (result.status === 'success') {
      setTargets(previous => previous.some(target => target.id === result.data.id) ? previous
        : [...previous, result.data].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      setId(''); setNotice({ error: false, text: '归属校验通过，目标关联已保存。', action: 'add' });
    } else if (result.status === 'error') setNotice({ error: true, text: result.message, action: 'add' });
  }
  async function remove(targetId: string) {
    if (busy || readState !== 'ready') return;
    const visit = lifetime.current;
    setNotice(null); setPending(targetId);
    const result = await requests.run(uid, signal => api.deleteTarget({ uid, id: targetId, signal: AbortSignal.any([signal, visit.signal]) }));
    if (!result || visit.signal.aborted) return;
    setPending(null);
    if (result.status === 'success') {
      setTargets(previous => previous.filter(target => target.id !== targetId));
      setNotice({ error: false, text: '目标已移除；已有归档保留。', action: 'delete' });
    } else if (result.status === 'error') setNotice({ error: true, text: result.message, action: 'delete' });
  }
  return <section className="manage-section" aria-label="指定动态目标">
    <h2>指定动态目标</h2>
    <p className="manage-muted">仅在已保存的指定模式下监控关联集合。添加前由服务端验证作者；移除仅停止监控，不删除归档。</p>
    {readState === 'loading' && <p role="status">正在读取指定目标…</p>}
    {readState === 'error' && <><p role="alert">{readError}</p><button type="button" onClick={() => void load()}>重试读取目标</button></>}
    {readState === 'ready' && <>
      {targets.length === 0 ? <p>尚未添加指定目标。</p> : <ul className="manage-targets">
        {targets.map(target => <li key={target.id}>
          <span>{target.id}</span>{' '}
          <button type="button" disabled={busy} aria-label={`移除目标 ${target.id}`} onClick={() => void remove(target.id)}>
            {busy && pending === target.id ? '正在移除…' : '移除目标'}
          </button>
        </li>)}
      </ul>}
      <form noValidate onSubmit={event => { event.preventDefault(); void add(); }}>
        <fieldset className="manage-add-fields" disabled={busy}>
          <div className="manage-field">
            <label htmlFor={`manage-target-${uid}`}>动态 ID</label>
            <input id={`manage-target-${uid}`} type="text" inputMode="numeric" autoComplete="off" value={id}
              onChange={event => { setId(event.target.value); setNotice(null); }} />
          </div>
          <button type="submit">{busy && pending === 'add' ? '正在校验…' : notice?.error && notice.action === 'add' ? '重试添加目标' : '校验并添加目标'}</button>
        </fieldset>
      </form>
    </>}
    {notice && <p className="manage-feedback" role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
  </section>;
}
