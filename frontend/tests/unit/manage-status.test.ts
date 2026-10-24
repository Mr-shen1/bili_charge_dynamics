import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReader, deferred } from '../support/reader';
import { settle, showApp } from '../support/app';
import { createManagement, managementUp } from '../support/management';
import { targetCheck } from '../fixtures/comments';
import { discoveryState } from '../fixtures/discovery';
import type { TargetCheck } from '../../src/data/checkStatus';
import type { DiscoveryState } from '../../src/manage/discoveryState';
import type { ManagementResult } from '../../src/manage/managementApi';

afterEach(cleanup);

const reader = createReader();
const uid = '123';
const readyUp = () => ({ status: 'success' as const, data: [managementUp(uid)] });

async function openPanels(overrides: Parameters<typeof createManagement>[0]) {
  await showApp(reader, `/manage/ups/${uid}`, undefined, createManagement({
    listUps: async () => readyUp(),
    ...overrides,
  }));
  return within(await screen.findByRole('region', { name: '目标检查与归档状态' }));
}

async function discoveryPanel() {
  return within(await screen.findByRole('region', { name: '近期发现与当前窗口' }));
}

function checksResult(data: readonly TargetCheck[]): ManagementResult<readonly TargetCheck[]> {
  return { status: 'success', data };
}

function discoveryResult(data: DiscoveryState): ManagementResult<DiscoveryState> {
  return { status: 'success', data };
}

