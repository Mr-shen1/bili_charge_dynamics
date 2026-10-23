import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAppNavigation } from '../app/Navigation';
import { type ManagedUp, type ManagementApi, managementApi } from './managementApi';
import { useManagementRequests } from './useManagementRequests';
import { UpCard } from './UpCard';
import './manage.css';

/** 单 UP 管理页：身份、监控配置、指定目标与检查状态集中在一处。 */
export function UpManagePage({ api = managementApi }: { api?: ManagementApi }) {
  const { upId } = useParams();
  const { pageEntryId } = useAppNavigation();
  return <UpVisit key={`${pageEntryId}:${upId ?? ''}`} api={api} uid={upId ?? ''} />;
}

function UpVisit({ api, uid }: { api: ManagementApi; uid: string }) {
  const [up, setUp] = useState<ManagedUp | null>(null);
  const [readState, setReadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [readError, setReadError] = useState('');
  const readRequest = useRef<AbortController | null>(null);
  const requests = useManagementRequests(api);
  async function load() {
    if (readRequest.current) return;
    const request = new AbortController();
    readRequest.current = request;
    setReadState('loading');
    const result = await api.listUps({ signal: request.signal });
    if (request.signal.aborted || readRequest.current !== request) return;
    readRequest.current = null;
    if (result.status === 'success') { setUp(result.data.find(item => item.uid === uid) ?? null); setReadState('ready'); }
    if (result.status === 'error') { setReadError(result.message); setReadState('error'); }
  }
  useEffect(() => {
    void load();
    return () => { readRequest.current?.abort(); readRequest.current = null; };
  }, [api, uid]);
  return <main className="manage-page">
    <header className="manage-header">
      <h1>UP 监控管理</h1>
      <nav aria-label="页面导航">
        <Link to="/">返回阅读</Link>
        <Link to="/manage">UP 列表</Link>
        <span aria-current="page">监控管理</span>
      </nav>
    </header>
    {readState === 'loading' && <p className="manage-card" role="status">正在读取管理配置…</p>}
    {readState === 'error' && <div className="manage-card manage-notice"><p role="alert">{readError}</p>
      <button type="button" onClick={() => void load()}>重新读取</button></div>}
    {readState === 'ready' && !up && <div className="manage-card manage-notice">
      <p role="status">未找到该 UP，可能已被删除。</p>
      <Link to="/manage">返回 UP 列表</Link>
    </div>}
    {readState === 'ready' && up && <UpCard key={`${up.uid}:${up.monitor !== null}`} up={up} api={api}
      requests={requests} onChange={setUp} />}
  </main>;
}
