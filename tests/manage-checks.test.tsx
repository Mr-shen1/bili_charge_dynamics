import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../src/app/App';
import { createMockReader } from '../src/data/mockReader';
import { createManagementApi } from '../src/manage/managementApi';

const signal = new AbortController().signal;
const check = {
  id: '900719925474099312345', active: true, check_status: 'unchanged',
  last_checked_at: '2025-06-01T02:00:00Z', last_succeeded_at: null,
  observed: { observed_version: 'edit:2025-06-01T10:00+08:00', edit_status: 'observed' },
  revision: 2, work: 'pending', check_error: null, sync_error: 'SYNC_INCOMPLETE',
  synced_version: 'edit:2025-06-01T09:00+08:00',
  parts: { text: 'pending', media: 'pending', comments: 'success', replies: 'success', comment_media: 'success' },
};
const up = { uid: '123', name: '测试 UP', avatar_url: null, monitor: {
  mode: 'specified', recent_n: 10, enabled: true, last_checked_at: null, last_succeeded_at: null,
} };
const reader = createMockReader({ creator: { id: '123', nickname: '测试 UP', avatarUrl: null }, dynamics: [] });

describe('目标检查生产映射', () => {
  it('独立映射观察和实际成功版本，不把无变化或旧正文成功当成新版本已完成', async () => {
    const api = createManagementApi(async (url, init) => {
      expect(url).toBe('/api/manage/ups/123/checks');
      expect(init.method).toBe('GET');
      expect(init.signal).toBe(signal);
      return Response.json({ checks: [check] });
    });
    expect(await api.listChecks({ uid: '123', signal })).toMatchObject({ status: 'success', data: [{
      id: check.id, active: true, checkStatus: 'unchanged', work: 'pending', revision: 2,
      observedVersion: check.observed.observed_version, syncedVersion: check.synced_version,
      lastCheckedAt: '2025-06-01T02:00:00Z', lastSucceededAt: null,
      parts: { text: 'pending', media: 'pending' }, syncError: 'SYNC_INCOMPLETE',
    }] });
  });
  it('来源总数、本地根回复数、计数观察与整轮 checkpoint 独立映射，旧字段缺失为未知', async () => {
    const records = [check, { ...check, id: '2',
      observed: { ...check.observed, source_comment_count: 1234567, comment_count_status: 'failed' },
      local_comment_count: 20, local_reply_count: 0, synced_comment_count: 70, comments_last_attempt: 'failed',
    }];
    const result = await createManagementApi(async () => Response.json({ checks: records })).listChecks({ uid: '123', signal });
    expect(result).toMatchObject({ status: 'success', data: [
      { sourceCommentCount: null, localCommentCount: null, localReplyCount: null,
        commentCountStatus: null, syncedCommentCount: null, commentsLastAttempt: null },
      { sourceCommentCount: 1234567, localCommentCount: 20, localReplyCount: 0,
        commentCountStatus: 'failed', syncedCommentCount: 70, commentsLastAttempt: 'failed' },
    ] });
  });
  it('评论分项实际成功时间和固定错误单独映射，旧响应未知不借用整轮成功时间', async () => {
    const result = await createManagementApi(async () => Response.json({ checks: [
      { ...check, last_succeeded_at: '2025-06-01T02:01:00Z' },
      { ...check, id: '2', root_comments_last_succeeded_at: '2025-06-01T02:02:00Z',
        replies_last_succeeded_at: '2025-06-01T10:03:00+08:00', comments_last_succeeded_at: null,
        root_comments_error: null, replies_error: 'REPLIES_FAILED', comments_error: 'REPLIES_FAILED',
        error_message: 'SECRET_TOKEN' },
    ] })).listChecks({ uid: '123', signal });
    expect(result).toMatchObject({ status: 'success', data: [
      { rootCommentsLastSucceededAt: null, repliesLastSucceededAt: null, commentsLastSucceededAt: null,
        rootCommentsError: null, repliesError: null, commentsError: null },
      { rootCommentsLastSucceededAt: '2025-06-01T02:02:00Z', repliesLastSucceededAt: '2025-06-01T10:03:00+08:00',
        commentsLastSucceededAt: null, rootCommentsError: null, repliesError: 'REPLIES_FAILED', commentsError: 'REPLIES_FAILED' },
    ] });
    expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
  });
  it('正文和两类媒体实际成功时间、固定错误独立映射，旧响应缺字段为 null 和空数组', async () => {
    const result = await createManagementApi(async () => Response.json({ checks: [
      { ...check, last_succeeded_at: '2025-06-01T02:01:00Z' },
      { ...check, id: '2', text_last_succeeded_at: '2025-06-01T02:02:00Z',
        media_last_succeeded_at: '2025-06-01T10:03:00+08:00', comment_media_last_succeeded_at: null,
        media_errors: ['MEDIA_DOWNLOAD_FAILED', 'MEDIA_UPLOAD_FAILED'], comment_media_errors: ['MEDIA_UPLOAD_FAILED'],
        error_message: 'SECRET_TOKEN https://origin.invalid/?signature=secret' },
      { ...check, id: '3', text_last_succeeded_at: null, media_last_succeeded_at: null,
        comment_media_last_succeeded_at: '2025-06-01T02:04:00Z', media_errors: [], comment_media_errors: [] },
    ] })).listChecks({ uid: '123', signal });
    expect(result).toMatchObject({ status: 'success', data: [
      { textLastSucceededAt: null, mediaLastSucceededAt: null, commentMediaLastSucceededAt: null,
        mediaErrors: [], commentMediaErrors: [] },
      { textLastSucceededAt: '2025-06-01T02:02:00Z', mediaLastSucceededAt: '2025-06-01T10:03:00+08:00',
        commentMediaLastSucceededAt: null, mediaErrors: ['MEDIA_DOWNLOAD_FAILED', 'MEDIA_UPLOAD_FAILED'],
        commentMediaErrors: ['MEDIA_UPLOAD_FAILED'] },
      { textLastSucceededAt: null, mediaLastSucceededAt: null, commentMediaLastSucceededAt: '2025-06-01T02:04:00Z',
        mediaErrors: [], commentMediaErrors: [] },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_TOKEN|origin\.invalid|signature/);
  });
  it('管理页展示分项及较新版本待同步，手动读取不执行同步', async () => {
    const user = userEvent.setup();
    let current: unknown = check;
    const urls: string[] = [];
    const api = createManagementApi(async (url, init) => {
      urls.push(url);
      expect(init.method).toBe('GET');
      if (url.endsWith('/checks')) return Response.json({ checks: [current] });
      if (url.endsWith('/targets')) return Response.json({ targets: [{ id: check.id }] });
      return Response.json({ ups: [up] });
    });
    render(<MemoryRouter initialEntries={['/manage']}><App reader={reader} manageApi={api} /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: '读取检查状态' }));
    const region = await screen.findByRole('region', { name: `动态 ${check.id} 检查状态` });
    const status = within(region);
    expect(status.getByText('检查无变化；不代表同步完成。')).toBeInTheDocument();
    expect(status.getByText('部分完成')).toBeInTheDocument();
    // 详情默认折叠：头部只留 ID、纳入状态与检查阶段，细节靠 aria-expanded 控制。
    const toggle = status.getByRole('button', { name: `展开动态 ${check.id} 详情` });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const body = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(body).toHaveAttribute('hidden');
    expect(body).toHaveTextContent('已纳入检查');
    expect(body).toHaveTextContent('实际整轮成功：尚未成功');
    await user.click(toggle);
    expect(status.getByRole('button', { name: `收起动态 ${check.id} 详情` })).toHaveAttribute('aria-expanded', 'true');
    expect(body).not.toHaveAttribute('hidden');
    expect(status.getByText('观察与正文成功版本不一致；当前观察仍待同步确认。')).toBeInTheDocument();
    expect(status.getByText('正文待处理；动态图待处理；评论已保存；回复已保存；评论图已保存。')).toBeInTheDocument();
    expect(status.getByText('实际整轮成功：尚未成功')).toBeInTheDocument();
    current = { ...check, work: 'running', sync_error: null,
      synced_version: check.observed.observed_version, parts: { ...check.parts, text: 'success' } };
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(await status.findByText('同步中')).toBeInTheDocument();
    expect(status.getByText('正文已保存；动态图待处理；评论已保存；回复已保存；评论图已保存。')).toBeInTheDocument();
    expect(urls.every(url => url.startsWith('/api/manage/'))).toBe(true);
  });
  it('管理页独立展示完整计数、未知与零；失败保留可信数而成功评论不冒充图片完成', async () => {
    const user = userEvent.setup();
    const api = createManagementApi(async (url, init) => {
      expect(init.method).toBe('GET');
      if (!url.endsWith('/checks')) return Response.json({ ups: [{ ...up, monitor: { ...up.monitor, mode: 'recent' } }] });
      return Response.json({ checks: [
        { ...check, observed: { ...check.observed, source_comment_count: 1234567, comment_count_status: 'failed' },
          local_comment_count: 20, local_reply_count: 30, synced_comment_count: 70, comments_last_attempt: 'failed',
          parts: { ...check.parts, replies: 'pending' } },
        { ...check, id: '1', observed: {}, comments_last_attempt: 'unconfirmed' },
        { ...check, id: '2', observed: { source_comment_count: 0, comment_count_status: 'observed' },
          local_comment_count: 0, local_reply_count: 0, synced_comment_count: 0, comments_last_attempt: 'success',
          parts: { ...check.parts, text: 'restricted', comment_media: 'pending' } },
      ] });
    });
    render(<MemoryRouter initialEntries={['/manage']}><App reader={reader} manageApi={api} /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: '读取检查状态' }));
    const partial = within(await screen.findByRole('region', { name: `动态 ${check.id} 检查状态` }));
    expect(partial.getByText('来源评论总数：1234567')).toBeInTheDocument();
    expect(partial.getByText('本地根评论数：20')).toBeInTheDocument();
    expect(partial.getByText('本地回复数：30')).toBeInTheDocument();
    expect(partial.getByText('评论计数检查：失败；保留已有可信数。')).toBeInTheDocument();
    expect(partial.getByText('评论整轮成功计数（来源总数）：70')).toBeInTheDocument();
    expect(partial.getByText('评论整轮最近尝试：失败')).toBeInTheDocument();
    expect(partial.getByText('来源计数与评论整轮成功计数不一致；当前观察仍待评论同步确认。')).toBeInTheDocument();
    const unknown = within(screen.getByRole('region', { name: '动态 1 检查状态' }));
    expect(unknown.getByText('来源评论总数：—')).toBeInTheDocument();
    expect(unknown.getByText('本地根评论数：—')).toBeInTheDocument();
    expect(unknown.getByText('本地回复数：—')).toBeInTheDocument();
    expect(unknown.getByText('评论整轮成功计数（来源总数）：—')).toBeInTheDocument();
    expect(unknown.getByText('评论计数检查：未检查或未知')).toBeInTheDocument();
    expect(unknown.getByText('评论整轮最近尝试：未确认')).toBeInTheDocument();
    const empty = within(screen.getByRole('region', { name: '动态 2 检查状态' }));
    expect(empty.getByText('来源评论总数：0')).toBeInTheDocument();
    expect(empty.getByText('本地根评论数：0')).toBeInTheDocument();
    expect(empty.getByText('本地回复数：0')).toBeInTheDocument();
    expect(empty.getByText('评论计数检查：已观察')).toBeInTheDocument();
    expect(empty.getByText('评论整轮最近尝试：成功')).toBeInTheDocument();
    expect(empty.getByText('部分完成')).toBeInTheDocument();
    expect(empty.getByText(/正文受限.*评论图待处理/)).toBeInTheDocument();
    expect(screen.getByText('来源总数含根评论和回复；本地数是保留归档量，不是当前已加载数，也不代表全部来源评论。')).toBeInTheDocument();
    expect(screen.getByText('除初始化和失败重试外，仅按来源总数变化同步评论；增删抵消、纯评论编辑或分页移动且总数不变可能漏检，不保证实时或所有受限评论可读。')).toBeInTheDocument();
  });
  it('评论进度独立于正文和图片，并依据当前根回复分项区分待处理、同步中、部分完成和失败', async () => {
    const user = userEvent.setup();
    let current: unknown = { ...check, work: 'pending', comments_last_attempt: 'success',
      observed: { ...check.observed, source_comment_count: 8, comment_count_status: 'observed' },
      synced_comment_count: 7, parts: { ...check.parts, comments: 'pending', replies: 'pending', text: 'success' } };
    const api = createManagementApi(async url => url.endsWith('/checks') ? Response.json({ checks: [current] })
      : Response.json({ ups: [{ ...up, monitor: { ...up.monitor, mode: 'recent' } }] }));
    render(<MemoryRouter initialEntries={['/manage']}><App reader={reader} manageApi={api} /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: '读取检查状态' }));
    const status = within(await screen.findByRole('region', { name: `动态 ${check.id} 检查状态` }));
    expect(status.getByText('评论同步：待处理')).toBeInTheDocument();
    expect(status.getByText('评论整轮最近尝试：成功')).toBeInTheDocument();
    current = { ...check, work: 'running', parts: { ...check.parts, comments: 'pending', replies: 'pending' } };
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(await status.findByText('评论同步：同步中')).toBeInTheDocument();
    current = { ...check, comments_last_attempt: 'failed', parts: { ...check.parts, replies: 'pending' } };
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(await status.findByText('评论同步：部分完成')).toBeInTheDocument();
    current = { ...check, comments_last_attempt: 'failed', sync_error: null,
      parts: { ...check.parts, comments: 'pending', replies: 'pending', text: 'success' } };
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(await status.findByText('评论同步：失败，待重试')).toBeInTheDocument();
    current = { ...check, comments_last_attempt: 'success', parts: { ...check.parts, comment_media: 'failed' } };
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(await status.findByText('评论同步：对应评论观察已完成')).toBeInTheDocument();
    expect(status.getByText('部分完成')).toBeInTheDocument();
    current = { ...check, root_comments_error: 'ROOT_COMMENTS_FAILED', comments_error: 'ROOT_COMMENTS_FAILED',
      parts: { ...check.parts, comments: 'pending', replies: 'pending' } };
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(await status.findByText('评论同步：失败，待重试')).toBeInTheDocument();
    current = { ...check, root_comments_error: 'COMMENT_LOCATOR_UNCONFIRMED', comments_error: 'COMMENT_LOCATOR_UNCONFIRMED',
      parts: { ...check.parts, comments: 'pending', replies: 'pending' } };
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(await status.findByText('评论同步：未确认')).toBeInTheDocument();
    expect(status.getByText('根评论：评论定位信息未确认；保留已有归档。')).toBeInTheDocument();
    current = { ...check, check_status: 'unchecked' };
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(await status.findByText('评论同步：未检查')).toBeInTheDocument();
  });
  it('分项成功时间未知不补造，无变化检查不更新成功时间，根回复错误只显示固定提示', async () => {
    const user = userEvent.setup();
    let current: unknown = { ...check, last_succeeded_at: '2025-06-01T02:01:00Z' };
    const api = createManagementApi(async url => url.endsWith('/checks') ? Response.json({ checks: [current] })
      : Response.json({ ups: [{ ...up, monitor: { ...up.monitor, mode: 'recent' } }] }));
    render(<MemoryRouter initialEntries={['/manage']}><App reader={reader} manageApi={api} /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: '读取检查状态' }));
    const status = within(await screen.findByRole('region', { name: `动态 ${check.id} 检查状态` }));
    expect(status.getByText('根评论最近成功：—')).toBeInTheDocument();
    expect(status.getByText('回复最近成功：—')).toBeInTheDocument();
    expect(status.getByText('评论整轮最近成功：—')).toBeInTheDocument();
    const previous = { ...check, comments_last_attempt: 'failed',
      root_comments_last_succeeded_at: '2025-06-01T01:20:00Z', replies_last_succeeded_at: '2025-06-01T01:30:00Z',
      comments_last_succeeded_at: '2025-06-01T01:35:00Z',
      root_comments_error: 'ROOT_COMMENTS_FAILED', replies_error: 'REPLIES_FAILED', comments_error: 'REPLIES_FAILED',
      error_message: 'SECRET_TOKEN <script>alert(1)</script>' };
    current = previous;
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(await status.findByText('根评论最近成功：2025-06-01 09:20:00')).toBeInTheDocument();
    expect(status.getByText('回复最近成功：2025-06-01 09:30:00')).toBeInTheDocument();
    expect(status.getByText('评论整轮最近成功：2025-06-01 09:35:00')).toBeInTheDocument();
    expect(status.getByText('根评论：根评论归档失败；保留已有归档，将在固定节拍重试。')).toBeInTheDocument();
    expect(status.getByText('回复：回复归档失败；保留已有归档，将在固定节拍重试。')).toBeInTheDocument();
    expect(status.getByText('评论整轮：回复归档失败；保留已有归档，将在固定节拍重试。')).toBeInTheDocument();
    expect(status.getByText('历史分项成功时间不代表当前观察已完成；未知时间不补造。')).toBeInTheDocument();
    current = { ...previous, check_status: 'unchanged', last_checked_at: '2025-06-01T03:00:00Z' };
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(await status.findByText('最近检查：2025-06-01 11:00:00')).toBeInTheDocument();
    expect(status.getByText('根评论最近成功：2025-06-01 09:20:00')).toBeInTheDocument();
    expect(status.getByText('回复最近成功：2025-06-01 09:30:00')).toBeInTheDocument();
    expect(status.getByText('评论整轮最近成功：2025-06-01 09:35:00')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
    expect(document.body).not.toHaveTextContent('<script>');
  });
  it('管理页展示真实正文和媒体分项时间与固定错误，无变化和重读不伪造成功', async () => {
    const user = userEvent.setup();
    let current: unknown = { ...check, last_succeeded_at: '2025-06-01T02:01:00Z' };
    const api = createManagementApi(async (url, init) => {
      expect(init.method).toBe('GET');
      expect(url.startsWith('/api/manage/')).toBe(true);
      return url.endsWith('/checks') ? Response.json({ checks: [current] })
        : Response.json({ ups: [{ ...up, monitor: { ...up.monitor, mode: 'recent' } }] });
    });
    render(<MemoryRouter initialEntries={['/manage']}><App reader={reader} manageApi={api} /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: '读取检查状态' }));
    const status = within(await screen.findByRole('region', { name: `动态 ${check.id} 检查状态` }));
    expect(status.getByText('正文最近成功：—')).toBeInTheDocument();
    expect(status.getByText('动态图最近成功：—')).toBeInTheDocument();
    expect(status.getByText('评论图最近成功：—')).toBeInTheDocument();
    const attempted = { ...check, text_last_succeeded_at: '2025-06-01T01:10:00Z',
      media_last_succeeded_at: '2025-06-01T09:20:00+08:00', comment_media_last_succeeded_at: '2025-06-01T01:30:00Z',
      parts: { ...check.parts, text: 'success', media: 'failed', comment_media: 'failed' },
      media_errors: ['MEDIA_DOWNLOAD_FAILED', 'MEDIA_UPLOAD_FAILED'],
      comment_media_errors: ['MEDIA_DOWNLOAD_FAILED', 'MEDIA_UPLOAD_FAILED'],
      error_message: 'SECRET_TOKEN https://origin.invalid/?signature=secret <script>' };
    current = attempted;
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(await status.findByText('正文最近成功：2025-06-01 09:10:00')).toBeInTheDocument();
    expect(status.getByText('动态图最近成功：2025-06-01 09:20:00')).toBeInTheDocument();
    expect(status.getByText('评论图最近成功：2025-06-01 09:30:00')).toBeInTheDocument();
    for (const part of ['动态图', '评论图']) {
      expect(status.getByText(`${part}：图片下载失败；保留已有归档，将在固定节拍重试。`)).toBeInTheDocument();
      expect(status.getByText(`${part}：图片上传失败；保留已有归档，将在固定节拍重试。`)).toBeInTheDocument();
    }
    expect(status.getByText('部分完成')).toBeInTheDocument();
    expect(status.getByText('实际整轮成功：尚未成功')).toBeInTheDocument();
    expect(status.getByText('历史分项成功时间不代表当前观察已完成；未知时间不补造。')).toBeInTheDocument();
    expect(status.getByText('媒体错误来自实际已尝试的归档；无错误记录不代表图片已完成。')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/SECRET_TOKEN|origin\.invalid|signature|<script>|MEDIA_DOWNLOAD_FAILED|MEDIA_UPLOAD_FAILED/);
    current = { ...attempted, check_status: 'unchanged', last_checked_at: '2025-06-01T03:00:00Z' };
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(await status.findByText('最近检查：2025-06-01 11:00:00')).toBeInTheDocument();
    expect(status.getByText('正文最近成功：2025-06-01 09:10:00')).toBeInTheDocument();
    expect(status.getByText('动态图最近成功：2025-06-01 09:20:00')).toBeInTheDocument();
    expect(status.getByText('评论图最近成功：2025-06-01 09:30:00')).toBeInTheDocument();
    current = { ...attempted, media_errors: [], comment_media_errors: [],
      parts: { ...attempted.parts, media: 'pending', comment_media: 'pending' } };
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(await status.findByText('正文已保存；动态图待处理；评论已保存；回复已保存；评论图待处理。')).toBeInTheDocument();
    expect(status.queryByText(/图片下载失败|图片上传失败/)).not.toBeInTheDocument();
    expect(status.getByText('部分完成')).toBeInTheDocument();
    expect(status.getByText('动态图最近成功：2025-06-01 09:20:00')).toBeInTheDocument();
    expect(status.getByText('评论图最近成功：2025-06-01 09:30:00')).toBeInTheDocument();
  });
  it('未检查、未知信号、失败与停用记录不冒充成功，错误只显示固定提示', async () => {
    const user = userEvent.setup();
    const api = createManagementApi(async url => url.endsWith('/checks') ? Response.json({ checks: [
      { ...check, id: '1', check_status: 'unchecked', revision: 0, observed: {}, synced_version: null,
        sync_error: null, last_checked_at: null, parts: { text: 'pending', media: 'pending', comments: 'pending', replies: 'pending', comment_media: 'pending' } },
      { ...check, id: '2', active: false, check_status: 'failed', observed: { ...check.observed, edit_status: 'error', secret: 'SECRET_TOKEN' },
        check_error: 'SIGNAL_INVALID', sync_error: 'SOURCE_UNAVAILABLE' },
    ] }) : Response.json({ ups: [{ ...up, monitor: { ...up.monitor, mode: 'recent', enabled: false } }] }));
    render(<MemoryRouter initialEntries={['/manage']}><App reader={reader} manageApi={api} /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: '读取检查状态' }));
    const unchecked = within(await screen.findByRole('region', { name: '动态 1 检查状态' }));
    expect(screen.getByText('最近成功：尚未成功')).toBeInTheDocument();
    expect(unchecked.getByText('未检查')).toBeInTheDocument();
    expect(unchecked.getByText('尚无检查工作')).toBeInTheDocument();
    expect(unchecked.getByText('编辑信号未知；不代表确认未编辑。')).toBeInTheDocument();
    const failed = within(screen.getByRole('region', { name: '动态 2 检查状态' }));
    expect(failed.getByText('检查失败')).toBeInTheDocument();
    expect(failed.getByText('已停止或移出；保留已有归档与未完成工作。')).toBeInTheDocument();
    expect(failed.getByText('同步：来源暂不可用。')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
  });
  it('成功时间来自实际执行；读取失败保留旧状态并可原位重试', async () => {
    const user = userEvent.setup();
    let reads = 0;
    let work = 'complete';
    const api = createManagementApi(async url => {
      if (!url.endsWith('/checks')) return Response.json({ ups: [{ ...up, monitor: null }] });
      reads++;
      if (reads === 2) return new Response('SECRET_TOKEN', { status: 500 });
      return Response.json({ checks: [{ ...check, active: false, work,
        synced_version: check.observed.observed_version, sync_error: null,
        last_succeeded_at: '2025-06-01T02:01:00Z', parts: { ...check.parts, text: 'success', media: 'success' } }] });
    });
    render(<MemoryRouter initialEntries={['/manage']}><App reader={reader} manageApi={api} /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: '读取检查状态' }));
    const status = within(await screen.findByRole('region', { name: `动态 ${check.id} 检查状态` }));
    expect(status.getByText('对应观察已完成')).toBeInTheDocument();
    expect(status.getByText('实际整轮成功：2025-06-01 10:01:00')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('管理接口响应异常');
    expect(status.getByText('对应观察已完成')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    work = 'pending';
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(await status.findByText('分项已完成，整轮待确认')).toBeInTheDocument();
    expect(status.queryByText('部分完成')).not.toBeInTheDocument();
  });
  it('忽略取消的旧状态读取不能污染重新进入的管理页', async () => {
    const user = userEvent.setup();
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    let oldSignal: AbortSignal | null | undefined;
    const api = createManagementApi(async (url, init) => {
      if (url.endsWith('/checks')) { oldSignal = init.signal; return pending; }
      return Response.json({ ups: [{ ...up, monitor: { ...up.monitor, mode: 'recent' } }] });
    });
    const view = render(<MemoryRouter initialEntries={['/manage']}><App reader={reader} manageApi={api} /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: '读取检查状态' }));
    view.unmount();
    expect(oldSignal?.aborted).toBe(true);
    render(<MemoryRouter initialEntries={['/manage']}><App reader={reader} manageApi={api} /></MemoryRouter>);
    await screen.findByRole('button', { name: '读取检查状态' });
    await act(async () => resolve(Response.json({ checks: [check] })));
    expect(screen.getByText('尚未读取检查状态。')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: `动态 ${check.id} 检查状态` })).not.toBeInTheDocument();
  });
  it('计数只接收非负安全整数或未知，计数状态和整轮尝试拒绝坏枚举且不泄漏原文', async () => {
    const badCounts = [-1, 0.5, true, 'SECRET_TOKEN', {}, [], Number.MAX_SAFE_INTEGER + 1];
    for (const field of ['source_comment_count', 'local_comment_count', 'local_reply_count', 'synced_comment_count']) {
      for (const value of badCounts) {
        const record = field === 'source_comment_count'
          ? { ...check, observed: { ...check.observed, [field]: value } } : { ...check, [field]: value };
        const result = await createManagementApi(async () => Response.json({ checks: [record] })).listChecks({ uid: '123', signal });
        expect(result).toEqual({ status: 'error', message: '管理接口响应异常，请重试。' });
        expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
      }
    }
    for (const record of [
      { ...check, observed: { ...check.observed, comment_count_status: 'unknown' } },
      { ...check, observed: { ...check.observed, comment_count_status: 'SECRET_TOKEN' } },
      { ...check, observed: { ...check.observed, comment_count_status: false } },
      { ...check, comments_last_attempt: 'SECRET_TOKEN' },
      { ...check, comments_last_attempt: 0 },
    ]) {
      expect(await createManagementApi(async () => Response.json({ checks: [record] })).listChecks({ uid: '123', signal }))
        .toEqual({ status: 'error', message: '管理接口响应异常，请重试。' });
    }
    expect(await createManagementApi(async () => Response.json({ checks: [{ ...check,
      observed: { ...check.observed, source_comment_count: null, comment_count_status: 'failed' },
      local_comment_count: 0, local_reply_count: Number.MAX_SAFE_INTEGER, synced_comment_count: null,
      comments_last_attempt: 'pending',
    }] })).listChecks({ uid: '123', signal })).toMatchObject({ status: 'success', data: [{
      sourceCommentCount: null, commentCountStatus: 'failed', localCommentCount: 0,
      localReplyCount: 9007199254740991, syncedCommentCount: null, commentsLastAttempt: 'pending',
    }] });
  });
  it('分项时间拒绝坏日历、无时区和非字符串；分项错误拒绝原文、聚合码及串项码', async () => {
    for (const field of ['root_comments_last_succeeded_at', 'replies_last_succeeded_at', 'comments_last_succeeded_at']) {
      for (const value of ['2025-02-30T02:00:00Z', '2025-06-01T02:00:00', 'SECRET_TOKEN', 0, true]) {
        const result = await createManagementApi(async () => Response.json({ checks: [{ ...check, [field]: value }] }))
          .listChecks({ uid: '123', signal });
        expect(result).toEqual({ status: 'error', message: '管理接口响应异常，请重试。' });
        expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
      }
    }
    for (const field of ['root_comments_error', 'replies_error', 'comments_error']) {
      for (const value of ['SECRET_TOKEN', 'SOURCE_UNAVAILABLE', 'SYNC_INCOMPLETE', 0, true, {}]) {
        expect(await createManagementApi(async () => Response.json({ checks: [{ ...check, [field]: value }] }))
          .listChecks({ uid: '123', signal })).toEqual({ status: 'error', message: '管理接口响应异常，请重试。' });
      }
    }
    for (const overrides of [
      { root_comments_error: 'REPLIES_FAILED' }, { replies_error: 'ROOT_COMMENTS_FAILED' },
      { replies_error: 'COMMENT_LOCATOR_UNCONFIRMED' },
    ]) {
      expect(await createManagementApi(async () => Response.json({ checks: [{ ...check, ...overrides }] }))
        .listChecks({ uid: '123', signal })).toEqual({ status: 'error', message: '管理接口响应异常，请重试。' });
    }
    expect(await createManagementApi(async () => Response.json({ checks: [{ ...check,
      root_comments_error: 'COMMENT_LOCATOR_UNCONFIRMED', replies_error: null, comments_error: 'COMMENT_LOCATOR_UNCONFIRMED',
      root_comments_last_succeeded_at: null, replies_last_succeeded_at: null, comments_last_succeeded_at: null,
    }] })).listChecks({ uid: '123', signal })).toMatchObject({ status: 'success', data: [{
      rootCommentsError: 'COMMENT_LOCATOR_UNCONFIRMED', repliesError: null, commentsError: 'COMMENT_LOCATOR_UNCONFIRMED',
      rootCommentsLastSucceededAt: null, repliesLastSucceededAt: null, commentsLastSucceededAt: null,
    }] });
  });
  it('新增分项时间严格校验，两类媒体错误只接受白名单数组且拒绝 null 和任意原文', async () => {
    for (const field of ['text_last_succeeded_at', 'media_last_succeeded_at', 'comment_media_last_succeeded_at']) {
      for (const value of ['2025-02-30T02:00:00Z', '2025-06-01T02:00:00', 'SECRET_TOKEN', 0, true, {}, []]) {
        const result = await createManagementApi(async () => Response.json({ checks: [{ ...check, [field]: value }] }))
          .listChecks({ uid: '123', signal });
        expect(result).toEqual({ status: 'error', message: '管理接口响应异常，请重试。' });
        expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
      }
    }
    for (const field of ['media_errors', 'comment_media_errors']) {
      for (const value of [null, 'MEDIA_UPLOAD_FAILED', 0, false, {}, ['SECRET_TOKEN'], ['SOURCE_UNAVAILABLE'],
        ['SYNC_INCOMPLETE'], ['ROOT_COMMENTS_FAILED'], ['REPLIES_FAILED'], ['COMMENT_LOCATOR_UNCONFIRMED'],
        ['MEDIA_DOWNLOAD_FAILED', 'SECRET_TOKEN'], [null], [true], [{}], [['MEDIA_UPLOAD_FAILED']],
        ['https://origin.invalid/?signature=SECRET_TOKEN'], ['__proto__'], ['constructor']]) {
        const result = await createManagementApi(async () => Response.json({ checks: [{ ...check, [field]: value }] }))
          .listChecks({ uid: '123', signal });
        expect(result).toEqual({ status: 'error', message: '管理接口响应异常，请重试。' });
        expect(JSON.stringify(result)).not.toMatch(/SECRET_TOKEN|origin\.invalid|signature/);
      }
    }
  });
  it('拒绝非法、重复状态与未知错误码；取消和 HTTP 错误不泄漏原文', async () => {
    for (const body of [null, { checks: [check, check] }, ...[
      { id: 123 }, { active: 'true' }, { revision: 1.5 }, { work: 'SECRET_TOKEN' },
      { check_status: 'SECRET_TOKEN' }, { observed: null }, { synced_version: 1 },
      { last_checked_at: '2025-02-30T02:00:00Z' }, { sync_error: 'SECRET_TOKEN' },
      { parts: { ...check.parts, media: 'SECRET_TOKEN' } },
    ].map(overrides => ({ checks: [{ ...check, ...overrides }] }))]) {
      const result = await createManagementApi(async () => Response.json(body)).listChecks({ uid: '123', signal });
      expect(result).toEqual({ status: 'error', message: '管理接口响应异常，请重试。' });
      expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
    }
    const controller = new AbortController();
    const api = createManagementApi(async () => {
      controller.abort();
      return Response.json({ checks: [check] });
    });
    expect(await api.listChecks({ uid: '123', signal: controller.signal })).toEqual({ status: 'cancelled' });
    expect(await createManagementApi(async () => Response.json({ error: { code: 'SOURCE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, { status: 502 }))
      .listChecks({ uid: '123', signal })).toEqual({ status: 'error', message: '管理接口响应异常，请重试。' });
  });
});
