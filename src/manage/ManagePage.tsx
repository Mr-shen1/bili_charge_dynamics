import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useAppNavigation } from '../app/Navigation';
import { type ManagedUp, type ManagementApi, invalidUidMessage, isValidUid, managementApi } from './managementApi';
import { UpCard } from './UpCard';
import { useManagementRequests } from './useManagementRequests';
import './manage.css';

export function ManagePage({ api = managementApi }: { api?: ManagementApi }) {
  const { pageEntryId } = useAppNavigation();
  return <ManageVisit key={pageEntryId} api={api} />;
}
function ManageVisit({ api }: { api: ManagementApi }) {
  const [ups, setUps] = useState<readonly ManagedUp[]>([]);
  const [readState, setReadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [readError, setReadError] = useState('');
  const readRequest = useRef<AbortController | null>(null);
  const requests = useManagementRequests(api);
  const [uid, setUid] = useState('');
  const [addNotice, setAddNotice] = useState<{ error: boolean; text: string } | null>(null);
  function replaceUp(up: ManagedUp) {
    setUps(previous => previous.some(item => item.uid === up.uid)
      ? previous.map(item => item.uid === up.uid ? up : item)
      : [...previous, up].sort((a, b) => a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  }
  async function add() {
    if (readState !== 'ready' || requests.busyUids.has(uid)) return;
    if (!isValidUid(uid)) {
      setAddNotice({ error: true, text: invalidUidMessage });
      return;
    }
    setAddNotice(null);
    const result = await requests.run(uid, signal => api.addUp({ uid, signal }));
    if (!result) return;
    if (result.status === 'success') {
      replaceUp(result.data); setUid(''); setAddNotice({ error: false, text: '添加成功。' });
    } else if (result.status === 'error') setAddNotice({ error: true, text: result.message });
  }
  async function load() {
    if (readRequest.current) return;
    const request = new AbortController();
    readRequest.current = request;
    setReadState('loading');
    const result = await api.listUps({ signal: request.signal });
    if (request.signal.aborted || readRequest.current !== request) return;
    readRequest.current = null;
    if (result.status === 'success') { setUps(result.data); setReadState('ready'); }
    if (result.status === 'error') { setReadError(result.message); setReadState('error'); }
  }
  useEffect(() => {
    void load();
    return () => { readRequest.current?.abort(); readRequest.current = null; };
  }, [api]);
  return <main className="manage-page">
    <header className="manage-header">
      <h1>UP 监控管理</h1>
      <nav aria-label="页面导航"><Link to="/">返回阅读</Link><span aria-current="page">监控管理</span></nav>
    </header>
    {readState === 'loading' && <p className="manage-card" role="status">正在读取管理配置…</p>}
    {readState === 'error' && <div className="manage-card manage-notice"><p role="alert">{readError}</p>
      <button type="button" onClick={() => void load()}>重新读取</button></div>}
    {readState === 'ready' && <>
      <form className="manage-card manage-add" aria-label="添加 UP" onSubmit={event => { event.preventDefault(); void add(); }} noValidate>
        <h2>添加 UP</h2>
        <div className="manage-add-fields">
          <div className="manage-field">
            <label htmlFor="manage-uid">UP UID</label>
            <input id="manage-uid" type="text" inputMode="numeric" autoComplete="off" value={uid}
              disabled={requests.busyUids.has(uid)} aria-describedby="manage-uid-help"
              onChange={event => { setUid(event.target.value); setAddNotice(null); }} />
          </div>
          <button className="manage-primary" type="submit" disabled={requests.busyUids.has(uid)}>{requests.busyUids.has(uid) ? '正在添加…' : addNotice?.error ? '重试添加' : '添加监控'}</button>
        </div>
        <p id="manage-uid-help" className="manage-muted">仅输入 UID，由服务端取得昵称与头像；不编辑身份或凭据。</p>
        {addNotice && <p className="manage-feedback" role={addNotice.error ? 'alert' : 'status'}>{addNotice.text}</p>}
      </form>
      {ups.length === 0 && <p className="manage-card manage-empty">尚未保存 UP，请输入 UID 添加。</p>}
      {ups.map(up => <UpCard key={`${up.uid}:${up.monitor !== null}`} up={up} api={api} requests={requests} onChange={replaceUp} />)}
    </>}
  </main>;
}
