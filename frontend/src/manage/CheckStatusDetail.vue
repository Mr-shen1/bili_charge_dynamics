<script setup lang="ts">
import { computed } from 'vue';
import { displayCount, displayTime } from '../dynamics/display';
import type { TargetCheck } from '../data/checkStatus';
import { commentProgress } from '../data/commentProgress';
import {
  attemptText, checkErrorText, checkStatusText, commentErrorText, commentProgressText,
  mediaErrorText, partText,
} from './checkStatusText';

/**
 * 单条目标的检查与归档细节：观察态、执行态、分项、计数与各自时间分开呈现，
 * 不把「检查无变化」「正文已保存」或 HTTP 成功合并成笼统的同步成功。
 */
const props = defineProps<{ check: TargetCheck }>();

const progress = computed(() => commentProgress(props.check));
// 版本不一致只说当前观察仍待同步确认，不推断内容一定已变化。
const versionMismatch = computed(() => props.check.observedVersion !== props.check.syncedVersion);
const partsComplete = computed(() => Object.values(props.check.parts).every(state => state === 'success'));
const partial = computed(() => Object.values(props.check.parts).some(state => state === 'success'));
const countMismatch = computed(() => props.check.sourceCommentCount !== props.check.syncedCommentCount);
const mediaErrors = computed(() => [...new Set(props.check.mediaErrors)]);
const commentMediaErrors = computed(() => [...new Set(props.check.commentMediaErrors)]);

const executionText = computed(() => {
  const check = props.check;
  if (check.checkStatus === 'unchecked') return '尚无检查工作';
  if (check.work === 'running') return '同步中';
  if (check.work === 'complete') return '对应观察已完成';
  if (partsComplete.value) return '分项已完成，整轮待确认';
  if (partial.value) return '部分完成';
  if (check.syncError) return '同步失败，待重试';
  return '待同步';
});
const commentCountText = computed(() => {
  if (props.check.commentCountStatus === 'observed') return '已观察';
  if (props.check.commentCountStatus === 'failed') return '失败；保留已有可信数。';
  return '未检查或未知';
});

/** 未知时间显示占位符，不由本地时间补造；首行两处用各自的业务缺省语。 */
function at(value: string | null, absent = '—'): string {
  return value ? displayTime(value) : absent;
}
const parts = computed(() => props.check.parts);
</script>

<template>
  <div class="manage-check-detail">
    <p class="manage-state">{{ check.active ? '已纳入检查' : '已停止或移出；已保存的动态与未完成工作保留。' }}</p>
    <p class="manage-state" :class="{ 'manage-state-error': check.checkStatus === 'failed' }">
      {{ checkStatusText[check.checkStatus] }}
    </p>
    <p class="manage-state">执行：{{ executionText }}</p>
    <p v-if="versionMismatch" class="manage-state">观察与正文成功版本不一致；当前观察仍待同步确认。</p>
    <p v-if="check.editStatus === 'unknown'" class="manage-state">编辑信号未知；不代表确认未编辑。</p>
    <p v-if="check.editStatus === 'error'" class="manage-state">编辑信号错误；保留已有可信值。</p>
    <p class="manage-state">来源评论总数：{{ displayCount(check.sourceCommentCount) }}</p>
    <p class="manage-state">本地根评论数：{{ displayCount(check.localCommentCount) }}</p>
    <p class="manage-state">本地回复数：{{ displayCount(check.localReplyCount) }}</p>
    <p class="manage-state">评论计数检查：{{ commentCountText }}</p>
    <p class="manage-state">评论整轮成功计数（来源总数）：{{ displayCount(check.syncedCommentCount) }}</p>
    <p class="manage-state">
      评论整轮最近尝试：{{ check.commentsLastAttempt === null ? '未知' : attemptText[check.commentsLastAttempt] }}
    </p>
    <p class="manage-state">评论同步：{{ commentProgressText[progress] }}</p>
    <p v-if="countMismatch" class="manage-state">
      来源计数与评论整轮成功计数不一致；当前观察仍待评论同步确认。
    </p>
    <p class="manage-state">
      正文{{ partText[parts.text] }}；动态图{{ partText[parts.media] }}；评论{{ partText[parts.comments] }}；回复{{ partText[parts.replies] }}；评论图{{ partText[parts.comment_media] }}。
    </p>
    <p class="manage-state">最近检查：{{ at(check.lastCheckedAt, '未检查') }}</p>
    <p class="manage-state">实际整轮成功：{{ at(check.lastSucceededAt, '尚未成功') }}</p>
    <p class="manage-state">正文最近成功：{{ at(check.textLastSucceededAt) }}</p>
    <p class="manage-state">动态图最近成功：{{ at(check.mediaLastSucceededAt) }}</p>
    <p class="manage-state">评论图最近成功：{{ at(check.commentMediaLastSucceededAt) }}</p>
    <p class="manage-state">根评论最近成功：{{ at(check.rootCommentsLastSucceededAt) }}</p>
    <p class="manage-state">回复最近成功：{{ at(check.repliesLastSucceededAt) }}</p>
    <p class="manage-state">评论整轮最近成功：{{ at(check.commentsLastSucceededAt) }}</p>
    <p class="manage-muted">历史分项成功时间不代表当前观察已完成；未知时间不补造。</p>
    <p class="manage-muted">媒体错误来自实际已尝试的保存；无错误记录不代表图片已完成。</p>
    <p v-for="error in mediaErrors" :key="error" class="manage-state-error" role="status">
      动态图：{{ mediaErrorText[error] }}
    </p>
    <p v-for="error in commentMediaErrors" :key="error" class="manage-state-error" role="status">
      评论图：{{ mediaErrorText[error] }}
    </p>
    <p v-if="check.rootCommentsError" class="manage-state-error" role="status">
      根评论：{{ commentErrorText[check.rootCommentsError] }}
    </p>
    <p v-if="check.repliesError" class="manage-state-error" role="status">
      回复：{{ commentErrorText[check.repliesError] }}
    </p>
    <p v-if="check.commentsError" class="manage-state-error" role="status">
      评论整轮：{{ commentErrorText[check.commentsError] }}
    </p>
    <p v-if="check.checkError" class="manage-state-error" role="status">
      检查：{{ checkErrorText[check.checkError] }}
    </p>
    <p v-if="check.syncError" class="manage-state-error" role="status">
      同步：{{ checkErrorText[check.syncError] }}
    </p>
  </div>
</template>

