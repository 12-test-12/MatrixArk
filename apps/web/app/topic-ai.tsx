import { useEffect, useId, useState } from 'react';
import { Check, Copy, Cpu, Plus, Server, Sparkles } from 'lucide-react';
import {
  AiBubble, AiPrompts, AiSender, AiThinking, AiThoughtChain, AiWelcome,
  type AiPromptOption, type ThoughtStep,
} from './ai-ui';
import { api, formatTime, messageOf, post, useAction, useResource } from './api';
import { copyText } from './clipboard';
import { pushToast } from './toast';
import { Feedback } from './ui';

export type ProviderItem = {
  id: string;
  label: string;
  shortLabel: string;
  defaultEndpoint: string;
  defaultModel: string;
  isLocal: boolean;
  badge: string;
  tip?: string;
};

export type ProviderCategory = {
  category: string;
  icon: typeof Cpu;
  items: ProviderItem[];
};

export const providerCategories: ProviderCategory[] = [
  {
    category: '本地部署模型 (Local AI)',
    icon: Cpu,
    items: [
      { id: 'ollama', label: 'Ollama 本地服务', shortLabel: 'Ollama', defaultEndpoint: 'http://127.0.0.1:11434/v1/chat/completions', defaultModel: 'qwen2.5:7b', isLocal: true, badge: '本地免 Key', tip: '在 MatrixArk 后端所在电脑运行 ollama run qwen2.5:7b。' },
      { id: 'lmstudio', label: 'LM Studio 本地服务', shortLabel: 'LM Studio', defaultEndpoint: 'http://127.0.0.1:1234/v1/chat/completions', defaultModel: 'local-model', isLocal: true, badge: '桌面服务', tip: '在 LM Studio 中启动 Local Server (默认端口 1234) 并加载任意模型即可' },
      { id: 'custom', label: '自定义 OpenAI 兼容接口 (vLLM / LocalAI / OneAPI)', shortLabel: '自定义兼容', defaultEndpoint: 'http://127.0.0.1:8000/v1/chat/completions', defaultModel: 'default', isLocal: true, badge: '私有网关', tip: '默认连接 MatrixArk 后端所在电脑的 8000 端口。其他网关地址需由部署管理员启用。' },
    ],
  },
  {
    category: '国内主流大模型',
    icon: Sparkles,
    items: [
      { id: 'deepseek', label: 'DeepSeek (深度求索)', shortLabel: 'DeepSeek', defaultEndpoint: 'https://api.deepseek.com/chat/completions', defaultModel: 'deepseek-chat', isLocal: false, badge: '推理性价比', tip: '可填写 https://api.deepseek.com，或使用下方显示的默认接口。' },
      { id: 'qwen', label: '阿里通义千问 (DashScope)', shortLabel: '通义千问', defaultEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', defaultModel: 'qwen-plus', isLocal: false, badge: '中文理解', tip: '阿里云百炼兼容模式，支持 qwen-plus、qwen-turbo、qwen-max' },
      { id: 'zhipu', label: '智谱清言 (GLM)', shortLabel: '智谱 GLM', defaultEndpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', defaultModel: 'glm-4-flash', isLocal: false, badge: '高速响应', tip: '支持 glm-4-flash、glm-4-plus、glm-4-air 等' },
      { id: 'moonshot', label: '月之暗面 (Kimi / Moonshot)', shortLabel: 'Kimi', defaultEndpoint: 'https://api.moonshot.cn/v1/chat/completions', defaultModel: 'moonshot-v1-8k', isLocal: false, badge: '长文本', tip: '长文本长上下文分析，支持 moonshot-v1-8k/32k/128k' },
      { id: 'siliconflow', label: '硅基流动 (SiliconFlow)', shortLabel: '硅基流动', defaultEndpoint: 'https://api.siliconflow.cn/v1/chat/completions', defaultModel: 'deepseek-ai/DeepSeek-V3', isLocal: false, badge: '开源托管', tip: '极速托管云，提供各类开源模型加速服务' },
    ],
  },
  {
    category: '国际主流大模型',
    icon: Server,
    items: [
      { id: 'openai', label: 'OpenAI (GPT-4o)', shortLabel: 'OpenAI', defaultEndpoint: 'https://api.openai.com/v1/chat/completions', defaultModel: 'gpt-4o-mini', isLocal: false, badge: 'GPT-4o', tip: '官方 OpenAI 接口，支持 gpt-4o-mini、gpt-4o 等' },
    ],
  },
];

export const providers: Record<string, string> = {
  ollama: 'Ollama 本地服务',
  lmstudio: 'LM Studio 本地服务',
  custom: '自定义兼容接口',
  deepseek: 'DeepSeek',
  qwen: '通义千问',
  zhipu: '智谱 GLM',
  moonshot: '月之暗面 Kimi',
  siliconflow: '硅基流动',
  openai: 'OpenAI',
};

const relevance = { high: '高度相关', partial: '部分相关', low: '相关性低', insufficient: '依据不足' } as const;
const relevanceTones: Record<keyof typeof relevance, 'green' | 'sky' | 'gray' | 'amber'> = {
  high: 'green',
  partial: 'sky',
  low: 'gray',
  insufficient: 'amber',
};

const quickPrompts: readonly AiPromptOption[] = [
  { id: 'smb-ai', label: '小店老板 AI 实测角度', prompt: '面向小店老板或线下实体创业者，评估这条作品能拆出什么实测选题角度' },
  { id: 'hook', label: '拆解标题与开头钩子', prompt: '分析这条作品的标题吸睛点、前 3 秒叙事钩子以及可复用的表达模板' },
  { id: 'checklist', label: '提炼图文清单结构', prompt: '提取这条作品的内容骨架，判断如何改编为小红书或 B 站清单型干货图文' },
  { id: 'audience', label: '受众匹配与差异化', prompt: '判断这条内容与自媒体工具测评受众的匹配度，找出可以做出差异化的切入点' },
];

export type TopicAiStatus = {
  provider: keyof typeof providers | null;
  model: string | null;
  endpoint?: string | null;
  isLocal?: boolean;
};

type Analysis = {
  relevance: keyof typeof relevance;
  judgment: string;
  evidence: { field: 'title' | 'summary'; quote: string }[];
  hook?: { evidenceIndex: number; device: string; effect: string } | null;
  angles: string[];
  nextCheck: string;
};
type SavedAnalysis = { id: string; goal: string; model: string; createdAt: string; analysis: Analysis };
type Response = ({ ok: true } & SavedAnalysis) | { ok: false; message: string };

export function useTopicAiAnalysis(path: string | null, goal: string, model: string | null) {
  const key = path && goal && model ? JSON.stringify([path, goal, model]) : null;
  const { data: history, error: historyError, refresh } = useResource<SavedAnalysis[]>(path ? path + '/analyses' : null, 6000);
  const [records, setRecords] = useState<Record<string, Response>>({});
  const [running, setRunning] = useState(false);
  const response = key ? records[key] : undefined;

  useEffect(() => {
    if (!path || !key || response || running) return;
    const timer = window.setTimeout(async () => {
      setRunning(true);
      try {
        const result = await post<Response>(path + '/analyze', { goal });
        setRecords((current) => ({ ...current, [key]: result }));
        if (result.ok) refresh();
      } catch (error) {
        setRecords((current) => ({ ...current, [key]: { ok: false, message: messageOf(error) } }));
      } finally {
        setRunning(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [goal, key, path, response, running, refresh]);

  return { history, historyError, response, pending: Boolean(key && !response), retry: () => {
    if (!key) return;
    setRecords((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  } };
}

export function TopicAiSettings({ path, settings, refresh, error }: {
  path: string; settings?: TopicAiStatus; refresh: () => void; error?: string;
}) {
  const action = useAction();
  const connection = useAction();
  const [provider, setProvider] = useState<string>(settings?.provider ?? 'ollama');
  const [customModel, setCustomModel] = useState<string>(settings?.model ?? 'qwen2.5:7b');
  const [customEndpoint, setCustomEndpoint] = useState<string>(settings?.endpoint ?? 'http://127.0.0.1:11434/v1/chat/completions');
  const [apiKey, setApiKey] = useState<string>('');

  const allItems = providerCategories.flatMap((group) => group.items);
  const fallbackItem = allItems[0]!;
  const currentItem = allItems.find((item) => item.id === provider) ?? fallbackItem;
  const [scopeTab, setScopeTab] = useState<'local' | 'cloud'>(currentItem.isLocal ? 'local' : 'cloud');

  const visibleItems = allItems.filter((item) => (scopeTab === 'local' ? item.isLocal : !item.isLocal));
  const isLocal = Boolean(currentItem.isLocal);
  const canReuseKey = !isLocal && settings?.provider === provider && Boolean(settings.model);
  const busy = action.busy || connection.busy;
  const draft = () => ({
    provider, apiKey: apiKey.trim(), endpoint: customEndpoint.trim() || undefined, model: customModel.trim() || undefined,
  });

  function handleProviderChange(nextId: string) {
    setProvider(nextId);
    const meta = allItems.find((i) => i.id === nextId);
    if (meta) {
      setScopeTab(meta.isLocal ? 'local' : 'cloud');
      setCustomEndpoint(meta.defaultEndpoint);
      setCustomModel(meta.defaultModel);
    }
  }

  return <section className="card form-card ai-settings-card">
    <div className="section-line">
      <h3>配置 AI 模型服务</h3>
      {settings?.model && <span className="version">{providers[settings.provider ?? ''] ?? settings.provider} · {settings.model}</span>}
    </div>
    <form className="form-stack" onChange={() => { action.reset(); connection.reset(); }} onSubmit={(event) => {
      event.preventDefault();
      connection.reset();
      void action.run(async () => {
        await api(path, { method: 'PATCH', body: draft() });
        setApiKey('');
        refresh();
      }, 'AI 模型配置已保存。');
    }}>
      <div className="ai-scope-tabs" role="tablist" aria-label="模型部署方式">
        <button
          type="button"
          role="tab"
          aria-selected={scopeTab === 'local'}
          className={`ai-scope-tab${scopeTab === 'local' ? ' active' : ''}`}
          disabled={busy}
          onClick={() => {
            setScopeTab('local');
            if (!isLocal) handleProviderChange('ollama');
          }}
        >
          <Cpu size={14} aria-hidden="true" />本地部署模型
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={scopeTab === 'cloud'}
          className={`ai-scope-tab${scopeTab === 'cloud' ? ' active' : ''}`}
          disabled={busy}
          onClick={() => {
            setScopeTab('cloud');
            if (isLocal) handleProviderChange('deepseek');
          }}
        >
          <Sparkles size={14} aria-hidden="true" />国内及国际云端大模型
        </button>
      </div>

      <div className="ai-provider-grid" role="radiogroup" aria-label="模型服务平台">
        {visibleItems.map((item) => {
          const selected = provider === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={selected}
              data-provider={item.id}
              disabled={busy}
              className={`ai-provider-card${selected ? ' selected' : ''}`}
              onClick={() => handleProviderChange(item.id)}
            >
              <div className="ai-provider-card-top">
                <strong>{item.shortLabel}</strong>
                <span className="ai-provider-badge">{item.badge}</span>
              </div>
              <small>{item.defaultModel}</small>
            </button>
          );
        })}
      </div>

      <div className="form-row">
        <label>当前平台与模型标识 (Model)
          <input
            type="text"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder={currentItem.defaultModel}
            disabled={busy}
          />
        </label>
        <label>{isLocal ? 'API Key (本地服务通常免填)' : canReuseKey ? 'API Key (留空沿用现有密钥)' : 'API Key (必填)'}
          <input
            name="apiKey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            required={!isLocal && !canReuseKey}
            maxLength={1024}
            placeholder={isLocal ? '本地默认免填，若有鉴权请输入' : canReuseKey ? '已配置，留空继续使用现有密钥' : '粘贴模型服务提供的 API Key'}
            autoComplete="new-password"
            disabled={busy}
          />
        </label>
      </div>

      <label>服务接口地址 (Endpoint URL)
        <input
          type="url"
          value={customEndpoint}
          onChange={(e) => setCustomEndpoint(e.target.value)}
          placeholder={currentItem.defaultEndpoint}
          disabled={busy}
        />
      </label>

      {currentItem.tip && <p className="muted small">{currentItem.tip}</p>}
      <p className="muted small">测试会用当前表单发一条简短请求，检查接口、密钥和模型能否正常响应。更换接口时请填写该接口的密钥。</p>
      <Feedback error={connection.error || action.error || error} notice={connection.notice || action.notice} />
      <div className="actions">
        <button type="button" className="button" disabled={busy} onClick={(event) => {
          if (!event.currentTarget.form?.reportValidity()) return;
          action.reset();
          void connection.run(async () => {
            const result = await post<{ ok: true; model: string } | { ok: false; message: string }>(path + '/test', draft());
            if (!result.ok) throw new Error(result.message);
          }, '连接测试通过，模型可以正常响应。');
        }}>{connection.busy ? '正在测试…' : '测试连接'}</button>
        <button type="submit" className="button primary" disabled={busy}>
          {action.busy ? '正在保存…' : '保存模型设置'}
        </button>
      </div>
    </form>
  </section>;
}

export function TopicAiGoal({
  settings, goal, activeGoal, setGoal, start, pause, canConfigure = false, onConfigure,
}: {
  settings?: TopicAiStatus; goal: string; activeGoal: string; setGoal: (goal: string) => void;
  start: () => void; pause: () => void; canConfigure?: boolean; onConfigure?: () => void;
}) {
  const hint = useId();
  if (!settings?.provider) {
    return <AiWelcome canConfigure={canConfigure} onConfigure={() => onConfigure?.()} />;
  }
  const unchanged = Boolean(activeGoal && goal.trim() === activeGoal);
  const modelName = `${providers[settings.provider] ?? settings.provider} · ${settings.model ?? '默认模型'}`;
  const isLocal = settings.isLocal || settings.provider === 'ollama' || settings.provider === 'lmstudio' || settings.provider === 'custom';

  return (
    <div className="ai-copilot-bar">
      <AiPrompts
        items={quickPrompts}
        activeValue={goal}
        onSelect={(prompt) => setGoal(prompt)}
      />
      <AiSender
        value={goal}
        onChange={setGoal}
        onSubmit={() => {
          start();
          pushToast(activeGoal ? '已更新 AI 分析需求。' : 'AI 随选分析已开启，点选作品即可拆解。', 'info');
        }}
        onPause={() => {
          pause();
          pushToast('已暂停 AI 随选分析。', 'info');
        }}
        isActive={Boolean(activeGoal)}
        unchanged={unchanged}
        modelLabel={modelName}
        isLocal={isLocal}
        describedBy={hint}
        placeholder="输入你的创作目标或选题方向，例如：给小店老板做一期 AI 工具实测"
      />
      <p className="muted small" id={hint}>
        {isLocal
          ? `本地离线模式：分析请求仅发送至本机 ${modelName}，作品资料不外传。`
          : `开启后，页面会将你的创作需求和你点选的作品公开资料发送给 ${modelName}。`}
      </p>
    </div>
  );
}

export function TopicAiPanel({ activeGoal, history, historyError, response, pending, retry, note, addAngle }: ReturnType<typeof useTopicAiAnalysis> & {
  activeGoal: string; note: string; addAngle: (angle: string) => void;
}) {
  const [historyId, setHistoryId] = useState('');
  const [copiedAll, setCopiedAll] = useState(false);
  const generated = response?.ok ? response : undefined;
  // A freshly generated analysis replaces whichever older entry the history picker had pinned.
  useEffect(() => { if (generated) setHistoryId(''); }, [generated?.id]);
  const saved = history ?? [];
  const entries = generated && !saved.some(({ id }) => id === generated.id) ? [generated, ...saved] : saved;
  const latest = generated ?? entries[0];
  const result = entries.find(({ id }) => id === historyId) ?? latest;
  if (!activeGoal && !result && !historyError) return null;

  const thoughtSteps: ThoughtStep[] = result ? [
    ...(result.analysis.hook ? [{
      id: 'hook',
      kind: 'hook' as const,
      title: `看点识别 · ${result.analysis.hook.device}`,
      quote: result.analysis.evidence[result.analysis.hook.evidenceIndex]?.quote,
      description: result.analysis.hook.effect,
    }] : []),
    ...result.analysis.evidence.map((ev, index) => ({
      id: `ev-${index}`,
      kind: 'evidence' as const,
      title: ev.field === 'title' ? '原文依据 · 来自标题' : '原文依据 · 来自摘要',
      quote: ev.quote,
    })),
    ...(result.analysis.nextCheck ? [{
      id: 'check',
      kind: 'check' as const,
      title: '核查与下一步建议',
      description: result.analysis.nextCheck,
    }] : []),
  ] : [];

  async function handleCopyReport() {
    if (!result) return;
    const text = [
      `【分析目标】${result.goal}`,
      `【相关性结论】${relevance[result.analysis.relevance]}：${result.analysis.judgment}`,
      ...(result.analysis.angles.length ? ['【推荐切入角度】', ...result.analysis.angles.map((a, i) => `${i + 1}. ${a}`)] : []),
      ...(result.analysis.nextCheck ? [`【核查建议】${result.analysis.nextCheck}`] : []),
    ].join('\n');
    const ok = await copyText(text);
    if (ok) {
      setCopiedAll(true);
      pushToast('已复制完整 AI 分析报告。', 'success');
      window.setTimeout(() => setCopiedAll(false), 1800);
    }
  }

  return <section className="field-group ai-panel-section" aria-label="AI 分析">
    <h3>AI 分析</h3>
    <Feedback error={historyError} />
    {pending ? <AiThinking goal={activeGoal} />
      : activeGoal && !response && <p className="muted small">点选列表中的作品即可自动触发分析。</p>}
    {response?.ok === false && <>
      <Feedback error={response.message} />
      <div className="actions"><button type="button" className="button compact" onClick={retry}>重试分析</button></div>
    </>}
    {result && <AiBubble
      model={result.model}
      timestamp={formatTime(result.createdAt)}
      relevanceLabel={relevance[result.analysis.relevance]}
      relevanceTone={relevanceTones[result.analysis.relevance]}
      goal={result.goal}
      judgment={result.analysis.judgment}
      copiedAll={copiedAll}
      onCopyAll={() => void handleCopyReport()}
      onRetry={activeGoal ? retry : undefined}
      historySlot={entries.length > 1 ? <label className="ai-history-select">历史分析记录
        <select value={result.id} onChange={(event) => setHistoryId(event.target.value)}>
          {entries.map((entry) => <option key={entry.id} value={entry.id}>
            {formatTime(entry.createdAt)} · {entry.goal.slice(0, 60)}
          </option>)}
        </select>
      </label> : undefined}
    >
      <AiThoughtChain steps={thoughtSteps} />
      {result.analysis.angles.length > 0 && <div className="ai-angles-group">
        <span className="ai-angles-heading">可复用创作角度</span>
        <div className="ai-angles-list">
          {result.analysis.angles.map((angle, index) => {
            const added = note.includes(angle);
            return (
              <div className="ai-angle-item" key={index}>
                <p>{angle}</p>
                <div className="actions">
                  <button
                    type="button"
                    className={`button compact${added ? ' is-confirmed' : ''}`}
                    disabled={added}
                    onClick={() => addAngle(angle)}
                  >
                    {added ? <Check size={13} aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}
                    {added ? '已加入备注' : '加入选题备注'}
                  </button>
                  <button
                    type="button"
                    className="button compact"
                    onClick={async () => {
                      if (await copyText(angle)) pushToast('已复制创作角度。', 'success');
                    }}
                  >
                    <Copy size={13} aria-hidden="true" />复制
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>}
    </AiBubble>}
  </section>;
}