describe('单 UP 页的检查状态与归档进度', () => {
  it('读取后才呈现，且按观察、执行、分项与时间分别展示，不合并成笼统成功', async () => {
    const checks = [targetCheck({
      checkStatus: 'unchanged',
      work: 'pending',
      syncError: 'SYNC_INCOMPLETE',
      checkError: null,
      editStatus: 'unknown',
      observedVersion: 'v2',
      syncedVersion: 'v1',
      parts: { text: 'success', media: 'pending', comments: 'failed', replies: 'success', comment_media: 'pending' },
      mediaErrors: ['MEDIA_UPLOAD_FAILED'],
      rootCommentsError: 'ROOT_COMMENTS_FAILED',
      commentsError: 'ROOT_COMMENTS_FAILED',
      commentsLastAttempt: 'failed',
      sourceCommentCount: 3,
      syncedCommentCount: 0,
      // 无变化不等于整轮成功：整轮成功时间仍是空的。
      lastSucceededAt: null,
    })];
    const listChecks = vi.fn(async () => checksResult(checks));
    const card = await openPanels({ listChecks });

    // 不主动读取：状态只来自已保存记录，页面打开不触发检查或同步。
    expect(listChecks).not.toHaveBeenCalled();
    expect(card.getByText('尚未读取检查状态。')).toBeTruthy();
    expect(card.getByText('以上为该 UP 历史目标记录的最近时间，不代表全部目标均已成功。')).toBeTruthy();
    expect(card.getByText('最近检查：未检查')).toBeTruthy();
    expect(card.getByText('最近成功：尚未成功')).toBeTruthy();
    expect(card.getByText('仅读取已保存状态，不触发检查或同步；停用后的记录仍可读取。')).toBeTruthy();

    await fireEvent.click(card.getByRole('button', { name: '读取检查状态' }));
    await waitFor(() => expect(card.getByText('检查无变化；不代表同步完成。')).toBeTruthy());
    expect(listChecks).toHaveBeenCalledTimes(1);

    // 观察态、执行态与分项各自独立：无变化不等于同步成功。
    expect(card.getByText('已纳入检查')).toBeTruthy();
    expect(card.getByText('检查无变化；不代表同步完成。')).toBeTruthy();
    expect(card.getByText('执行：部分完成')).toBeTruthy();
    expect(card.getByText('观察与正文成功版本不一致；当前观察仍待同步确认。')).toBeTruthy();
    expect(card.getByText('编辑信号未知；不代表确认未编辑。')).toBeTruthy();
    expect(card.getByText('正文已保存；动态图待处理；评论失败；回复已保存；评论图待处理。')).toBeTruthy();
    expect(card.getByText('来源评论总数：3')).toBeTruthy();
    expect(card.getByText('评论整轮成功计数（来源总数）：0')).toBeTruthy();
    expect(card.getByText('来源计数与评论整轮成功计数不一致；当前观察仍待评论同步确认。')).toBeTruthy();
    expect(card.getByText('评论同步：部分完成')).toBeTruthy();
    // 分项错误各归其位，并给出固定文案而不是原始错误。
    expect(card.getByText('动态图：图片上传失败；保留已有归档，将在固定节拍重试。')).toBeTruthy();
    expect(card.getByText('根评论：根评论归档失败；保留已有归档，将在固定节拍重试。')).toBeTruthy();
    expect(card.getByText('评论整轮：根评论归档失败；保留已有归档，将在固定节拍重试。')).toBeTruthy();
    expect(card.getByText('同步：同步未全部完成，将在固定节拍重试。')).toBeTruthy();
    // 时间各自含义：面板头与行内都是刚读到的记录，整轮成功仍不冒充。
    expect(card.getAllByText('最近检查：2026-03-01 10:00:00')).toHaveLength(2);
    expect(card.getByText('实际整轮成功：尚未成功')).toBeTruthy();
    expect(card.getByText('正文最近成功：—')).toBeTruthy();
    expect(card.getByText('历史分项成功时间不代表当前观察已完成；未知时间不补造。')).toBeTruthy();
  });

  it('折叠细节默认收起，读取后可展开（键盘切换由 e2e 覆盖）', async () => {
    const card = await openPanels({ listChecks: async () => checksResult([targetCheck()]) });
    await fireEvent.click(card.getByRole('button', { name: '读取检查状态' }));
    const header = await waitFor(() => {
      const found = card.getByRole('button', { name: /动态 1001/ });
      expect(found.getAttribute('aria-expanded')).toBe('false');
      return found;
    });
    await fireEvent.click(header);
    await waitFor(() => expect(card.getByRole('button', { name: /动态 1001/ }).getAttribute('aria-expanded'))
      .toBe('true'));
  });

  it('读取后 UP 级时间改用刚读到的记录，不沿用配置读取时的旧值', async () => {
    const listChecks = vi.fn(async () => checksResult([targetCheck({
      lastCheckedAt: '2026-03-01T12:00:00+08:00',
      lastSucceededAt: '2026-03-01T12:00:00+08:00',
    })]));
    await showApp(reader, `/manage/ups/${uid}`, undefined, createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp(uid, { monitor: {
        mode: 'recent', recentN: 10, enabled: true,
        lastCheckedAt: '2026-03-01T09:00:00+08:00', lastSucceededAt: null,
      } })] }),
      listChecks,
    }));
    const card = within(await screen.findByRole('region', { name: '目标检查与归档状态' }));
    // 未读取前只能引用身份读取带回的配置值，并说明它不代表全部成功。
    expect(card.getByText('最近检查：2026-03-01 09:00:00')).toBeTruthy();
    expect(card.getByText('最近成功：尚未成功')).toBeTruthy();

    await fireEvent.click(card.getByRole('button', { name: '读取检查状态' }));
    await waitFor(() => expect(card.getByText('最近成功：2026-03-01 12:00:00')).toBeTruthy());
    expect(card.queryByText('最近检查：2026-03-01 09:00:00')).toBeNull();
    expect(card.getAllByText('最近检查：2026-03-01 12:00:00')).toHaveLength(2);
  });

  it('检查读取失败原位重试，空结果与未检查语义分开', async () => {
    const listChecks = vi.fn()
      .mockResolvedValueOnce({ status: 'error' as const, message: '身份或监控配置不存在，请重新读取。' })
      .mockResolvedValueOnce(checksResult([]));
    const card = await openPanels({ listChecks });
    await fireEvent.click(card.getByRole('button', { name: '读取检查状态' }));
    expect((await card.findByRole('alert')).textContent).toContain('身份或监控配置不存在，请重新读取。');
    expect(card.queryByText('尚无目标检查记录。')).toBeNull();

    await fireEvent.click(card.getByRole('button', { name: '重试读取检查状态' }));
    await waitFor(() => expect(card.getByText('尚无目标检查记录。')).toBeTruthy());
    expect(listChecks).toHaveBeenCalledTimes(2);
  });

  it('读取在途时重复点击被忽略，按钮文字反映读取中且不丢焦点', async () => {
    const pending = deferred<ManagementResult<readonly TargetCheck[]>>();
    const listChecks = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(checksResult([]));
    const card = await openPanels({ listChecks });
    const button = card.getByRole('button', { name: '读取检查状态' });
    await fireEvent.click(button);
    await fireEvent.click(button);
    expect(listChecks).toHaveBeenCalledTimes(1);
    const busy = card.getByRole('button', { name: '正在读取检查状态…' });
    // 不靠 disabled 挡住重复读取：键盘焦点留在按钮上，第二次点击被读取状态守卫忽略。
    expect((busy as HTMLButtonElement).disabled).toBe(false);
    expect(busy.getAttribute('aria-busy')).toBe('true');

    pending.resolve(checksResult([]));
    await waitFor(() => expect(card.getByText('尚无目标检查记录。')).toBeTruthy());
    expect(listChecks).toHaveBeenCalledTimes(1);
  });

  it('离开页面后迟到的成功或失败不改写新的访问', async () => {
    const pending = deferred<ManagementResult<readonly TargetCheck[]>>();
    const listChecks = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ status: 'error' as const, message: '管理服务暂不可用，请重试。' });
    const router = await showApp(reader, `/manage/ups/${uid}`, undefined, createManagement({
      listUps: async () => readyUp(),
      listChecks,
    }));
    const first = within(await screen.findByRole('region', { name: '目标检查与归档状态' }));
    await fireEvent.click(first.getByRole('button', { name: '读取检查状态' }));
    await settle();
    await router.push('/manage');
    await settle();
    await router.push(`/manage/ups/${uid}`);
    await settle();

    pending.resolve(checksResult([targetCheck()]));
    await settle();
    const current = within(await screen.findByRole('region', { name: '目标检查与归档状态' }));
    expect(current.getByText('尚未读取检查状态。')).toBeTruthy();
    expect(current.queryByText('检查无变化；不代表同步完成。')).toBeNull();
  });
});

