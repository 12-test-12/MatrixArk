import { Activity, AlertTriangle, CheckCircle2, Clock, RefreshCw, Server, ShieldAlert } from 'lucide-react';
import { formatTime, useResource, type WorkerMonitorSnapshot } from './api';
import { Empty, Feedback, Loading, PageHeader } from './ui';

const statusMeta: Record<WorkerMonitorSnapshot['status'], { label: string; tone: string }> = {
  healthy: { label: '运行健康', tone: 'green' },
  warning: { label: '存在预警', tone: 'amber' },
  degraded: { label: '异常告警', tone: 'red' },
};

const workerStateMeta = {
  running: { label: '运行中', tone: 'green' },
  draining: { label: '优雅退出中', tone: 'amber' },
  stopped: { label: '已停止', tone: 'gray' },
} as const;

const loopLabels: Record<string, string> = {
  dispatch: '任务派发',
  receipts: '回执回读',
  metrics: '成效同步',
  notifications: '飞书投递',
  topics: '选题采集',
  accountRisks: '账号体检',
  heartbeat: '心跳上报',
  monitor: '积压巡检',
};

function formatAge(seconds: number | null) {
  if (seconds === null) return '无等待任务';
  if (seconds < 60) return `最长已等 ${seconds} 秒`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `最长已等 ${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  return `最长已等 ${hours} 小时 ${mins % 60} 分`;
}

export function WorkerMonitor({ scope }: { scope: string }) {
  const monitor = useResource<WorkerMonitorSnapshot>(scope + '/worker-health', 15_000);
  const data = monitor.data;
  const meta = data ? statusMeta[data.status] : undefined;

  return <>
    <PageHeader
      title="后台运行监控"
      description="仅工作室负责人与运营可见。每 15 秒自动刷新 Worker 节点心跳、并发负载与本工作室队列积压。">
      <div className="actions">
        {data && <span className="muted small">更新于 {formatTime(data.checkedAt)}</span>}
        <button type="button" className="button compact" onClick={monitor.refresh} disabled={monitor.loading}>
          <RefreshCw size={14} className={monitor.loading ? 'is-spinning' : undefined} aria-hidden="true" />
          立即刷新
        </button>
      </div>
    </PageHeader>

    <Feedback error={monitor.error} />
    {monitor.loading && !data && <Loading />}

    {data && <div className="form-stack">
      <section className={`card monitor-banner status-${data.status}`} aria-label="系统整体健康度">
        <div className="card-heading">
          <div className="monitor-banner-title">
            {data.status === 'healthy'
              ? <CheckCircle2 size={20} aria-hidden="true" />
              : data.status === 'warning'
                ? <AlertTriangle size={20} aria-hidden="true" />
                : <ShieldAlert size={20} aria-hidden="true" />}
            <div>
              <h2>{meta?.label}</h2>
              <p className="muted small">
                当前在线 Worker {data.workers.activeCount} 个
                {data.workers.staleCount > 0 ? `，心跳超时 ${data.workers.staleCount} 个` : ''}
              </p>
            </div>
          </div>
          <span className={`badge ${meta?.tone}`}>{meta?.label}</span>
        </div>
        {data.warnings.length > 0 && (
          <ul className="monitor-warning-list">
            {data.warnings.map((warning, index) => (
              <li key={index}><AlertTriangle size={14} aria-hidden="true" /><span>{warning}</span></li>
            ))}
          </ul>
        )}
      </section>

      <section className="card form-stack" aria-label="本工作室队列积压">
        <div className="card-heading">
          <h2><Clock size={18} aria-hidden="true" />本工作室队列与任务积压</h2>
          <span className="muted small">{formatAge(data.backlog.oldestDueScheduledAgeSeconds)}</span>
        </div>
        <div className="monitor-kpi-grid">
          <div className={`monitor-kpi-card${data.backlog.dueScheduledTasks > 0 ? ' highlight-amber' : ''}`}>
            <small>到期未派发任务</small>
            <strong>{data.backlog.dueScheduledTasks}</strong>
            <span>{formatAge(data.backlog.oldestDueScheduledAgeSeconds)}</span>
          </div>
          <div className="monitor-kpi-card">
            <small>正在处理中（已领租约）</small>
            <strong>{data.backlog.dispatchingTasks}</strong>
            <span>跨账号有界并发执行中</span>
          </div>
          <div className={`monitor-kpi-card${data.backlog.expiredLeaseTasks > 0 ? ' highlight-red' : ''}`}>
            <small>过期未恢复租约</small>
            <strong>{data.backlog.expiredLeaseTasks}</strong>
            <span>{data.backlog.expiredLeaseTasks > 0 ? '需检查 Worker 是否存活' : '正常，无超时滞留'}</span>
          </div>
          <div className={`monitor-kpi-card${data.backlog.overdueHandoffTasks > 0 ? ' highlight-amber' : ''}`}>
            <small>超 4 小时未回填交接</small>
            <strong>{data.backlog.overdueHandoffTasks}</strong>
            <span>需运营及时回填发布结果</span>
          </div>
          <div className="monitor-kpi-card">
            <small>待投递飞书提醒</small>
            <strong>{data.backlog.dueNotifications}</strong>
            <span>交接与逾期消息队列</span>
          </div>
          <div className="monitor-kpi-card">
            <small>待采集选题来源</small>
            <strong>{data.backlog.dueTopicSources}</strong>
            <span>已到达采集窗口的来源数</span>
          </div>
        </div>
      </section>

      <section className="card form-stack" aria-label="Worker 节点列表">
        <div className="card-heading">
          <h2><Server size={18} aria-hidden="true" />Worker 运行节点与心跳</h2>
          <span className="count">{data.workers.items.length}</span>
        </div>
        {data.workers.items.length === 0 ? (
          <Empty
            icon={Activity}
            title="暂未检测到运行中的 Worker 心跳"
            description="请在服务端运行 pnpm dev:worker（或 node dist/worker.js）以启动后台发布、回执回读、体检与通知巡检进程。"
          />
        ) : (
          <div className="worker-nodes-list">
            {data.workers.items.map((node) => {
              const badge = node.stale
                ? { label: '心跳超时失联', tone: 'red' }
                : workerStateMeta[node.status] ?? { label: node.status, tone: 'gray' };
              const entries = Object.entries(node.loopStates ?? {});
              return (
                <article className={`worker-node-card${node.stale ? ' is-stale' : ''}`} key={node.workerId}>
                  <div className="card-heading">
                    <div>
                      <strong>Worker 节点</strong>
                      <p className="muted small"><code>{node.workerId}</code></p>
                    </div>
                    <div className="actions">
                      <span className="badge gray">并发 {node.activeTasks} / {node.maxConcurrency}</span>
                      <span className={`badge ${badge.tone}`}>{badge.label}</span>
                    </div>
                  </div>
                  <div className="worker-meta-row muted small">
                    <span>最近心跳：{formatTime(node.lastHeartbeatAt)}</span>
                    <span>租约到期：{formatTime(node.expiresAt)}</span>
                  </div>
                  {entries.length > 0 && (
                    <div className="worker-loops-grid">
                      {entries.map(([key, loop]) => (
                        <div className={`worker-loop-chip${loop.consecutiveFailures > 0 ? ' has-error' : ''}`} key={key}>
                          <div className="worker-loop-head">
                            <span>{loopLabels[key] ?? key}</span>
                            {loop.consecutiveFailures > 0 && <span className="badge red">失败 {loop.consecutiveFailures}</span>}
                          </div>
                          <small className="muted">
                            {loop.lastDurationMs !== null ? `${loop.lastDurationMs} ms` : '尚未完成'}
                            {loop.lastCompletedAt ? ` · ${formatTime(loop.lastCompletedAt)}` : ''}
                          </small>
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>}
  </>;
}
