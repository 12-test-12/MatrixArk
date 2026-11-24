import { useEffect, useId, useState } from 'react';
import { Cpu, Server, Sparkles } from 'lucide-react';
import { api, messageOf, post, useAction } from './api';
import { Feedback } from './ui';

export type ProviderItem = {
  id: string;
  label: string;
  defaultEndpoint: string;
  defaultModel: string;
  isLocal: boolean;
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
      { id: 'ollama', label: 'Ollama 本地服务', defaultEndpoint: 'http://127.0.0.1:11434/v1/chat/completions', defaultModel: 'qwen2.5:7b', isLocal: true, tip: '运行如 `ollama run qwen2.5:7b` 即可。若有跨域需求可配置环境变量 OLLAMA_ORIGINS="*"' },
      { id: 'lmstudio', label: 'LM Studio 本地服务', defaultEndpoint: 'http://127.0.0.1:1234/v1/chat/completions', defaultModel: 'local-model', isLocal: true, tip: '在 LM Studio 中启动 Local Server (默认端口 1234) 并加载任意模型即可' },
      { id: 'custom', label: '自定义 OpenAI 兼容接口 (vLLM / LocalAI / OneAPI)', defaultEndpoint: 'http://127.0.0.1:8000/v1/chat/completions', defaultModel: 'default', isLocal: true, tip: '支持任意自建的 OpenAI 兼容推理服务、私有网关或局域网模型' },
    ],
  },
  {
    category: '国内主流大模型',
    icon: Sparkles,
    items: [
      { id: 'deepseek', label: 'DeepSeek (深度求索)', defaultEndpoint: 'https://api.deepseek.com/chat/completions', defaultModel: 'deepseek-chat', isLocal: false, tip: '高性价比推理模型，支持 deepseek-chat 或 deepseek-reasoner' },
      { id: 'qwen', label: '阿里通义千问 (DashScope)', defaultEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', defaultModel: 'qwen-plus', isLocal: false, tip: '阿里云百炼兼容模式，支持 qwen-plus、qwen-turbo、qwen-max' },
      { id: 'zhipu', label: '智谱清言 (GLM)', defaultEndpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', defaultModel: 'glm-4-flash', isLocal: false, tip: '支持 glm-4-flash、glm-4-plus、glm-4-air 等' },
      { id: 'moonshot', label: '月之暗面 (Kimi / Moonshot)', defaultEndpoint: 'https://api.moonshot.cn/v1/chat/completions', defaultModel: 'moonshot-v1-8k', isLocal: false, tip: '长文本长上下文分析，支持 moonshot-v1-8k/32k/128k' },
      { id: 'siliconflow', label: '硅基流动 (SiliconFlow)', defaultEndpoint: 'https://api.siliconflow.cn/v1/chat/completions', defaultModel: 'deepseek-ai/DeepSeek-V3', isLocal: false, tip: '极速托管云，提供各类开源模型加速服务' },
    ],
  },
  {
    category: '国际主流大模型',
    icon: Server,
    items: [
      { id: 'openai', label: 'OpenAI (GPT-4o)', defaultEndpoint: 'https://api.openai.com/v1/chat/completions', defaultModel: 'gpt-4o-mini', isLocal: false, tip: '官方 OpenAI 接口，支持 gpt-4o-mini、gpt-4o 等' },
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

const relevance = { high: '相关', partial: '部分相关', low: '不相关', insufficient: '依据不足' };

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
  angles: string[];
  nextCheck: string;
};
type Response = { ok: true; model: string; analysis: Analysis } | { ok: false; message: string };

export function useTopicAiAnalysis(path: string | null, goal: string, model: string | null) {
  const key = path && goal && model ? JSON.stringify([path, goal, model]) : null;
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
      } catch (error) {
        setRecords((current) => ({ ...current, [key]: { ok: false, message: messageOf(error) } }));
      } finally {
        setRunning(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [goal, key, path, response, running]);

  return { response, pending: Boolean(key && !response), retry: () => {
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
  const [provider, setProvider] = useState<string>(settings?.provider ?? 'ollama');
  const [customModel, setCustomModel] = useState<string>(settings?.model ?? '');
  const [customEndpoint, setCustomEndpoint] = useState<string>(settings?.endpoint ?? '');
  const [apiKey, setApiKey] = useState<string>('');

  const fallbackItem: ProviderItem = {
    id: 'ollama',
    label: 'Ollama 本地服务',
    defaultEndpoint: 'http://127.0.0.1:11434/v1/chat/completions',
    defaultModel: 'qwen2.5:7b',
    isLocal: true,
  };
  const currentItem = providerCategories
    .flatMap((group) => group.items)
    .find((item) => item.id === provider) ?? fallbackItem;

  const isLocal = Boolean(currentItem.isLocal);

  function handleProviderChange(nextId: string) {
    setProvider(nextId);
    const meta = providerCategories.flatMap((g) => g.items).find((i) => i.id === nextId);
    if (meta) {
      setCustomEndpoint(meta.defaultEndpoint);
      setCustomModel(meta.defaultModel);
    }
  }

  return <section className="card form-card">
    <div className="section-line">
      <h3>配置 AI 模型服务</h3>
      {settings?.model && <span className="version">{providers[settings.provider ?? ''] ?? settings.provider} · {settings.model}</span>}
    </div>
    <form className="form-stack" onSubmit={(event) => {
      event.preventDefault();
      void action.run(async () => {
        await api(path, {
          method: 'PATCH',
          body: {
            provider,
            apiKey: apiKey.trim(),
            endpoint: customEndpoint.trim() || undefined,
            model: customModel.trim() || undefined,
          },
        });
        refresh();
      }, 'AI 模型配置已保存。');
    }}>
      <div className="form-row">
        <label>模型服务平台
          <select name="aiProvider" aria-label="模型服务平台" value={provider} onChange={(e) => handleProviderChange(e.target.value)} disabled={action.busy}>
            {providerCategories.map((group) => <optgroup label={group.category} key={group.category}>
              {group.items.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
            </optgroup>)}
          </select>
        </label>
        <label>模型标识 (Model)
          <input
            type="text"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder={currentItem.defaultModel}
            disabled={action.busy}
          />
        </label>
      </div>

      <div className="form-row">
        <label>服务接口地址 (Endpoint URL)
          <input
            type="url"
            value={customEndpoint}
            onChange={(e) => setCustomEndpoint(e.target.value)}
            placeholder={currentItem.defaultEndpoint}
            disabled={action.busy}
          />
        </label>
        <label>{isLocal ? 'API Key (本地服务通常免填)' : 'API Key (必填)'}
          <input
            name="apiKey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            required={!isLocal}
            maxLength={1024}
            placeholder={isLocal ? '本地默认免填，若有鉴权请输入' : settings?.model ? '已配置，输入新密钥可更换' : '粘贴模型服务提供的 API Key'}
            autoComplete="new-password"
            disabled={action.busy}
          />
        </label>
      </div>

      {currentItem.tip && <p className="muted small">
        💡 {currentItem.tip}
      </p>}

      <Feedback error={action.error || error} notice={action.notice} />
      <div className="actions">
        <button type="submit" className="button primary" disabled={action.busy}>
          {action.busy ? '正在保存…' : '保存模型设置'}
        </button>
      </div>
    </form>
  </section>;
}

export function TopicAiGoal({ settings, goal, activeGoal, setGoal, start, pause }: {
  settings?: TopicAiStatus; goal: string; activeGoal: string; setGoal: (goal: string) => void; start: () => void; pause: () => void;
}) {
  const hint = useId();
  if (!settings?.provider) return <p className="muted small">配置 AI 模型（支持本地 Ollama / LM Studio 或云端大模型）后，可按创作需求逐条智能分析作品。</p>;
  const unchanged = Boolean(activeGoal && goal.trim() === activeGoal);
  return <form className="form-stack" onSubmit={(event) => { event.preventDefault(); if (goal.trim() && !unchanged) start(); }}>
    <label>本次创作需求<textarea name="goal" rows={2} required maxLength={600} value={goal}
      onChange={(event) => setGoal(event.target.value)} aria-describedby={hint} placeholder="例如 给小店老板做一期 AI 工具实测" /></label>
    <p className="muted small" id={hint}>
      开启后，页面会将你的创作需求和你点选的作品公开资料发送给 {providers[settings.provider] ?? settings.provider}（{settings.model}）。
      {settings.isLocal ? '（通过本地部署运行，数据不离机，完全保护隐私）' : ''}
    </p>
    <div className="actions">
      {(!activeGoal || !unchanged) && <button type="submit" className="button compact" disabled={!goal.trim()}>
        {activeGoal ? '更新分析需求' : '开启随选分析'}
      </button>}
      {activeGoal && <button type="button" className="button compact" onClick={pause}>暂停随选分析</button>}
      {unchanged && <span className="muted small" role="status">随选分析已开启</span>}
    </div>
  </form>;
}

export function TopicAiPanel({ activeGoal, response, pending, retry, note, addAngle }: ReturnType<typeof useTopicAiAnalysis> & {
  activeGoal: string; note: string; addAngle: (angle: string) => void;
}) {
  if (!activeGoal) return null;
  const result = response?.ok ? response : null;
  return <section className="field-group" aria-label="AI 分析">
    <h3>AI 分析</h3>
    {pending ? <p className="muted small" role="status">正在按本次创作需求分析这条作品…</p>
      : !response && <p className="muted small">点选列表中的作品即可分析。</p>}
    {response?.ok === false && <>
      <Feedback error={response.message} />
      <div className="actions"><button type="button" className="button compact" onClick={retry}>重试分析</button></div>
    </>}
    {result && <div className="topic-evidence field-group" aria-live="polite">
      <p className="muted small">{activeGoal} · {result.model}</p>
      <strong>{relevance[result.analysis.relevance]}</strong>
      <p>{result.analysis.judgment}</p>
      <ul>{result.analysis.evidence.map(({ field, quote }, index) => <li key={index}>
        {field === 'title' ? '来自标题' : '来自摘要'}
        <blockquote>{quote}</blockquote>
      </li>)}</ul>
      {result.analysis.angles.map((angle, index) => <div className="field-group" key={index}>
        <p>{angle}</p>
        <div className="actions"><button type="button" className="button compact" disabled={note.includes(angle)} onClick={() => addAngle(angle)}>
          {note.includes(angle) ? '已加入备注' : '加入选题备注'}
        </button></div>
      </div>)}
      <p>{result.analysis.nextCheck}</p>
    </div>}
  </section>;
}