describe('单 UP 页的近期发现与窗口状态', () => {
  it('已发布窗口与历史可信结果分开呈现，并说明发现不等于归档', async () => {
    const readDiscovery = vi.fn(async () => discoveryResult(discoveryState({ uid })));
    await openPanels({ readDiscovery });
    const panel = await discoveryPanel();
    expect(readDiscovery).not.toHaveBeenCalled();
    expect(panel.getByText('尚未读取发现状态。')).toBeTruthy();

    await fireEvent.click(panel.getByRole('button', { name: '读取发现状态' }));
    await waitFor(() => expect(panel.getByText('本轮发现成功；不代表归档成功。')).toBeTruthy());
    expect(panel.getByText('读取时已保存模式：近期 N 条；N：2；监控：已启用。')).toBeTruthy();
    expect(panel.getByText('发现窗口已就绪；内容归档请另读检查状态。')).toBeTruthy();
    expect(panel.getByText('本轮 N：2；开始：2026-03-01 10:00:00')).toBeTruthy();
    expect(panel.getByText('本轮完成：2026-03-01 10:00:10')).toBeTruthy();
    expect(panel.getByRole('list', { name: '本轮累计候选' }).textContent).toContain('1001');
    expect(panel.getByText('可信结果 N：2；发现时间：2026-03-01 10:00:10')).toBeTruthy();
    expect(panel.getByText('该轮达到 N 后停止扫描；不保证历史已耗尽。')).toBeTruthy();
    expect(panel.getByRole('list', { name: '最近可信发现目标' }).textContent).toContain('1002');
    expect(panel.getByRole('list', { name: '当前启用近期目标' }).textContent).toContain('1002');
    expect(panel.getByText('与历史可信发现结果分开；入选不代表归档完成。')).toBeTruthy();
  });

  it('发现失败保留旧窗口并标记可重试，不冒充本轮成功', async () => {
    await openPanels({
      readDiscovery: async () => discoveryResult(discoveryState({
        uid, status: 'failed', retryable: true, incomplete: true,
        attempt: {
          recentN: 2, startedAt: '2026-03-01T10:05:00+08:00', finishedAt: '2026-03-01T10:05:02+08:00',
          ids: [], error: 'SOURCE_UNAVAILABLE',
        },
      })),
    });
    const panel = await discoveryPanel();
    await fireEvent.click(panel.getByRole('button', { name: '读取发现状态' }));
    await waitFor(() => expect(panel.getByText('本轮发现未完整完成。')).toBeTruthy());
    expect(panel.getByText('发现未完成；保留已有可信结果与已发布窗口。')).toBeTruthy();
    expect(panel.getByText('可在下一固定节拍重试；页面重读不会启动发现。')).toBeTruthy();
    expect(panel.getByText('发现错误：来源暂不可用；保留已有可信结果。')).toBeTruthy();
    expect(panel.queryByText('本轮发现成功；不代表归档成功。')).toBeNull();
    expect(panel.queryByText('发现窗口已就绪；内容归档请另读检查状态。')).toBeNull();
    // 旧可信窗口仍展示，且不随失败清空。
    expect(panel.getByRole('list', { name: '当前启用近期目标' }).textContent).toContain('1002');
  });

  it('停用或非近期模式时说明历史结果仍可读取', async () => {
    for (const state of [
      discoveryState({ uid, mode: 'specified', recentN: 10, active: false, status: 'undiscovered',
        attempt: null, trustedResult: null, currentIds: [], retryable: false, incomplete: true }),
      discoveryState({ uid, enabled: false, active: false }),
    ]) {
      await openPanels({ readDiscovery: async () => discoveryResult(state) });
      const panel = await discoveryPanel();
      await fireEvent.click(panel.getByRole('button', { name: '读取发现状态' }));
      await waitFor(() => expect(panel.getByText('近期发现当前未启用；历史结果仍可读取。')).toBeTruthy());
      expect(panel.getByText(/读取时已保存模式：/)).toBeTruthy();
      cleanup();
    }
  });

  it('发现读取失败原位重试，未知时间不补造', async () => {
    const readDiscovery = vi.fn()
      .mockResolvedValueOnce({ status: 'error' as const, message: '管理访问需要身份验证，请刷新页面重新认证。' })
      .mockResolvedValueOnce(discoveryResult(discoveryState({ uid, trustedResult: null, currentIds: [],
        status: 'running', retryable: false, incomplete: true, attempt: {
          recentN: 2, startedAt: '2026-03-01T10:05:00+08:00', finishedAt: null, ids: ['1001'], error: null,
        } })));
    await openPanels({ readDiscovery });
    const panel = await discoveryPanel();
    await fireEvent.click(panel.getByRole('button', { name: '读取发现状态' }));
    expect((await panel.findByRole('alert')).textContent).toContain('管理访问需要身份验证，请刷新页面重新认证。');
    await fireEvent.click(panel.getByRole('button', { name: '重试读取发现状态' }));
    await waitFor(() => expect(panel.getByText('本轮发现进行中。')).toBeTruthy());
    expect(panel.getByText('本轮完成：未完成')).toBeTruthy();
    expect(readDiscovery).toHaveBeenCalledTimes(2);
  });
});

