import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { BarChart3, ChevronRight, HelpCircle, UsersRound } from 'lucide-react';
import { api, ApiError, canRecord, cleanAccountName, formatPlatformAccount, formatTime, platformLabel, post, publishPlatformLabel, useAction, useResource, type Account, type MatrixGroup, type Role, type Task } from './api';
import { pushToast } from './toast';
import { Empty, Feedback, Loading, PageHeader, PlatformIcon } from './ui';

const fields = [
  ['views', '阅读 / 播放'], ['likes', '点赞'], ['comments', '评论'], ['favorites', '收藏'], ['shares', '分享'],
] as const;
type MetricValues = Record<(typeof fields)[number][0], number | null>;
type Recorder = { id: string; name: string; email: string };
type Metrics = MetricValues & { source: 'manual' | 'platform'; recordedAt: string; recordedBy?: Recorder | null };
type MetricSnapshot = Metrics & { id: string };
type Work = Task & { result: NonNullable<Task['result']> & { metrics: Metrics | null } };
type Summary = MetricValues & { content: 'article' | 'video'; published: number; tracked: number };
type AccountSummary = MetricValues & {
  accountId: string;
  displayName: string;
  alias?: string | null;
  platform: 'bilibili' | 'xiaohongshu';
  operator: string | null;
  group?: { id: string; name: string; color: string } | null;
  published: number;
  tracked: number;
  lastRecordedAt: string | null;
  lastSource: 'manual' | 'platform' | null;
  lastRecordedBy: Recorder | null;
};
type WorkPage = { items: Work[]; summary: Summary[]; accountSummary?: AccountSummary[]; nextCursor: string | null };
type ContentFilter = '' | 'article' | 'video';
type HubView = 'works' | 'accounts';

const number = new Intl.NumberFormat('zh-CN');
const compactNumber = new Intl.NumberFormat('zh-CN', { notation: 'compact' });
const axisDayFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' });
const count = (value?: number | null) => value == null ? '—' : number.format(value);
const pointLabelValue = (value: number) => value < 10_000 ? number.format(value) : compactNumber.format(value);
const recorderLabel = (recorder?: Recorder | null) => recorder ? (recorder.name || recorder.email) : '系统自动';

