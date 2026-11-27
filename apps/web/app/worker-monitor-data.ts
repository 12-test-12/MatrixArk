import type { WorkerMonitorSnapshot } from './api';

export const monitorLoops: Record<string, string> = {
  topics: '选题采集', metrics: '成效同步', monitor: '积压巡检', dispatch: '任务派发',
  receipts: '回执回读', heartbeat: '心跳上报', accountRisks: '账号体检', notifications: '飞书投递',
};

export const monitorEventLabels: Record<string, string> = {
  created: '创建排期', claimed: '领取任务', handed_off: '生成交接包', result: '记录发布回执',
  paused: '暂停任务', canceled: '取消任务', rescheduled: '调整排期', retried: '重新排期',
  verified: '人工核实', corrected: '更正结果', late_receipt: '记录迟到回执',
  reminder: '记录飞书投递结果', circuit_break: '验证熔断并转人工交接',
};

export function monitorDuration(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return '暂无数据';
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value} 秒`;
  if (value < 3600) return value % 60 ? `${Math.floor(value / 60)} 分 ${value % 60} 秒` : `${Math.floor(value / 60)} 分`;
  if (value < 86400) {
    const minutes = Math.floor(value % 3600 / 60);
    return minutes ? `${Math.floor(value / 3600)} 小时 ${minutes} 分` : `${Math.floor(value / 3600)} 小时`;
  }
  const hours = Math.floor(value % 86400 / 3600);
  return hours ? `${Math.floor(value / 86400)} 天 ${hours} 小时` : `${Math.floor(value / 86400)} 天`;
}

export function elapsedSeconds(time: string | null | undefined, now: number) {
  return time && Number.isFinite(Date.parse(time)) ? Math.max(0, (now - Date.parse(time)) / 1000) : null;
}

export function monitorEventLevel(event: WorkerMonitorSnapshot['recentEvents'][number]) {
  if (event.toStatus === 'failed') return 'error';
  if (event.toStatus === 'unknown' || ['paused', 'late_receipt', 'circuit_break'].includes(event.kind)) return 'warning';
  return 'normal';
}

export type MonitorAlert = {
  id: string; level: 'error' | 'warning'; title: string; description: string;
  time: string; workerId?: string; tasks: WorkerMonitorSnapshot['recentTasks'];
};

export function monitorAlerts(data: WorkerMonitorSnapshot): MonitorAlert[] {
  const alerts: MonitorAlert[] = [];
  for (const worker of data.workers.items) {
    if (worker.stale) alerts.push({ id: worker.workerId, level: 'error', title: 'Worker 心跳超时',
      description: `${worker.workerId} 已超过心跳租约有效期，请检查节点进程。`, time: worker.expiresAt,
      workerId: worker.workerId, tasks: [] });
    for (const [name, loop] of Object.entries(worker.loopStates ?? {})) {
      if (loop.consecutiveFailures > 0) alerts.push({ id: `${worker.workerId}-${name}`, level: 'error',
        title: `${monitorLoops[name] ?? name}连续执行失败`, description: `${worker.workerId} · 连续失败 ${loop.consecutiveFailures} 次。错误原文保留在服务端日志中。`,
        time: loop.lastCompletedAt ?? data.checkedAt, workerId: worker.workerId, tasks: [] });
    }
  }
  const tasks = data.recentTasks ?? [];
  const { backlog } = data;
  const aggregates = [
    { id: 'lease', count: backlog.expiredLeaseTasks, title: '任务租约已过期', level: 'error' as const,
      description: '任务执行结果需要恢复与核实，请先查看原任务记录。', match: (task: typeof tasks[number]) => task.status === 'dispatching' },
    { id: 'backlog', count: backlog.longBacklogTasks, title: '任务长时间积压', level: 'warning' as const,
      description: `计划时间已超过 ${monitorDuration(data.thresholds?.longBacklogSeconds)}，仍未被领取。`, match: (task: typeof tasks[number]) => task.status === 'scheduled' },
    { id: 'handoff', count: backlog.overdueHandoffTasks, title: '人工交接超过 4 小时未回填', level: 'warning' as const,
      description: '请运营人员确认实际发布情况并回填结果。', match: (task: typeof tasks[number]) => task.status === 'handed_off' },
    { id: 'receipt', count: backlog.overdueReceiptTasks, title: '平台回执长时间未变化', level: 'warning' as const,
      description: `最近一份平台回执已等待 ${monitorDuration(data.thresholds?.receiptWaitingSeconds)}。请核对平台审核进度。`, match: (task: typeof tasks[number]) => ['submitted', 'under_review'].includes(task.status) },
    { id: 'unknown', count: backlog.unknownTasks, title: '任务需要人工核实', level: 'warning' as const,
      description: '结果尚未确认，请先核对平台记录，再决定后续处理。', match: (task: typeof tasks[number]) => task.needsVerification },
    { id: 'failed', count: backlog.failedTasks, title: '任务执行失败', level: 'error' as const,
      description: '任务已终止，需要重新排期或人工接管；可在任务详情中查看失败阶段与回执。',
      match: (task: typeof tasks[number]) => task.status === 'failed' },
  ];
  for (const alert of aggregates) {
    if (alert.count > 0) alerts.push({ id: alert.id, level: alert.level, title: `${alert.count} 个${alert.title}`,
      description: alert.description, time: data.checkedAt, tasks: tasks.filter(alert.match) });
  }
  for (const [index, warning] of data.warnings.entries()) alerts.push({ id: `snapshot-${index}`, level: data.status === 'degraded' ? 'error' : 'warning',
    title: warning, description: '本次队列与节点健康检测结果。', time: data.checkedAt, tasks: [] });
  return alerts;
}