describe('状态读取与草稿、配置变化相互隔离', () => {
  it('读取状态不覆盖未提交的模式与近期 N 草稿', async () => {
    const card = await openPanels({
      listChecks: async () => checksResult([targetCheck({ checkStatus: 'unchanged' })]),
      readDiscovery: async () => discoveryResult(discoveryState({ uid })),
    });
    const upCard = within(await screen.findByRole('article', { name: `UP ${uid}` }));
    const recentN = upCard.getByRole('textbox', { name: '近期 N 条' }) as HTMLInputElement;
    await fireEvent.update(recentN, '25');
    await fireEvent.click(card.getByRole('button', { name: '读取检查状态' }));
    await fireEvent.click((await discoveryPanel()).getByRole('button', { name: '读取发现状态' }));
    await waitFor(() => expect(card.getByText('检查无变化；不代表同步完成。')).toBeTruthy());
    expect((upCard.getByRole('textbox', { name: '近期 N 条' }) as HTMLInputElement).value).toBe('25');
  });

  it('已保存配置改变后不沿用上一份检查与发现状态', async () => {
    const listChecks = vi.fn(async () => checksResult([targetCheck({ checkStatus: 'unchanged' })]));
    const readDiscovery = vi.fn(async () => discoveryResult(discoveryState({ uid })));
    const updateMonitor = vi.fn(async () => ({ status: 'success' as const, data: managementUp(uid, {
      monitor: { mode: 'specified', recentN: 10, enabled: true, lastCheckedAt: null, lastSucceededAt: null },
    }) }));
    const card = await openPanels({ listChecks, readDiscovery, updateMonitor });
    await fireEvent.click(card.getByRole('button', { name: '读取检查状态' }));
    await fireEvent.click((await discoveryPanel()).getByRole('button', { name: '读取发现状态' }));
    await waitFor(() => expect(card.getByText('检查无变化；不代表同步完成。')).toBeTruthy());

    const upCard = within(await screen.findByRole('article', { name: `UP ${uid}` }));
    await fireEvent.click(upCard.getByText('指定动态 ID', { exact: true }));
    await fireEvent.click(upCard.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(upCard.getByText('保存成功。')).toBeTruthy());

    // 模式已改变：面板随已保存配置重建，旧状态不再冒充当前配置，必须重新读取。
    const checksAfter = within(await screen.findByRole('region', { name: '目标检查与归档状态' }));
    await waitFor(() => expect(checksAfter.getByText('尚未读取检查状态。')).toBeTruthy());
    expect(checksAfter.queryByText('检查无变化；不代表同步完成。')).toBeNull();
    expect((await discoveryPanel()).getByText('尚未读取发现状态。')).toBeTruthy();
  });
});