function localDateValue(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function useAnimatedNumber(target: number | null | undefined, duration = 300) {
  const [display, setDisplay] = useState<number | null>(target ?? null);
  const previousRef = useRef<number | null>(target ?? null);

  useEffect(() => {
    const next = target ?? null;
    const prev = previousRef.current;
    previousRef.current = next;
    if (next === null || prev === null || prev === next) {
      setDisplay(next);
      return;
    }
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(next);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(prev + (next - prev) * eased));
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);

  return display;
}

function AnimatedCount({ value }: { value?: number | null }) {
  const animated = useAnimatedNumber(value);
  return <>{count(animated)}</>;
}

function InfoTip({ label, text }: { label: string; text: string }) {
  return (
    <span className="info-tip">
      <button type="button" className="info-tip-trigger" aria-label={label}>
        <HelpCircle size={14} aria-hidden="true" />
      </button>
      <span role="tooltip" className="info-tip-bubble">{text}</span>
    </span>
  );
}

function workOptionLabel(work: Work) {
  const title = work.variant.title.trim() || '未命名作品';
  const chars = Array.from(title);
  const shortTitle = chars.length > 18 ? `${chars.slice(0, 18).join('')}…` : title;
  const accountName = cleanAccountName(work.account.displayName);
  return {
    shortLabel: `《${shortTitle}》 · ${accountName}`,
    fullLabel: `《${title}》 · ${accountName}`,
  };
}

function formatAxisDay(timestamp: number) {
  return axisDayFormat.format(new Date(timestamp));
}

const seriesColors: Record<keyof MetricValues, { stroke: string; gradStart: string }> = {
  views: { stroke: '#8b5cf6', gradStart: 'rgba(139, 92, 246, 0.18)' },
  likes: { stroke: '#f43f5e', gradStart: 'rgba(244, 63, 94, 0.16)' },
  comments: { stroke: '#f59e0b', gradStart: 'rgba(245, 158, 11, 0.18)' },
  favorites: { stroke: '#10b981', gradStart: 'rgba(16, 185, 129, 0.16)' },
  shares: { stroke: '#0ea5e9', gradStart: 'rgba(14, 165, 233, 0.16)' },
};

function MetricTrend({ scope, work, days, metricLabels, activeFields, hoveredField, onToggleField, onHoverField, onResetFields }: {
  scope: string;
  work: Work;
  days: string;
  metricLabels: { key: keyof MetricValues; label: string }[];
  activeFields: Record<keyof MetricValues, boolean>;
  hoveredField: keyof MetricValues | null;
  onToggleField: (key: keyof MetricValues) => void;
  onHoverField: (key: keyof MetricValues | null) => void;
  onResetFields: () => void;
}) {
  const historyUrl = scope + '/tasks/' + encodeURIComponent(work.id) + '/metrics/history'
    + (days ? '?days=' + encodeURIComponent(days) : '');
  const history = useResource<MetricSnapshot[]>(historyUrl);
  const plotRef = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(960);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const gradPrefix = useId().replace(/:/g, '');

  useEffect(() => {
    const el = plotRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const next = Math.round(el.clientWidth);
      if (next >= 280) setPlotWidth(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [history.data]);

  const rawSamples = history.data ?? [];
  if (history.loading) return <Loading />;
  if (history.error) return <Feedback error={history.error} />;

  // Deduplicate samples per calendar day (keep latest entry of that day)
  const byDay = new Map<string, MetricSnapshot>();
  for (const sample of rawSamples) {
    const dayKey = localDateValue(new Date(sample.recordedAt));
    byDay.set(dayKey, sample);
  }

  const visibleFields = metricLabels.filter(({ key }) => activeFields[key]);
  const windowDays = Number(days);
  const hasAnyRecorded = [...byDay.values()].some((sample) =>
    metricLabels.some(({ key }) => sample[key] !== null),
  );

  if (!windowDays && !hasAnyRecorded) {
    return <p className="muted small">
      还没有成效记录。录入或同步后会在这里同时展示各指标变化。
    </p>;
  }

  const todayDate = new Date();
  const todayKey = localDateValue(todayDate);
  const todayMidnight = new Date(`${todayKey}T12:00:00`);
  const startDate = windowDays > 0 ? new Date(todayMidnight) : new Date(`${[...byDay.keys()].sort()[0]}T12:00:00`);
  if (windowDays > 0) startDate.setDate(startDate.getDate() - windowDays + 1);
  const endDate = todayMidnight;

  const dailySeries: {
    dayKey: string;
    timestamp: number;
    values: MetricValues;
    recorded: boolean;
    sample?: MetricSnapshot;
  }[] = [];
  for (const date = new Date(startDate); date <= endDate; date.setDate(date.getDate() + 1)) {
    const dayKey = localDateValue(date);
    const sample = byDay.get(dayKey);
    const recorded = Boolean(sample && metricLabels.some(({ key }) => sample[key] !== null));
    dailySeries.push({
      dayKey,
      timestamp: date.getTime(),
      values: {
        views: sample?.views ?? null,
        likes: sample?.likes ?? null,
        comments: sample?.comments ?? null,
        favorites: sample?.favorites ?? null,
        shares: sample?.shares ?? null,
      },
      recorded,
      sample,
    });
  }

  const width = plotWidth;
  const height = 184;
  const left = 46;
  const right = Math.max(left + 120, width - 24);
  const top = 20;
  const bottom = 144;

  const start = dailySeries[0]!.timestamp;
  const end = dailySeries.at(-1)!.timestamp;
  const allVisibleValues = dailySeries.flatMap((day) => visibleFields.map(({ key }) => day.values[key]));
  const maximum = Math.ceil(Math.max(1, ...allVisibleValues.filter((value) => value !== null)) / 4) * 4;

  const xCoords = dailySeries.map((item) =>
    end === start ? (left + right) / 2 : left + (item.timestamp - start) / (end - start) * (right - left),
  );
  const yFor = (val: number) => bottom - val / maximum * (bottom - top);

  const seriesData = visibleFields.map(({ key }) => {
    const palette = seriesColors[key];
    const pts = dailySeries.map((day, idx) => {
      const value = day.values[key];
      return { dayKey: day.dayKey, x: xCoords[idx]!, y: yFor(value ?? 0), recorded: value !== null };
    });
    const linePath = pts.length > 1 ? pts.map((point, idx) => {
      const previous = pts[idx - 1];
      if (!previous) return `M${point.x},${point.y}`;
      if (previous.y === point.y) return `L${point.x},${point.y}`;
      // Horizontal tangents smooth each join and keep the curve between its daily values.
      const step = (point.x - previous.x) / 3;
      return `C${previous.x + step},${previous.y} ${point.x - step},${point.y} ${point.x},${point.y}`;
    }).join(' ') : '';
    const areaPath = linePath ? `${linePath} L${pts.at(-1)!.x},${bottom} L${pts[0]!.x},${bottom} Z` : '';
    return { key, palette, pts, linePath, areaPath };
  });

  // Real calendar-time proportional X-axis ticks covering entire selected range
  const xTicks: { x: number; timestamp: number }[] = [];
  if (start === end) {
    xTicks.push({ x: (left + right) / 2, timestamp: start });
  } else if (dailySeries.length <= 7) {
    for (let i = 0; i < dailySeries.length; i++) {
      xTicks.push({ x: xCoords[i]!, timestamp: dailySeries[i]!.timestamp });
    }
  } else {
    for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
      xTicks.push({ x: left + ratio * (right - left), timestamp: Math.round(start + ratio * (end - start)) });
    }
  }

  const slotWidth = dailySeries.length > 1 ? Math.max(6, (right - left) / dailySeries.length) : 24;
  const recordedDaysCount = dailySeries.filter((d) => d.recorded).length;
  const latestMetrics = work.result.metrics;
  const allFiveEnabled = visibleFields.length === metricLabels.length;
  const activeHoverDay = hoveredIdx !== null ? dailySeries[hoveredIdx] : undefined;
  const activeHoverX = hoveredIdx !== null ? xCoords[hoveredIdx] : undefined;

  return <>
    <div className="perf-legend-bar">
      <div className="perf-legend-chips" role="group" aria-label="切换图表展示指标">
        {metricLabels.map(({ key, label }) => {
          const on = activeFields[key];
          const color = seriesColors[key].stroke;
          const latestVal = latestMetrics?.[key] ?? null;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={on}
              className={`perf-legend-chip${on ? ' active' : ''}${hoveredField === key ? ' highlighted' : ''}`}
              onClick={() => onToggleField(key)}
              onMouseEnter={() => onHoverField(key)}
              onMouseLeave={() => onHoverField(null)}
            >
              <span className="perf-legend-dot" style={{ backgroundColor: color }} aria-hidden="true" />
              <span>{label}</span>
              <strong className="tabular">{count(latestVal)}</strong>
            </button>
          );
        })}
        {!allFiveEnabled && (
          <button type="button" className="text-button small" onClick={onResetFields}>
            全部显示
          </button>
        )}
      </div>
      <span className="perf-range-meta tabular">
        {windowDays > 0 ? `近 ${windowDays} 天（${formatAxisDay(start)} – ${formatAxisDay(end)}）` : `${formatAxisDay(start)} – ${formatAxisDay(end)}`}
        {' · '}{recordedDaysCount} 天有录入
      </span>
    </div>

    <div
      className="performance-trend-plot"
      ref={plotRef}
      onMouseLeave={() => setHoveredIdx(null)}
    >
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${work.variant.title}的多指标成效趋势，共 ${dailySeries.length} 天`}>
        <defs>
          {seriesData.map(({ key, palette }) => (
            <linearGradient key={key} id={`area-${gradPrefix}-${key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={palette.gradStart} />
              <stop offset="100%" stopColor="rgba(0, 0, 0, 0)" />
            </linearGradient>
          ))}
        </defs>
        {[4, 3, 2, 1, 0].map((step) => {
          const y = bottom - step / 4 * (bottom - top);
          return <g key={step}>
            <line className={step === 0 ? 'trend-axis-base' : 'trend-gridline'} x1={left} x2={right} y1={y} y2={y} />
            <text className="trend-axis-label" x={left - 8} y={y + 4} textAnchor="end">
              {compactNumber.format(step / 4 * maximum)}
            </text>
          </g>;
        })}
        {xTicks.map((tick) => {
          const anchor = tick.x <= left + 22 ? 'start' : tick.x >= right - 22 ? 'end' : 'middle';
          return <g key={`${tick.x}-${tick.timestamp}`}>
            <line className="trend-tick" x1={tick.x} x2={tick.x} y1={bottom} y2={bottom + 5} />
            <text className="trend-x-label" x={tick.x} y={bottom + 20} textAnchor={anchor}>
              {formatAxisDay(tick.timestamp)}
            </text>
          </g>;
        })}

        {/* Area fills under each series */}
        {seriesData.map(({ key, areaPath }) => {
          if (!areaPath) return null;
          const dimmed = hoveredField !== null && hoveredField !== key;
          return (
            <path
              key={`area-${key}`}
              d={areaPath}
              fill={`url(#area-${gradPrefix}-${key})`}
              style={{ opacity: dimmed ? 0.12 : 1, transition: 'opacity 160ms ease' }}
            />
          );
        })}

        {/* Colored lines */}
        {seriesData.map(({ key, palette, linePath }) => {
          if (!linePath) return null;
          const dimmed = hoveredField !== null && hoveredField !== key;
          const emphasized = hoveredField === key;
          return (
            <path
              key={`line-${key}`}
              d={linePath}
              className="trend-line"
              style={{
                stroke: palette.stroke,
                strokeWidth: emphasized ? 3 : 2.25,
                opacity: dimmed ? 0.18 : 1,
                transition: 'opacity 160ms ease, stroke-width 160ms ease',
              }}
            />
          );
        })}

        {/* Highlighted dots on days with actual recorded data */}
        {seriesData.map(({ key, palette, pts }) => {
          const dimmed = hoveredField !== null && hoveredField !== key;
          return pts.filter((pt) => pt.recorded).map((pt) => (
            <circle
              key={`dot-${key}-${pt.dayKey}`}
              className="trend-point"
              cx={pt.x}
              cy={pt.y}
              r={hoveredField === key ? 5 : 3.8}
              style={{ fill: palette.stroke, opacity: dimmed ? 0.2 : 1, transition: 'opacity 160ms ease' }}
            />
          ));
        })}

        {/* Hover crosshair & active dots across all visible series */}
        {activeHoverX !== undefined && activeHoverDay && (
          <g className="trend-crosshair-group">
            <line className="trend-crosshair" x1={activeHoverX} x2={activeHoverX} y1={top} y2={bottom} />
            {seriesData.map(({ key, palette, pts }) => {
              const pt = pts[hoveredIdx!];
              if (!pt?.recorded) return null;
              return (
                <circle
                  key={`hover-dot-${key}`}
                  className="trend-point"
                  cx={pt.x}
                  cy={pt.y}
                  r="4.5"
                  style={{ fill: palette.stroke }}
                />
              );
            })}
          </g>
        )}

        {/* Interactive day capture columns */}
        {dailySeries.map((day, idx) => (
          <rect
            key={`hit-${day.dayKey}`}
            className="trend-hit"
            x={xCoords[idx]! - slotWidth / 2}
            y={top}
            width={slotWidth}
            height={bottom - top}
            fill="transparent"
            onMouseEnter={() => setHoveredIdx(idx)}
          />
        ))}
      </svg>

      {activeHoverDay && activeHoverX !== undefined && (
        <div
          className="trend-hover-card"
          style={{
            left: activeHoverX > width * 0.62 ? undefined : `${Math.min(width - 210, activeHoverX + 12)}px`,
            right: activeHoverX > width * 0.62 ? `${Math.max(16, width - activeHoverX + 12)}px` : undefined,
          }}
        >
          <div className="trend-hover-head">
            <strong>{activeHoverDay.dayKey}</strong>
            <span className="muted small">
              {activeHoverDay.recorded && activeHoverDay.sample
                ? `${activeHoverDay.sample.source === 'platform' ? '平台同步' : '手动录入'} · ${recorderLabel(activeHoverDay.sample.recordedBy)}`
                : '当天无成效记录，按 0 绘制'}
            </span>
          </div>
          <ul className="trend-hover-list">
            {visibleFields.map(({ key, label }) => (
              <li key={key}>
                <span className="perf-legend-dot" style={{ backgroundColor: seriesColors[key].stroke }} aria-hidden="true" />
                <span>{label}</span>
                <strong className="tabular" title={activeHoverDay.values[key] === null ? '未采集，按 0 绘制' : undefined}>
                  {count(activeHoverDay.values[key] ?? 0)}
                </strong>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>

    {rawSamples.length > 0 && <details className="trend-data">
      <summary>查看采集明细（{rawSamples.length}）</summary>
      <div className="trend-history-wrap">
        <table className="trend-history-table">
          <thead>
            <tr>
              <th>统计日期 / 时间</th>
              <th>归属发布账号</th>
              <th>录入账号（操作人）</th>
              <th>采集方式</th>
              {metricLabels.map(({ key, label }) => (
                <th key={key} className="num">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...rawSamples].reverse().map((sample) => (
              <tr key={sample.id}>
                <td><time dateTime={sample.recordedAt}>{formatTime(sample.recordedAt)}</time></td>
                <td>{formatPlatformAccount(platformLabel[work.variant.platform], work.account.displayName)}</td>
                <td>{recorderLabel(sample.recordedBy)}</td>
                <td>{sample.source === 'platform' ? '平台同步' : '手动录入'}</td>
                {metricLabels.map(({ key }) => (
                  <td key={key} className="num">{sample[key] === null ? '—' : count(sample[key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>}
  </>;
}

const defaultActiveFields: Record<keyof MetricValues, boolean> = {
  views: true,
  likes: true,
  comments: true,
  favorites: true,
  shares: true,
};

function PerformanceTrend({ scope, works, days }: { scope: string; works: Work[]; days: string }) {
  const [taskId, setTaskId] = useState('');
  const [activeFields, setActiveFields] = useState<Record<keyof MetricValues, boolean>>(defaultActiveFields);
  const [hoveredField, setHoveredField] = useState<keyof MetricValues | null>(null);
  const work = works.find((item) => item.id === taskId) ?? works.find((item) => item.result.metrics) ?? works[0];
  if (!work) return null;
  const viewLabel = work.variant.videoAssetId ? '播放' : '阅读';
  const metricLabels = fields.map(([key, label]) => ({ key, label: key === 'views' ? viewLabel : label }));
  const activeOption = workOptionLabel(work);

  function toggleField(key: keyof MetricValues) {
    setActiveFields((current) => {
      const enabledCount = Object.values(current).filter(Boolean).length;
      if (current[key] && enabledCount <= 1) return current;
      return { ...current, [key]: !current[key] };
    });
  }

  return <section className="card form-card performance-trend" aria-labelledby="performance-trend-title">
    <div className="performance-trend-heading">
      <div className="performance-heading-inline">
        <h2 id="performance-trend-title">作品成效趋势</h2>
        <InfoTip
          label="趋势图统计口径说明"
          text="曲线按日展示，未采集的值按 0 绘制。圆点标记实际记录，悬停可查看当天采集情况。"
        />
      </div>
      <div className="performance-trend-controls single-work-select">
        <label>作品<select value={work.id} title={activeOption.fullLabel} onChange={(event) => setTaskId(event.target.value)}>
          {works.map((item) => {
            const option = workOptionLabel(item);
            return <option value={item.id} key={item.id} title={option.fullLabel}>{option.shortLabel}</option>;
          })}
        </select></label>
      </div>
    </div>
    <MetricTrend
      key={`${work.id}:${days}:${work.result.metrics?.recordedAt ?? ''}`}
      scope={scope}
      work={work}
      days={days}
      metricLabels={metricLabels}
      activeFields={activeFields}
      hoveredField={hoveredField}
      onToggleField={toggleField}
      onHoverField={setHoveredField}
      onResetFields={() => setActiveFields(defaultActiveFields)}
    />
  </section>;
}

function MetricNumbers({ values, video }: { values?: MetricValues | null; video: boolean }) {
  return <dl className="work-metric-numbers">{fields.map(([field, label]) => <div key={field}>
    <dt>{field === 'views' ? video ? '播放' : '阅读' : label}</dt>
    <dd title={values?.[field] == null ? '未采集' : undefined}><AnimatedCount value={values?.[field]} /></dd>
  </div>)}</dl>;
}

function MetricsForm({ work, scope, onSaved }: { work: Work; scope: string; onSaved: () => void }) {
  const action = useAction();
  const [error, setError] = useState('');
  const [anomalyWarning, setAnomalyWarning] = useState('');
  const path = scope + '/tasks/' + encodeURIComponent(work.id) + '/metrics';
  const metrics = work.result.metrics;
  const isVideo = Boolean(work.variant.videoAssetId);
  const canSync = work.executionChannel === 'official' && work.variant.platform === 'bilibili'
    && !isVideo && Boolean(work.result.remoteId);
  const sync = useAction();

  const today = localDateValue(new Date());
  const minDate = localDateValue(new Date(Date.now() - 365 * 86_400_000));

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = Object.fromEntries(fields.map(([field]) => {
      const input = String(form.get(field) ?? '').trim();
      return [field, input ? Number(input) : null];
    })) as MetricValues;
    if (Object.values(values).every((value) => value === null)) {
      setError('至少填写一项成效数据。');
      return;
    }
    const views = values.views;
    const engagementHigh = views !== null && (
      (values.likes ?? 0) > views || (values.comments ?? 0) > views
      || (values.favorites ?? 0) > views || (values.shares ?? 0) > views
    );
    if (engagementHigh && !anomalyWarning) {
      setError('');
      setAnomalyWarning(`检测到点赞、评论、收藏或分享高于${isVideo ? '播放' : '阅读'}量，常见于填串列或漏填；请核对后再次点击下方按钮确认保存。`);
      return;
    }
    const recordedDate = String(form.get('recordedDate') ?? '').trim();
    const body: Record<string, unknown> = { ...values };
    if (recordedDate && recordedDate !== today) {
      body.recordedAt = new Date(`${recordedDate}T12:00:00`).toISOString();
    }
    setError('');
    setAnomalyWarning('');
    sync.reset();
    void action.run(async () => {
      await api(path, { method: 'PATCH', body });
      onSaved();
    }, `已保存 ${recordedDate || today} 的手动成效，并记录当前录入账号。`);
  }

  return <details className="work-metrics-editor">
    <summary>记录 / 补录成效</summary>
    <div className="work-metrics-fields">
      <form className="form-stack" onSubmit={save} onChange={() => { setError(''); setAnomalyWarning(''); action.reset(); }}>
        <p className="muted small" id={'metrics-hint-' + work.id}>
          归属账号：{formatPlatformAccount(platformLabel[work.variant.platform], work.account.displayName)}。可选择具体统计日期进行补录（空白表示未采集，实际为零填 0），保存时自动记入当前登录账号。
        </p>
        <div className="work-metrics-meta-row">
          <label>统计日期
            <input name="recordedDate" type="date" defaultValue={today} max={today} min={minDate} disabled={action.busy || sync.busy} />
          </label>
        </div>
        <div className="work-metrics-inputs" key={metrics?.recordedAt} aria-describedby={'metrics-hint-' + work.id}>
          {fields.map(([field, label]) => <label key={field}>
            {field === 'views' ? isVideo ? '播放' : '阅读' : label}
            <input name={field} type="number" min="0" max="2147483647" step="1" inputMode="numeric"
              defaultValue={metrics?.[field] ?? ''} disabled={action.busy || sync.busy} />
          </label>)}
        </div>
        {anomalyWarning && <div role="alert" className="feedback">{anomalyWarning}</div>}
        <Feedback error={error || action.error || sync.error} notice={action.notice || sync.notice} />
        <div className="actions">
          <button className="button primary compact" disabled={action.busy || sync.busy}>
            {action.busy ? '保存中…' : anomalyWarning ? '确认异常数值并保存' : '保存手动录入'}
          </button>
          {canSync && <button type="button" className="button compact" disabled={action.busy || sync.busy}
            onClick={() => {
              setError('');
              action.reset();
              void sync.run(async () => {
                await post(path + '/sync', {}).catch((failure: unknown) => {
                  if (failure instanceof ApiError && failure.status === 502) {
                    throw new Error('B 站未返回成效数据，可以稍后重试或手动录入。');
                  }
                  throw failure;
                });
                onSaved();
              }, '已同步 B 站专栏成效。');
            }}>{sync.busy ? '同步中…' : '从 B 站同步'}</button>}
        </div>
      </form>
    </div>
  </details>;
}

function AccountMatrixTable({ rows, onInspectAccount }: {
  rows: AccountSummary[];
  onInspectAccount: (accountId: string) => void;
}) {
  if (!rows.length) {
    return <section className="card">
      <Empty icon={UsersRound} title="当前筛选下暂无账号成效" description="确认发布作品并录入数据后，这里会汇总对比每个发布账号的表现与操作归属。" />
    </section>;
  }
  return (
    <section className="card" aria-labelledby="perf-account-matrix-title">
      <div className="card-heading">
        <div className="performance-heading-inline">
          <h2 id="perf-account-matrix-title">全矩阵账号对比</h2>
          <InfoTip
            label="全矩阵账号对比口径说明"
            text="参考矩阵工作台视图，按发布账号汇总筛选范围内的累计曝光与互动，并标出最近一次手工录入或平台同步的操作人。"
          />
        </div>
        <span className="count">{rows.length} 个账号</span>
      </div>
      <div className="table-well">
        <table className="perf-account-table">
          <thead>
            <tr>
              <th>发布账号 / 负责人</th>
              <th>平台</th>
              <th className="num">已发布 / 已采集</th>
              <th className="num">累计阅读 / 播放</th>
              <th className="num">累计互动（赞 · 评 · 藏 · 享）</th>
              <th>最近更新（日期 · 录入账号）</th>
              <th className="num">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.accountId}>
                <td>
                  <div className="perf-account-cell">
                    <PlatformIcon platform={row.platform} />
                    <div>
                      <strong>{row.alias ? `${row.alias} · ${cleanAccountName(row.displayName)}` : cleanAccountName(row.displayName)}</strong>
                      <small className="muted">
                        {row.group && <span className="inline-group-tag"><span className={`group-dot color-${row.group.color}`} aria-hidden="true" />{row.group.name} · </span>}
                        {row.operator ? `运营：${row.operator}` : '未指派运营'}
                      </small>
                    </div>
                  </div>
                </td>
                <td><span className="badge gray">{platformLabel[row.platform]}</span></td>
                <td className="num tabular">{number.format(row.published)} / {number.format(row.tracked)}</td>
                <td className="num tabular"><strong>{count(row.views)}</strong></td>
                <td className="num tabular muted small">
                  赞 {count(row.likes)} · 评 {count(row.comments)} · 藏 {count(row.favorites)} · 享 {count(row.shares)}
                </td>
                <td>
                  {row.lastRecordedAt ? (
                    <div className="perf-recorder-cell">
                      <span>{row.lastSource === 'platform' ? '平台同步' : '手动录入'} · {recorderLabel(row.lastRecordedBy)}</span>
                      <small className="muted"><time dateTime={row.lastRecordedAt}>{formatTime(row.lastRecordedAt)}</time></small>
                    </div>
                  ) : (
                    <span className="muted small">待录入</span>
                  )}
                </td>
                <td className="num">
                  <button type="button" className="button compact" onClick={() => onInspectAccount(row.accountId)}>
                    单号明细<ChevronRight size={14} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Performance({ scope, role, initialAccount, openTask }: {
  scope: string; role: Role; initialAccount: string; openTask: (id: string) => void;
}) {
  const [platform, setPlatform] = useState('');
  const [groupId, setGroupId] = useState('');
  const [account, setAccount] = useState(initialAccount);
  const [days, setDays] = useState('');
  const [content, setContent] = useState<ContentFilter>('');
  const [hubView, setHubView] = useState<HubView>('works');
  const [pages, setPages] = useState<string[]>([]);
  const cursor = pages.at(-1);

  const baseParams = new URLSearchParams();
  if (platform) baseParams.set('platform', platform);
  if (groupId) baseParams.set('groupId', groupId);
  if (account) baseParams.set('accountId', account);
  if (days) baseParams.set('days', days);

  const listParams = new URLSearchParams(baseParams);
  listParams.set('limit', '20');
  if (content) listParams.set('content', content);
  if (cursor) listParams.set('cursor', cursor);

  const summaryParams = new URLSearchParams(baseParams);
  summaryParams.set('limit', '1');

  const result = useResource<WorkPage>(scope + '/tasks/performance?' + listParams);
  const allSummary = useResource<WorkPage>(content ? scope + '/tasks/performance?' + summaryParams : null);
  const accounts = useResource<Account[]>(scope + '/accounts');
  const archived = useResource<Account[]>(scope + '/accounts?archived=true');
  const groups = useResource<MatrixGroup[]>(scope + '/accounts/groups');
  const matches = [...(accounts.data ?? []), ...(archived.data ?? [])]
    .filter((item) => (!platform || item.platform === platform) && (!groupId || item.groupId === groupId));
  const accountReady = !account || matches.some((item) => item.id === account);

  const summaryCards = (content ? allSummary.data?.summary : result.data?.summary) ?? result.data?.summary ?? [];
  const accountSummaryRows = result.data?.accountSummary ?? [];
  const refreshAll = () => {
    result.refresh();
    if (content) allSummary.refresh();
  };

  return <>
    <PageHeader title="作品成效" description="查看已发布作品的阅读、播放和互动，按平台、账号或时间复盘。">
      <button type="button" className="button" onClick={() => { refreshAll(); pushToast('成效数据已刷新', 'info', 2200); }}>刷新数据</button>
    </PageHeader>
    <p className="perf-scope-note muted small">
      统计范围：仅纳入真实通道（人工交接 / 官方直发）且状态为「已发布」的作品；沙箱模拟及未完成任务不会计入下方统计与数量对比。
      官方直发按平台发表时间计入时间范围，人工交接作品没有平台发表时间，按回填时间计入。
    </p>
    <div className="performance-filters">
      <label>平台<select value={platform} onChange={(event) => {
        setPlatform(event.target.value); setAccount(''); setPages([]);
      }}>
        <option value="">全部平台</option><option value="xiaohongshu">小红书</option><option value="bilibili">B 站</option>
      </select></label>
      {(groups.data?.length ?? 0) > 0 && <label>矩阵组<select value={groupId} onChange={(event) => {
        setGroupId(event.target.value); setAccount(''); setPages([]);
      }}>
        <option value="">全部矩阵组</option>
        {(groups.data ?? []).map((g) => <option value={g.id} key={g.id}>{g.name}</option>)}
      </select></label>}
      <label>账号<select value={account} onChange={(event) => { setAccount(event.target.value); setPages([]); }}>
        <option value="">全部账号</option>
        {!accountReady && <option value={account}>当前账号</option>}
        {matches.map((item) => <option value={item.id} key={item.id}>
          {formatPlatformAccount(item.platform === 'bilibili' ? 'B 站' : '小红书', item.displayName)}
        </option>)}
      </select></label>
      <label>时间范围<select value={days} onChange={(event) => { setDays(event.target.value); setPages([]); }}>
        <option value="">全部时间</option>
        <option value="7">近 7 天</option>
        <option value="30">近 30 天</option>
        <option value="90">近 90 天</option>
      </select></label>
    </div>
    <Feedback error={accounts.error || archived.error || result.error || allSummary.error} />
    {result.loading && <Loading />}
    {result.data && <>
      <div className="performance-summary" role="tablist" aria-label="按内容类型切换">
        {summaryCards.map((item) => {
          const selected = content === item.content;
          return (
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              className={`card form-card performance-summary-card${selected ? ' active' : ''}`}
              key={item.content}
              onClick={() => {
                setContent(selected ? '' : item.content);
                setPages([]);
              }}
            >
              <div className="performance-summary-top">
                <h2>{item.content === 'video' ? '视频' : '图文'}</h2>
                <span className="muted small tabular">
                  <AnimatedCount value={item.published} /> 件已发布 · <AnimatedCount value={item.tracked} /> 件已采集
                </span>
              </div>
              {item.tracked === 0 ? (
                <div className="performance-summary-empty">
                  <BarChart3 size={18} aria-hidden="true" />
                  <span>暂无已采集数据，发布并回填后自动汇总</span>
                </div>
              ) : (
                <MetricNumbers values={item} video={item.content === 'video'} />
              )}
              <span className="performance-summary-indicator" aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <div className="perf-view-tabs" role="tablist" aria-label="成效查看视角">
        <button
          type="button"
          role="tab"
          aria-selected={hubView === 'works'}
          className={`perf-view-tab${hubView === 'works' ? ' active' : ''}`}
          onClick={() => setHubView('works')}
        >
          作品趋势与明细 <span className="count">{result.data.items.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={hubView === 'accounts'}
          className={`perf-view-tab${hubView === 'accounts' ? ' active' : ''}`}
          onClick={() => setHubView('accounts')}
        >
          全矩阵账号对比 <span className="count">{accountSummaryRows.length}</span>
        </button>
      </div>

      {hubView === 'accounts' ? (
        <AccountMatrixTable
          rows={accountSummaryRows}
          onInspectAccount={(accountId) => {
            setAccount(accountId);
            setPages([]);
            setHubView('works');
          }}
        />
      ) : <>
        <PerformanceTrend scope={scope} works={result.data.items} days={days} />
        <section className="card" aria-labelledby="performance-works">
          <div className="card-heading">
            <div className="performance-works-heading">
              <h2 id="performance-works">作品明细</h2>
              <InfoTip
                label="作品明细口径说明"
                text="汇总与列表均使用每件作品最新统计日期的累计值，右侧标注来源与具体录入账号；「—」表示尚未采集。"
              />
              {content && (
                <button type="button" className="text-button small" onClick={() => { setContent(''); setPages([]); }}>
                  恢复显示全部类型
                </button>
              )}
            </div>
          </div>
          {result.data.items.length ? <>
            <ul className="performance-works">{result.data.items.map((work) => {
              const metrics = work.result.metrics;
              const video = Boolean(work.variant.videoAssetId);
              return <li key={work.id} className="performance-work">
                <div className="performance-work-row">
                  <div className="performance-work-title">
                    <button type="button" className="text-button" onClick={() => openTask(work.id)}>{work.variant.title}</button>
                    <p className="muted small">{formatPlatformAccount(publishPlatformLabel(work.variant.platform, video), work.account.displayName)}</p>
                  </div>
                  <MetricNumbers values={metrics} video={video} />
                  <div className="performance-work-meta muted small">{metrics ? <>
                    <span>{metrics.source === 'platform' ? '平台同步' : '手动录入'} · {recorderLabel(metrics.recordedBy)}</span>
                    <time dateTime={metrics.recordedAt}>{formatTime(metrics.recordedAt)}</time>
                  </> : '待采集'}</div>
                </div>
                {canRecord(role) && <MetricsForm work={work} scope={scope} onSaved={refreshAll} />}
              </li>;
            })}</ul>
            {(cursor || result.data.nextCursor) && <div className="actions performance-pagination">
              <button type="button" className="button compact" disabled={!cursor} onClick={() => setPages(pages.slice(0, -1))}>上一页</button>
              <button type="button" className="button compact" disabled={!result.data.nextCursor}
                onClick={() => { if (result.data?.nextCursor) setPages([...pages, result.data.nextCursor]); }}>下一页</button>
            </div>}
          </> : <Empty icon={BarChart3} title="没有符合条件的已发布作品" description="确认发布后，作品会自动出现在这里。" />}
        </section>
      </>}
    </>}
  </>;
}
