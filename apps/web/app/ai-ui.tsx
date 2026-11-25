'use client';

import type { ReactNode } from 'react';
import { Bot, Check, CheckCircle2, Copy, Lightbulb, Pause, Quote, RotateCw, ShieldCheck, Sparkles, ArrowUp } from 'lucide-react';

export type AiPromptOption = {
  id: string;
  label: string;
  prompt: string;
};

export function AiWelcome({ canConfigure, onConfigure }: {
  canConfigure: boolean;
  onConfigure: () => void;
}) {
  return (
    <div className="ai-welcome">
      <div className="ai-welcome-badge" aria-hidden="true">
        <Bot size={20} />
      </div>
      <div className="ai-welcome-copy">
        <strong>AI 选题助手尚未接入模型</strong>
        <p className="muted small">支持本地 Ollama / LM Studio（离线隐私）及 DeepSeek、通义千问、智谱 GLM 等云端模型，点选作品即可拆解看点与创作角度。</p>
      </div>
      {canConfigure && (
        <button type="button" className="button primary compact" onClick={onConfigure}>
          <Sparkles size={14} aria-hidden="true" />立即配置模型
        </button>
      )}
    </div>
  );
}

export function AiPrompts({ items, activeValue, onSelect, disabled }: {
  items: readonly AiPromptOption[];
  activeValue?: string;
  onSelect: (prompt: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ai-prompts" role="group" aria-label="快捷分析指令">
      <span className="ai-prompts-label">快捷意图</span>
      <div className="ai-prompts-list">
        {items.map((item) => {
          const selected = activeValue?.trim() === item.prompt.trim();
          return (
            <button
              key={item.id}
              type="button"
              disabled={disabled}
              className={`ai-prompt-chip${selected ? ' active' : ''}`}
              onClick={() => onSelect(item.prompt)}
            >
              <Sparkles size={12} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function AiSender({
  value,
  onChange,
  onSubmit,
  onPause,
  isActive,
  unchanged,
  modelLabel,
  isLocal,
  placeholder,
  describedBy,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onPause: () => void;
  isActive: boolean;
  unchanged: boolean;
  modelLabel: string;
  isLocal?: boolean;
  placeholder: string;
  describedBy?: string;
}) {
  const canSend = Boolean(value.trim()) && (!isActive || !unchanged);
  return (
    <form
      className={`ai-sender${isActive ? ' is-running' : ''}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSubmit();
      }}
    >
      <textarea
        name="goal"
        rows={2}
        required
        maxLength={600}
        value={value}
        aria-label="本次创作需求"
        aria-describedby={describedBy}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && canSend) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="ai-sender-footer">
        <div className="ai-sender-status">
          <span className="ai-model-pill">
            {isLocal ? <ShieldCheck size={13} aria-hidden="true" /> : <Bot size={13} aria-hidden="true" />}
            <span>{modelLabel}</span>
            {isLocal && <small>本地离线</small>}
          </span>
          {isActive && (
            <span className="ai-live-tag" role="status">
              <span className="ai-live-dot" aria-hidden="true" />随选监听中 · 点选作品自动分析
            </span>
          )}
        </div>
        <div className="actions">
          {isActive && (
            <button type="button" className="button compact" onClick={onPause}>
              <Pause size={13} aria-hidden="true" />暂停
            </button>
          )}
          <button
            type="submit"
            className="button primary compact"
            disabled={!canSend}
            title="Ctrl + Enter 快捷提交"
          >
            <ArrowUp size={14} aria-hidden="true" />
            {isActive ? '更新需求' : '开启分析'}
          </button>
        </div>
      </div>
    </form>
  );
}

export type ThoughtStep = {
  id: string;
  title: string;
  description?: string;
  quote?: string;
  kind: 'hook' | 'evidence' | 'check';
};

export function AiThoughtChain({ steps }: { steps: ThoughtStep[] }) {
  if (!steps.length) return null;
  return (
    <ol className="ai-thought-chain" aria-label="AI 证据推理链">
      {steps.map((step) => {
        const Icon = step.kind === 'hook' ? Lightbulb : step.kind === 'check' ? CheckCircle2 : Quote;
        return (
          <li key={step.id} className={`ai-thought-step kind-${step.kind}`}>
            <span className="ai-thought-node" aria-hidden="true"><Icon size={13} /></span>
            <div className="ai-thought-body">
              <strong className="ai-thought-title">{step.title}</strong>
              {step.quote && <blockquote className="ai-thought-quote">{step.quote}</blockquote>}
              {step.description && <p className="ai-thought-desc">{step.description}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function AiThinking({ goal }: { goal: string }) {
  return (
    <div className="ai-bubble is-thinking" role="status" aria-live="polite">
      <div className="ai-bubble-header">
        <span className="ai-bubble-avatar" aria-hidden="true"><Bot size={15} /></span>
        <span className="ai-bubble-meta">
          <strong>AI 选题助手正在思考</strong>
          <small>目标：{goal.slice(0, 48)}{goal.length > 48 ? '…' : ''}</small>
        </span>
      </div>
      <div className="ai-thinking-lines" aria-hidden="true">
        <span className="ai-skeleton-line w-85" />
        <span className="ai-skeleton-line w-65" />
        <span className="ai-skeleton-line w-45" />
      </div>
      <p className="muted small">正在提取标题与摘要证据链并匹配创作角度…</p>
    </div>
  );
}

export function AiBubble({
  model,
  timestamp,
  relevanceLabel,
  relevanceTone,
  goal,
  judgment,
  children,
  onCopyAll,
  copiedAll,
  onRetry,
  historySlot,
}: {
  model: string;
  timestamp: string;
  relevanceLabel: string;
  relevanceTone: 'green' | 'sky' | 'amber' | 'gray';
  goal: string;
  judgment: string;
  children?: ReactNode;
  onCopyAll: () => void;
  copiedAll: boolean;
  onRetry?: () => void;
  historySlot?: ReactNode;
}) {
  return (
    <article className="ai-bubble" aria-live="polite">
      <header className="ai-bubble-header">
        <span className="ai-bubble-avatar" aria-hidden="true"><Bot size={15} /></span>
        <div className="ai-bubble-meta">
          <strong>{model}</strong>
          <small>{timestamp}</small>
        </div>
        <span className={`badge ${relevanceTone}`}>
          <span className="badge-dot" aria-hidden="true" />{relevanceLabel}
        </span>
      </header>
      {historySlot}
      <div className="ai-bubble-prompt">
        <span className="ai-bubble-prompt-label">分析需求</span>
        <span>{goal}</span>
      </div>
      <div className="ai-bubble-answer">
        <p>{judgment}</p>
      </div>
      {children}
      <footer className="ai-bubble-actions">
        <button
          type="button"
          className={`button compact copy-action${copiedAll ? ' is-confirmed' : ''}`}
          onClick={onCopyAll}
        >
          {copiedAll ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copiedAll ? '已复制' : '复制分析'}
        </button>
        {onRetry && (
          <button type="button" className="button compact" onClick={onRetry}>
            <RotateCw size={13} aria-hidden="true" />重新分析
          </button>
        )}
      </footer>
    </article>
  );
}
