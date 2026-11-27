import { useEffect, useState, type ReactNode } from 'react';
import { Activity, AlertTriangle, ArrowRight, Bell, ChartNoAxesCombined, CheckCircle2, ChevronRight, Clock,
  History, Layers3, ListChecks, RefreshCw, Server, ShieldAlert, Timer, Workflow } from 'lucide-react';
import { api, formatTime, messageOf, platformLabel, taskLabel, type WorkerMonitorSnapshot } from './api';
import { Empty, Feedback, Loading, PageHeader, TaskBadge } from './ui';
import { elapsedSeconds, monitorAlerts, monitorDuration, monitorEventLabels, monitorEventLevel, monitorLoops } from './worker-monitor-data';

type Snapshot = WorkerMonitorSnapshot;
type Worker = Snapshot['workers']['items'][number];

const healthMeta = {
  healthy: { label: '系统健康', tone: 'green', icon: CheckCircle2, hint: '所有核心服务运行正常' },
  warning: { label: '存在预警', tone: 'amber', icon: AlertTriangle, hint: '部分检测项需要关注' },
  degraded: { label: '异常告警', tone: 'red', icon: ShieldAlert, hint: '存在核心服务异常' },
} as const;

function useMonitor(scope: string) {
  const [record, setRecord] = useState<{ data: Snapshot; receivedAt: number }>();
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    async function load() {
      if (running) return;
      running = true;
      setRefreshing(true);
      try {
        const data = await api<Snapshot>(scope + '/worker-health', { signal: controller.signal });
        if (!controller.signal.aborted) {
          setRecord({ data, receivedAt: Date.now() });
          setError('');
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(messageOf(failure));
      } finally {
        running = false;
        if (!controller.signal.aborted) setRefreshing(false);
      }
    }
    void load();
    const timer = setInterval(load, 15_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [scope, revision]);
  return { record, error, refreshing, refresh: () => setRevision(value => value + 1) };
}

function MonitorPanel({ title, icon: Icon, children, action, className = '' }: {
  title: string; icon: typeof Activity; children: ReactNode; action?: ReactNode; className?: string;
}) {
  return <section className={`card monitor-panel ${className}`} aria-label={title}>
    <div className="monitor-panel-heading"><h2><Icon size={17} aria-hidden="true" />{title}</h2>{action}</div>
    {children}
  </section>;
}

function Metric({ label, value, description, icon: Icon, tone = 'neutral' }: {
  label: string; value: number | null; description: string; icon: typeof Activity; tone?: string;
}) {
  return <div className={`monitor-metric monitor-tone-${tone}`}>
    <span className="monitor-metric-label"><Icon size={15} aria-hidden="true" />{label}</span>
    <strong>{value ?? '—'}</strong><small>{description}</small>
  </div>;
}

function WorkerCard({ node, now }: { node: Worker; now: number }) {
  const failures = Math.max(0, ...Object.values(node.loopStates ?? {}).map(loop => loop.consecutiveFailures));
  const tone = node.stale ? 'red' : node.status === 'running' ? 'green' : node.status === 'draining' ? 'amber' : 'neutral';
  const state = node.stale ? '心跳超时' : node.status === 'running' ? '运行中' : node.status === 'draining' ? '退出中' : '已停止';
  const remaining = (Date.parse(node.expiresAt) - now) / 1000;
  return <article className={`monitor-node monitor-node-${tone}`} id={`monitor-${node.workerId}`}>
    <div className="monitor-node-heading"><h3><span className={`monitor-dot monitor-tone-${tone}`} />{node.workerId}</h3>
      <span className={`badge ${tone === 'neutral' ? 'gray' : tone}`}>{state}</span></div>
    <dl className="monitor-node-times">
      <div><dt>最近心跳</dt><dd>{formatTime(node.lastHeartbeatAt)}<small>{monitorDuration(elapsedSeconds(node.lastHeartbeatAt, now))}前</small></dd></div>
      <div><dt>租约到期</dt><dd>{formatTime(node.expiresAt)}<small>{node.status === 'stopped' ? '节点已停止' : remaining > 0 ? `剩余 ${monitorDuration(remaining)}` : '已过期'}</small></dd></div>
    </dl>
    <div className="monitor-concurrency"><div><span>当前并发</span><strong>{node.activeTasks} <span>/ {node.maxConcurrency}</span></strong></div>
      <progress max={Math.max(1, node.maxConcurrency)} value={Math.min(node.activeTasks, Math.max(1, node.maxConcurrency))}
        aria-label={`${node.workerId} 当前并发 ${node.activeTasks}，最大容量 ${node.maxConcurrency}`} />
    </div>
    <dl className="monitor-node-stats">
      <div><dt>已运行</dt><dd>{monitorDuration(elapsedSeconds(node.startedAt, node.status === 'stopped' ? Date.parse(node.lastHeartbeatAt) : now))}</dd></div>
      <div><dt>今日执行次数</dt><dd title="当前接口未记录每个 Worker 的日执行次数">—<small>暂无统计</small></dd></div>
      <div><dt>连续失败峰值</dt><dd className={failures ? 'monitor-tone-red' : ''}>{failures}<small>按模块取最大值</small></dd></div>
    </dl>
    <details className="monitor-node-detail"><summary>节点详情<ChevronRight size={14} aria-hidden="true" /></summary>
      <p>进程启动于 {node.startedAt ? formatTime(node.startedAt) : '暂无记录'}。节点与模块统计反映共享 Worker 进程，队列和任务记录限定为当前工作室。</p>
    </details>
  </article>;
}

function taskWaitingSince(task: Snapshot['recentTasks'][number]) {
  if (task.status === 'scheduled') return task.scheduledAt;
  if (task.status === 'handed_off') return task.handedOffAt;
  if (task.status === 'submitted' || task.status === 'under_review') return task.receiptRecordedAt;
  if (task.status === 'dispatching') return task.leaseExpiresAt;
  return task.updatedAt;
}

export function WorkerMonitor({ scope, openTask }: { scope: string; openTask: (id: string) => void }) {
  const monitor = useMonitor(scope);
  const [clock, setClock] = useState(Date.now());
  const [workerId, setWorkerId] = useState('');
  const [range, setRange] = useState('24 小时');
  const [logLevel, setLogLevel] = useState('all');
  const [allLogs, setAllLogs] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const data = monitor.record?.data;
  const recentTasks = data?.recentTasks ?? [];
  const now = data && monitor.record ? Date.parse(data.checkedAt) + Math.max(0, clock - monitor.record.receivedAt) : clock;
  const selected = data?.workers.items.find(node => node.workerId === workerId) ?? data?.workers.items[0];
  const alerts = data ? monitorAlerts(data) : [];
  const events = (data?.recentEvents ?? []).filter(event => logLevel === 'all' || monitorEventLevel(event) === logLevel);
  const shownEvents = allLogs ? events : events.slice(0, 7);
  const meta = data ? healthMeta[data.status] : healthMeta.healthy;
  const HealthIcon = meta.icon;

  return <div className="monitor-page">
    <PageHeader title="后台运行监控" description="查看节点负载与任务队列，定位异常并跟进处理。每 15 秒自动刷新。">
      <span className="monitor-updated">{data ? `${monitor.error ? '上次成功更新' : '最近更新'} ${formatTime(data.checkedAt)}` : '等待首次检测'}</span>
      <button type="button" className="button compact" onClick={monitor.refresh} disabled={monitor.refreshing}>
        <RefreshCw size={14} className={monitor.refreshing ? 'is-spinning' : undefined} aria-hidden="true" />
        {monitor.refreshing ? '刷新中…' : '立即刷新'}
      </button>
    </PageHeader>
    <Feedback error={monitor.error ? `${monitor.error}${data ? '。以下保留上次成功检测的数据，请刷新重试。' : ''}` : undefined} />
    {!data && monitor.refreshing && <Loading />}
    {!data && monitor.error && <div className="monitor-retry"><button className="button" type="button" onClick={monitor.refresh}>重新加载监控</button></div>}
    {data && <div className="monitor-dashboard" aria-busy={monitor.refreshing}>
      <section className="card monitor-overview" aria-label="系统运行总览">
        <div className={`monitor-health monitor-tone-${meta.tone}`}><HealthIcon size={32} strokeWidth={1.6} aria-hidden="true" />
          <div><h2>{meta.label}</h2><p>{monitor.error ? '显示上次检测状态' : meta.hint}</p></div></div>
        <Metric label="在线 Worker" value={data.workers.activeCount} description="共享进程在线节点" icon={Server} tone={data.workers.activeCount ? 'green' : 'neutral'} />
        <Metric label="待执行任务" value={data.backlog.dueScheduledTasks} description="已到期待派发" icon={ListChecks} />
        <Metric label="正在执行" value={data.backlog.dispatchingTasks} description="已领取执行租约" icon={Workflow} />
        <Metric label="异常任务" value={data.backlog.failedTasks == null || data.backlog.unknownTasks == null ? null : data.backlog.failedTasks + data.backlog.unknownTasks}
          description="当前失败 / 待核实" icon={ShieldAlert} tone={data.backlog.failedTasks || data.backlog.unknownTasks ? 'red' : 'neutral'} />
        <Metric label="过期租约" value={data.backlog.expiredLeaseTasks} description="等待恢复与核实" icon={Timer} tone={data.backlog.expiredLeaseTasks ? 'red' : 'neutral'} />
        <Metric label="超时交接" value={data.backlog.overdueHandoffTasks} description="超过 4 小时未回填" icon={AlertTriangle} tone={data.backlog.overdueHandoffTasks ? 'amber' : 'neutral'} />
      </section>

      <div className="monitor-top-grid">
        <MonitorPanel title="任务运行趋势" icon={ChartNoAxesCombined} action={<div className="monitor-range" role="group" aria-label="趋势时间范围">
          {['1 小时', '24 小时', '7 天'].map(value => <button key={value} type="button" aria-pressed={range === value} onClick={() => setRange(value)}>{value}</button>)}
        </div>}>
          <div className="monitor-trend-empty"><ChartNoAxesCombined size={32} strokeWidth={1.3} aria-hidden="true" />
            <h3>历史运行趋势尚未接入</h3><p>最近 {range}内暂无队列历史快照。当前接口提供实时状态，尚无法绘制积压、执行与失败任务的历史曲线。</p>
            <span>需要后端持续保存监控快照</span></div>
          <div className="monitor-scope-note"><Clock size={13} aria-hidden="true" />当前快照 {formatTime(data.checkedAt)}<span>队列统计限定为本工作室</span></div>
        </MonitorPanel>
        <MonitorPanel title="队列概览" icon={Layers3}>
          <dl className="monitor-queue">
            {[
              ['到期待派发', data.backlog.dueScheduledTasks, 'neutral'], ['正在处理', data.backlog.dispatchingTasks, 'neutral'],
              ['待核实结果', data.backlog.unknownTasks, data.backlog.unknownTasks ? 'amber' : 'neutral'],
              ['超时人工交接', data.backlog.overdueHandoffTasks, data.backlog.overdueHandoffTasks ? 'amber' : 'neutral'],
              [`积压超过 ${Math.floor((data.thresholds?.longBacklogSeconds ?? 600) / 60)} 分钟`, data.backlog.longBacklogTasks, data.backlog.longBacklogTasks ? 'amber' : 'neutral'],
            ].map(([label, value, tone]) => <div key={String(label)}><dt>{label}</dt><dd className={`monitor-tone-${tone}`}>{value ?? '—'}</dd></div>)}
          </dl>
          <div className="monitor-queue-foot"><span><Timer size={13} aria-hidden="true" />最长等待 <b>{data.backlog.oldestDueScheduledAgeSeconds == null ? '—' : monitorDuration(data.backlog.oldestDueScheduledAgeSeconds)}</b></span>
            <span><Bell size={13} aria-hidden="true" />待投递飞书 <b>{data.backlog.dueNotifications}</b></span>
            <span>待采集来源 <b>{data.backlog.dueTopicSources}</b></span></div>
        </MonitorPanel>
      </div>

      <div className="monitor-operations-grid">
        <MonitorPanel title="Worker 节点" icon={Server} action={<span className="count">{data.workers.items.length}</span>}>
          {data.workers.items.length ? <div className="monitor-nodes">{data.workers.items.map(node => <WorkerCard node={node} now={now} key={node.workerId} />)}</div>
            : <Empty icon={Server} title="暂无 Worker 心跳" description="后台进程尚未上报，或最近 24 小时内没有节点记录。" />}
        </MonitorPanel>

        <MonitorPanel title="执行模块状态" icon={Workflow} action={data.workers.items.length > 1 ?
          <select className="monitor-node-select" aria-label="选择模块状态所属 Worker" value={selected?.workerId ?? ''} onChange={event => setWorkerId(event.target.value)}>
            {data.workers.items.map(node => <option value={node.workerId} key={node.workerId}>{node.workerId}</option>)}
          </select> : <span className="monitor-panel-hint">最近一次执行</span>}>
          {selected ? <div className="monitor-table-scroll" role="region" aria-label="执行模块状态表" tabIndex={0}>
            <table className="monitor-table"><caption className="monitor-sr-only">{selected.workerId} 各模块最近一次执行结果</caption>
              <thead><tr><th scope="col">模块</th><th scope="col">最近完成</th><th scope="col">耗时</th><th scope="col">状态</th><th scope="col">连续失败</th></tr></thead>
              <tbody>{[...new Set([...Object.keys(monitorLoops), ...Object.keys(selected.loopStates ?? {})])].map(name => {
                const loop = selected.loopStates?.[name];
                const tone = loop?.consecutiveFailures ? 'red' : selected.stale ? 'amber' : loop?.lastCompletedAt ? 'green' : 'gray';
                const label = loop?.consecutiveFailures ? '失败' : selected.stale ? '心跳超时' : loop?.lastCompletedAt ? '正常' : '未执行';
                return <tr key={name}><th scope="row"><details className="monitor-module-detail"><summary>{monitorLoops[name] ?? name}<ChevronRight size={12} aria-hidden="true" /></summary>
                  <p>开始 {loop?.lastStartedAt ? formatTime(loop.lastStartedAt) : '暂无记录'}<br />完成 {loop?.lastCompletedAt ? formatTime(loop.lastCompletedAt) : '暂无记录'}</p>
                  <p>{loop?.consecutiveFailures ? '最近执行失败，错误原文请在服务端日志中核查。' : '当前仅保存最近一次结果，尚无模块历史记录。'}</p>
                </details></th><td>{loop?.lastCompletedAt ? new Date(loop.lastCompletedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</td>
                  <td>{loop?.lastDurationMs == null ? '—' : loop.lastDurationMs >= 1000 ? `${(loop.lastDurationMs / 1000).toFixed(2)} s` : `${loop.lastDurationMs} ms`}</td>
                  <td><span className={`badge ${tone}`}>{label}</span></td><td>{loop?.consecutiveFailures ?? '—'}</td></tr>;
              })}</tbody></table></div> : <p className="monitor-empty-note">收到节点心跳后，将显示各模块最近一次执行结果。</p>}
        </MonitorPanel>

        <div className="monitor-side-stack">
          <MonitorPanel title="运行告警" icon={AlertTriangle} action={<span className={`badge ${alerts.length ? 'amber' : 'green'}`}>{alerts.length}</span>}>
            {alerts.length ? <div className="monitor-alert-list">{alerts.map(alert => <details key={alert.id} className={`monitor-alert monitor-alert-${alert.level}`}>
              <summary><AlertTriangle size={16} aria-hidden="true" /><span><strong>{alert.title}</strong><small>{alert.level === 'error' ? '严重' : '警告'}</small></span><ChevronRight size={14} aria-hidden="true" /></summary>
              <div><p>{alert.description}</p><p className="muted small">检测于 {formatTime(alert.time)}</p>
                {alert.workerId && <a className="text-button" href={`#monitor-${alert.workerId}`}>定位 Worker 节点</a>}
                {alert.tasks.map(task => <button key={task.id} className="text-button" type="button" onClick={() => openTask(task.id)}>查看任务 {task.title}<ArrowRight size={12} aria-hidden="true" /></button>)}
                {!alert.workerId && !alert.tasks.length && <button type="button" className="text-button" onClick={() => openTask('')}>查看发布任务<ArrowRight size={12} aria-hidden="true" /></button>}
              </div>
            </details>)}</div> : <p className="monitor-healthy-note"><CheckCircle2 size={16} aria-hidden="true" />本次检测暂无运行告警</p>}
          </MonitorPanel>
          <MonitorPanel title="近期任务事件" icon={History} action={<button type="button" className="text-button" onClick={() => setAllLogs(value => !value)}>{allLogs ? '收起' : `展开全部 ${events.length} 条`}</button>}>
            <div className="monitor-log-filters" role="group" aria-label="任务事件级别筛选">{([['all', '全部'], ['normal', '正常'], ['warning', '警告'], ['error', '错误']] as const).map(([value, label]) =>
              <button key={value} type="button" aria-pressed={logLevel === value} onClick={() => setLogLevel(value)}>{label}</button>)}</div>
            <p className="monitor-data-note">来自本工作室近 24 小时任务审计，最多 20 条。</p>
            {shownEvents.length ? <ol className="monitor-logs">{shownEvents.map(event => <li key={event.id}>
              <span className={`monitor-dot monitor-tone-${monitorEventLevel(event) === 'error' ? 'red' : monitorEventLevel(event) === 'warning' ? 'amber' : 'green'}`} />
              <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</time>
              <button type="button" onClick={() => openTask(event.taskId)} title={`任务 ${event.taskId}`}><span>{monitorEventLabels[event.kind] ?? '任务记录'}{event.toStatus ? ` · ${taskLabel[event.toStatus]}` : ''}</span><small>{event.title}</small></button>
            </li>)}</ol> : <p className="monitor-empty-note">当前级别暂无任务事件。</p>}
          </MonitorPanel>
        </div>
      </div>

      <MonitorPanel title="最近异常任务" icon={ShieldAlert} action={<button type="button" className="text-button" onClick={() => openTask('')}>查看发布任务<ArrowRight size={13} aria-hidden="true" /></button>}>
        {recentTasks.length ? <div className="monitor-table-scroll" role="region" aria-label="最近异常任务表" tabIndex={0}>
          <table className="monitor-table monitor-tasks-table"><caption className="monitor-sr-only">当前需要关注的任务，按最近更新排序，最多 10 条</caption>
            <thead><tr><th scope="col">任务 / 标题</th><th scope="col">平台 / 账号</th><th scope="col">当前状态</th><th scope="col">最近阶段</th><th scope="col">等待时间</th><th scope="col">操作</th></tr></thead>
            <tbody>{recentTasks.map(task => <tr key={task.id}><td><button className="monitor-task-link" type="button" onClick={() => openTask(task.id)}>{task.title}</button>
              <code className="monitor-task-id">{task.id}</code></td><td><details className="monitor-account-detail"><summary>{platformLabel[task.account.platform]} · {task.account.displayName}</summary>
                <p>账号 ID {task.account.id}<br />负责人 {task.account.operator || '未填写'}</p></details></td>
              <td><TaskBadge status={task.status} />{task.needsVerification && <small className="monitor-verification">请先核实平台结果</small>}</td>
              <td>{task.latestEvent ? monitorEventLabels[task.latestEvent.kind] ?? '任务记录' : '暂无事件记录'}</td>
              <td>{monitorDuration(elapsedSeconds(taskWaitingSince(task), now))}<small className="monitor-wait-label">{task.status === 'dispatching' ? '租约过期后' : task.status === 'failed' || task.status === 'unknown' ? '状态更新后' : '等待处理'}</small></td>
              <td><button type="button" className="button compact" onClick={() => openTask(task.id)} aria-label={`查看任务 ${task.title} 的详情、事件与回执`}>详情<ArrowRight size={13} aria-hidden="true" /></button></td></tr>)}</tbody>
          </table></div> : <p className="monitor-healthy-note"><CheckCircle2 size={16} aria-hidden="true" />本工作室暂无需要关注的异常任务</p>}
        <p className="monitor-data-note">展示当前需关注任务，最多 10 条。网络超时或回执不明的任务保留待核实状态，处理前请查看详情中的事件和回执。</p>
      </MonitorPanel>
    </div>}
  </div>;
}
