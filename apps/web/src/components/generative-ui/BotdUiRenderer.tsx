import React, { createContext, useContext, useMemo, useState } from 'react';
import { createStateStore, type StateStore } from '@json-render/core';
import {
  defineRegistry,
  JSONUIProvider,
  Renderer,
  useBoundProp,
  useStateStore,
  type BaseComponentProps,
} from '@json-render/react';
import {
  AlertCircle,
  AlertTriangle,
  Activity,
  BarChart2,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  Code,
  Cpu,
  Database,
  FileText,
  GitBranch,
  Globe,
  HardDrive,
  HelpCircle,
  Info,
  Key,
  Layers,
  Lightbulb,
  Loader2,
  Lock,
  Package,
  RefreshCw,
  Server,
  Shield,
  Sparkles,
  Terminal,
  TrendingDown,
  TrendingUp,
  Workflow,
  Zap,
} from 'lucide-react';
import { validateUiSpec, type BotdUiSpec } from '@botd/protocol';
import { botdUiCatalog } from './catalog.js';

interface UiRenderContextValue {
  mode: 'display' | 'ask';
  disabled?: boolean;
  onSubmit?: (payloadJson: string) => void;
  getStoreSnapshot?: () => Record<string, unknown>;
}

const UiRenderContext = createContext<UiRenderContextValue>({
  mode: 'display',
});

const useUiRenderContext = () => useContext(UiRenderContext);

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  lightbulb: Lightbulb,
  idea: Lightbulb,
  tip: Lightbulb,
  info: Info,
  'alert-triangle': AlertTriangle,
  warning: AlertTriangle,
  warn: AlertTriangle,
  'alert-circle': AlertCircle,
  error: AlertCircle,
  danger: AlertCircle,
  'check-circle': CheckCircle2,
  check: CheckCircle2,
  success: CheckCircle2,
  ok: CheckCircle2,
  cpu: Cpu,
  processor: Cpu,
  database: Database,
  db: Database,
  server: Server,
  'hard-drive': HardDrive,
  disk: HardDrive,
  storage: HardDrive,
  activity: Activity,
  pulse: Activity,
  layers: Layers,
  stack: Layers,
  terminal: Terminal,
  console: Terminal,
  cli: Terminal,
  code: Code,
  'git-branch': GitBranch,
  branch: GitBranch,
  fork: GitBranch,
  workflow: Workflow,
  process: Workflow,
  shield: Shield,
  security: Shield,
  protect: Shield,
  lock: Lock,
  key: Key,
  globe: Globe,
  network: Globe,
  web: Globe,
  zap: Zap,
  flash: Zap,
  speed: Zap,
  fast: Zap,
  clock: Clock,
  time: Clock,
  history: Clock,
  sparkles: Sparkles,
  magic: Sparkles,
  ai: Sparkles,
  'book-open': BookOpen,
  book: BookOpen,
  docs: BookOpen,
  'file-text': FileText,
  file: FileText,
  doc: FileText,
  box: Package,
  package: Package,
  'help-circle': HelpCircle,
  help: HelpCircle,
  'trending-up': TrendingUp,
  up: TrendingUp,
  'trending-down': TrendingDown,
  down: TrendingDown,
  'bar-chart': BarChart2,
  chart: BarChart2,
  refresh: RefreshCw,
  sync: RefreshCw,
};

function UiIcon({ name, className = 'w-3.5 h-3.5 shrink-0' }: { name?: string; className?: string }) {
  if (!name) return null;
  const key = name.toLowerCase().trim().replace(/_/g, '-');
  const IconComponent = ICON_MAP[key] ?? Layers;
  return <IconComponent className={className} />;
}

function extractStatePath(rawProp: unknown, bindingPath?: string): string | undefined {
  if (bindingPath) return bindingPath;
  if (typeof rawProp === 'object' && rawProp !== null) {
    const obj = rawProp as Record<string, unknown>;
    if (typeof obj.$state === 'string') return obj.$state;
    if (typeof obj.$bindState === 'string') return obj.$bindState;
  }
  return undefined;
}

const StackComponent: React.FC<
  BaseComponentProps<{ direction?: 'vertical' | 'horizontal'; gap?: 'sm' | 'md' }>
> = (ctx) => {
  const props = ctx.props ?? (ctx as any).element?.props ?? {};
  const direction = props.direction === 'horizontal' ? 'flex-row flex-wrap items-center' : 'flex-col';
  const gap = props.gap === 'sm' ? 'gap-2' : 'gap-3';
  return <div className={`flex ${direction} ${gap} w-full`}>{ctx.children}</div>;
};

const CardComponent: React.FC<
  BaseComponentProps<{ title: string; subtitle?: string; badge?: string; icon?: string }>
> = (ctx) => {
  const props = ctx.props ?? (ctx as any).element?.props ?? {};
  return (
    <div className="rounded-lg border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900/80 p-3 space-y-2.5 shadow-2xs w-full">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex items-center gap-1.5">
          {props.icon && <UiIcon name={props.icon} className="w-4 h-4 text-zinc-600 dark:text-zinc-300 shrink-0" />}
          <div className="min-w-0">
            <h4 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate">{props.title}</h4>
            {props.subtitle && (
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 truncate">{props.subtitle}</p>
            )}
          </div>
        </div>
        {props.badge && (
          <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 shrink-0">
            {props.badge}
          </span>
        )}
      </div>
      {ctx.children && <div className="space-y-2.5">{ctx.children}</div>}
    </div>
  );
};

const MetricGridComponent: React.FC<BaseComponentProps<{ columns?: 2 | 3 | 4 }>> = (ctx) => {
  const props = ctx.props ?? (ctx as any).element?.props ?? {};
  const cols =
    props.columns === 2
      ? 'grid-cols-1 sm:grid-cols-2'
      : props.columns === 4
        ? 'grid-cols-2 sm:grid-cols-4'
        : 'grid-cols-1 sm:grid-cols-3';
  return <div className={`grid gap-2 w-full ${cols}`}>{ctx.children}</div>;
};

const MetricCardComponent: React.FC<
  BaseComponentProps<{
    label: string;
    value: string;
    hint?: string;
    status?: 'ok' | 'warn' | 'error';
    trend?: 'up' | 'down' | 'flat';
    icon?: string;
  }>
> = (ctx) => {
  const props = ctx.props ?? (ctx as any).element?.props ?? {};
  const statusDot =
    props.status === 'ok'
      ? 'bg-emerald-500'
      : props.status === 'warn'
        ? 'bg-amber-500'
        : props.status === 'error'
          ? 'bg-rose-500'
          : null;

  const trendIcon =
    props.trend === 'up' ? '↑' : props.trend === 'down' ? '↓' : props.trend === 'flat' ? '→' : null;
  const trendColor =
    props.trend === 'up'
      ? 'text-emerald-600 dark:text-emerald-400'
      : props.trend === 'down'
        ? 'text-rose-600 dark:text-rose-400'
        : 'text-zinc-500';

  return (
    <div className="rounded-lg border border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/60 p-2.5 space-y-1">
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {props.icon && <UiIcon name={props.icon} className="w-3 h-3 text-zinc-400 dark:text-zinc-500 shrink-0" />}
          <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 truncate">{props.label}</span>
        </div>
        {statusDot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot}`} />}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-sm sm:text-base font-semibold font-mono text-zinc-900 dark:text-zinc-100 truncate">
          {props.value}
        </span>
        {trendIcon && <span className={`text-xs font-bold font-mono ${trendColor}`}>{trendIcon}</span>}
      </div>
      {props.hint && <p className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate">{props.hint}</p>}
    </div>
  );
};

const KeyValueListComponent: React.FC<
  BaseComponentProps<{
    items: Array<{ key: string; value: string; mono?: boolean; badge?: string }>;
  }>
> = (ctx) => {
  const props = ctx.props ?? (ctx as any).element?.props ?? {};
  const items = Array.isArray(props.items) ? props.items : [];
  return (
    <div className="rounded-lg border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 divide-y divide-zinc-100 dark:divide-zinc-800/80 w-full overflow-hidden">
      {items.map((item: { key: string; value: string; mono?: boolean; badge?: string }, idx: number) => (
        <div key={idx} className="flex items-center justify-between px-2.5 py-1.5 text-xs">
          <span className="text-xs text-zinc-500 dark:text-zinc-400 shrink-0">{item.key}</span>
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className={`text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate ${
                item.mono ? 'font-mono' : ''
              }`}
            >
              {item.value}
            </span>
            {item.badge && (
              <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 shrink-0">
                {item.badge}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

const TextInputComponent: React.FC<
  BaseComponentProps<{
    label: string;
    value?: string;
    placeholder?: string;
    hint?: string;
  }>
> = (ctx) => {
  const props = ctx.props ?? (ctx as any).element?.props ?? {};
  const bindings = ctx.bindings;
  const { mode, disabled } = useUiRenderContext();
  const rawProp = props.value;
  const statePath = extractStatePath(rawProp, bindings?.value);
  const store = useStateStore();
  const [, setBoundVal] = useBoundProp<string>(props.value, statePath);
  const [localVal, setLocalVal] = useState<string>(typeof props.value === 'string' ? props.value : '');

  const val = statePath
    ? ((store.get(statePath) as string | undefined) ?? (typeof props.value === 'string' ? props.value : ''))
    : localVal;
  const isDisabled = disabled || mode === 'display';

  return (
    <div className="space-y-1 w-full">
      <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">{props.label}</label>
      <input
        type="text"
        value={val ?? ''}
        placeholder={props.placeholder}
        disabled={isDisabled}
        onChange={(e) => {
          const newVal = e.target.value;
          if (statePath) {
            store.set(statePath, newVal);
            setBoundVal(newVal);
          } else {
            setLocalVal(newVal);
          }
        }}
        className="h-8 w-full px-2.5 text-xs rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
      />
      {props.hint && <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{props.hint}</p>}
    </div>
  );
};

const SelectComponent: React.FC<
  BaseComponentProps<{
    label: string;
    value?: string;
    options: Array<{ value: string; label: string }>;
  }>
> = (ctx) => {
  const props = ctx.props ?? (ctx as any).element?.props ?? {};
  const bindings = ctx.bindings;
  const { mode, disabled } = useUiRenderContext();
  const rawProp = props.value;
  const statePath = extractStatePath(rawProp, bindings?.value);
  const store = useStateStore();
  const [, setBoundVal] = useBoundProp<string>(props.value, statePath);
  const options = Array.isArray(props.options) ? props.options : [];
  const defaultVal = options[0]?.value ?? '';
  const [localVal, setLocalVal] = useState<string>(typeof props.value === 'string' ? props.value : defaultVal);

  const val = statePath
    ? ((store.get(statePath) as string | undefined) ?? (typeof props.value === 'string' ? props.value : defaultVal))
    : localVal;
  const isDisabled = disabled || mode === 'display';

  return (
    <div className="space-y-1 w-full">
      <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">{props.label}</label>
      <select
        value={val ?? ''}
        disabled={isDisabled}
        onChange={(e) => {
          const newVal = e.target.value;
          if (statePath) {
            store.set(statePath, newVal);
            setBoundVal(newVal);
          } else {
            setLocalVal(newVal);
          }
        }}
        className="h-8 w-full px-2.5 text-xs rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 cursor-pointer"
      >
        {options.map((opt: { value: string; label: string }, idx: number) => (
          <option key={idx} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
};

const SwitchComponent: React.FC<
  BaseComponentProps<{
    label: string;
    checked?: boolean;
    hint?: string;
  }>
> = (ctx) => {
  const props = ctx.props ?? (ctx as any).element?.props ?? {};
  const bindings = ctx.bindings;
  const { mode, disabled } = useUiRenderContext();
  const rawProp = props.checked;
  const statePath = extractStatePath(rawProp, bindings?.checked);
  const store = useStateStore();
  const [, setBoundVal] = useBoundProp<boolean>(props.checked, statePath);
  const [localChecked, setLocalChecked] = useState<boolean>(Boolean(props.checked));

  const isChecked = statePath ? Boolean(store.get(statePath) ?? props.checked) : localChecked;
  const isDisabled = disabled || mode === 'display';

  const toggle = () => {
    if (isDisabled) return;
    const nextVal = !isChecked;
    if (statePath) {
      store.set(statePath, nextVal);
      setBoundVal(nextVal);
    } else {
      setLocalChecked(nextVal);
    }
  };

  return (
    <div className="flex items-center justify-between gap-2 w-full py-1">
      <div className="min-w-0">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{props.label}</span>
        {props.hint && <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{props.hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={isChecked}
        disabled={isDisabled}
        onClick={toggle}
        className={`w-9 h-5 rounded-full transition-colors relative cursor-pointer disabled:opacity-50 shrink-0 ${
          isChecked ? 'bg-blue-600 dark:bg-blue-500' : 'bg-zinc-200 dark:bg-zinc-700'
        }`}
      >
        <span
          className={`w-3.5 h-3.5 rounded-full bg-white shadow-xs transition-transform absolute top-0.75 left-0.75 ${
            isChecked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
};

const ActionBarComponent: React.FC<BaseComponentProps<{ align?: 'left' | 'right' | 'between' }>> = (ctx) => {
  const props = ctx.props ?? (ctx as any).element?.props ?? {};
  const justify =
    props.align === 'left' ? 'justify-start' : props.align === 'between' ? 'justify-between' : 'justify-end';
  return <div className={`flex items-center gap-1.5 pt-1 w-full ${justify}`}>{ctx.children}</div>;
};

const ButtonComponent: React.FC<
  BaseComponentProps<{
    label: string;
    variant?: 'primary' | 'secondary' | 'danger';
  }>
> = (ctx) => {
  const props = ctx.props ?? (ctx as any).element?.props ?? {};
  const emit = ctx.emit;
  const on = ctx.on;
  const { mode, disabled, onSubmit, getStoreSnapshot } = useUiRenderContext();
  const [submitting, setSubmitting] = useState(false);

  const variantClass =
    props.variant === 'secondary'
      ? 'bg-white hover:bg-zinc-50 dark:bg-zinc-900 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 shadow-2xs'
      : props.variant === 'danger'
        ? 'bg-rose-600 hover:bg-rose-700 text-white shadow-2xs'
        : 'bg-blue-600 hover:bg-blue-700 text-white shadow-2xs';

  const isDisabled = disabled || mode === 'display' || submitting;

  const handleClick = async () => {
    if (isDisabled) return;
    setSubmitting(true);
    try {
      const pressHandle = typeof on === 'function' ? on('press') : undefined;
      if (pressHandle?.bound) {
        emit('press');
      } else if (mode === 'ask' && onSubmit) {
        const currentState = getStoreSnapshot ? getStoreSnapshot() : {};
        onSubmit(
          JSON.stringify({
            decision: props.label,
            params: { decision: props.label },
            state: currentState,
          }),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <button
      type="button"
      disabled={isDisabled}
      onClick={handleClick}
      className={`h-8 px-3 text-xs font-medium rounded-lg transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center justify-center gap-1.5 shrink-0 ${variantClass}`}
    >
      {submitting && <Loader2 className="w-3 h-3 animate-spin text-current" />}
      <span>{props.label}</span>
    </button>
  );
};

const CalloutComponent: React.FC<
  BaseComponentProps<{
    title?: string;
    content: string;
    variant?: 'info' | 'tip' | 'warn' | 'error';
    icon?: string;
  }>
> = (ctx) => {
  const props = ctx.props ?? (ctx as any).element?.props ?? {};
  const variant = props.variant || 'info';

  const variantStyles =
    variant === 'tip'
      ? {
          bg: 'bg-emerald-50/70 dark:bg-emerald-950/30 border-emerald-200/80 dark:border-emerald-900/60 text-emerald-900 dark:text-emerald-100',
          iconColor: 'text-emerald-600 dark:text-emerald-400',
          defaultIcon: 'lightbulb',
        }
      : variant === 'warn'
        ? {
            bg: 'bg-amber-50/70 dark:bg-amber-950/30 border-amber-200/80 dark:border-amber-900/60 text-amber-900 dark:text-amber-100',
            iconColor: 'text-amber-600 dark:text-amber-400',
            defaultIcon: 'alert-triangle',
          }
        : variant === 'error'
          ? {
              bg: 'bg-rose-50/70 dark:bg-rose-950/30 border-rose-200/80 dark:border-rose-900/60 text-rose-900 dark:text-rose-100',
              iconColor: 'text-rose-600 dark:text-rose-400',
              defaultIcon: 'alert-circle',
            }
          : {
              bg: 'bg-blue-50/70 dark:bg-blue-950/30 border-blue-200/80 dark:border-blue-900/60 text-blue-900 dark:text-blue-100',
              iconColor: 'text-blue-600 dark:text-blue-400',
              defaultIcon: 'info',
            };

  const iconName = props.icon || variantStyles.defaultIcon;

  return (
    <div className={`rounded-lg border p-3 text-xs space-y-1 w-full shadow-2xs ${variantStyles.bg}`}>
      <div className="flex items-center gap-1.5 font-semibold">
        <UiIcon name={iconName} className={`w-4 h-4 shrink-0 ${variantStyles.iconColor}`} />
        {props.title && <span>{props.title}</span>}
      </div>
      <div className="text-xs leading-relaxed opacity-90 break-words whitespace-pre-wrap pl-5.5">
        {props.content}
      </div>
    </div>
  );
};

const TabsComponent: React.FC<
  BaseComponentProps<{
    tabs: Array<{ id: string; label: string; icon?: string }>;
    defaultTab?: string;
  }>
> = (ctx) => {
  const props = ctx.props ?? (ctx as any).element?.props ?? {};
  const tabs = Array.isArray(props.tabs) ? props.tabs : [];
  const [activeTab, setActiveTab] = useState<string>(() => props.defaultTab || tabs[0]?.id || '');

  const activeIndex = tabs.findIndex((t) => t.id === activeTab);

  let activeChild: React.ReactNode = null;
  if (ctx.slots && ctx.slots[activeTab]) {
    activeChild = ctx.slots[activeTab];
  } else if (Array.isArray(ctx.children)) {
    activeChild = activeIndex >= 0 ? ctx.children[activeIndex] : ctx.children[0];
  } else {
    activeChild = ctx.children;
  }

  return (
    <div className="space-y-2.5 w-full">
      <div className="inline-flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800/80 border border-zinc-200/60 dark:border-zinc-700/60 gap-0.5 flex-wrap">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`h-7 px-2.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 cursor-pointer ${
                isActive
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-2xs font-semibold'
                  : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              {tab.icon && <UiIcon name={tab.icon} className="w-3 h-3 shrink-0" />}
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
      <div className="w-full">{activeChild}</div>
    </div>
  );
};

const StepsComponent: React.FC<
  BaseComponentProps<{
    items: Array<{
      title: string;
      description?: string;
      status?: 'done' | 'current' | 'pending';
      icon?: string;
      badge?: string;
    }>;
  }>
> = (ctx) => {
  const props = ctx.props ?? (ctx as any).element?.props ?? {};
  const items = Array.isArray(props.items) ? props.items : [];

  return (
    <div className="space-y-3 relative pl-6 w-full py-1">
      <div className="absolute left-2.75 top-2.5 bottom-2.5 w-px bg-zinc-200 dark:bg-zinc-800" />
      {items.map((item, idx) => {
        const status = item.status || (idx === 0 ? 'current' : 'pending');
        const nodeClass =
          status === 'done'
            ? 'bg-emerald-500 text-white'
            : status === 'current'
              ? 'bg-blue-600 text-white shadow-xs ring-2 ring-blue-500/20'
              : 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-zinc-400 dark:text-zinc-500';

        return (
          <div key={idx} className="relative group">
            <div
              className={`absolute -left-6 top-0.5 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-mono font-bold shrink-0 transition-colors ${nodeClass}`}
            >
              {status === 'done' ? (
                <Check className="w-3 h-3 stroke-[2.5]" />
              ) : item.icon ? (
                <UiIcon name={item.icon} className="w-2.5 h-2.5" />
              ) : (
                idx + 1
              )}
            </div>
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">{item.title}</span>
                {item.badge && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                    {item.badge}
                  </span>
                )}
              </div>
              {item.description && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed whitespace-pre-wrap">
                  {item.description}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const AccordionComponent: React.FC<
  BaseComponentProps<{
    items: Array<{
      title: string;
      content?: string;
      defaultOpen?: boolean;
      icon?: string;
      badge?: string;
    }>;
  }>
> = (ctx) => {
  const props = ctx.props ?? (ctx as any).element?.props ?? {};
  const items = Array.isArray(props.items) ? props.items : [];

  const [openSet, setOpenSet] = useState<Set<number>>(() => {
    const initial = new Set<number>();
    items.forEach((item, idx) => {
      if (item.defaultOpen) initial.add(idx);
    });
    return initial;
  });

  const toggle = (idx: number) => {
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <div className="rounded-lg border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 divide-y divide-zinc-100 dark:divide-zinc-800/80 overflow-hidden w-full shadow-2xs">
      {items.map((item, idx) => {
        const isOpen = openSet.has(idx);
        return (
          <div key={idx} className="transition-colors">
            <button
              type="button"
              onClick={() => toggle(idx)}
              className="w-full px-3 py-2 text-xs font-medium flex items-center justify-between text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                {item.icon && <UiIcon name={item.icon} className="w-3.5 h-3.5 text-zinc-500 shrink-0" />}
                <span className="font-semibold text-zinc-800 dark:text-zinc-200 truncate">{item.title}</span>
                {item.badge && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                    {item.badge}
                  </span>
                )}
              </div>
              <ChevronDown
                className={`w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 transition-transform duration-200 shrink-0 ${
                  isOpen ? 'rotate-180' : ''
                }`}
              />
            </button>
            {isOpen && item.content && (
              <div className="px-3 py-2 text-xs text-zinc-600 dark:text-zinc-300 bg-zinc-50/40 dark:bg-zinc-950/40 border-t border-zinc-100 dark:border-zinc-800/80 leading-relaxed whitespace-pre-wrap">
                {item.content}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

const BarListComponent: React.FC<
  BaseComponentProps<{
    items: Array<{
      label: string;
      value: number;
      max?: number;
      displayValue?: string;
      color?: 'blue' | 'emerald' | 'amber' | 'rose' | 'purple';
    }>;
    title?: string;
  }>
> = (ctx) => {
  const props = ctx.props ?? (ctx as any).element?.props ?? {};
  const items = Array.isArray(props.items) ? props.items : [];
  const computedMax = Math.max(...items.map((i) => i.value), 1);

  const colorStyles: Record<string, string> = {
    blue: 'bg-blue-600 dark:bg-blue-500',
    emerald: 'bg-emerald-600 dark:bg-emerald-500',
    amber: 'bg-amber-500 dark:bg-amber-400',
    rose: 'bg-rose-500 dark:bg-rose-400',
    purple: 'bg-purple-600 dark:bg-purple-500',
  };

  return (
    <div className="rounded-lg border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900/80 p-3 space-y-2.5 w-full shadow-2xs">
      {props.title && (
        <h4 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate">{props.title}</h4>
      )}
      <div className="space-y-2 w-full">
        {items.map((item, idx) => {
          const effectiveMax = item.max && item.max > 0 ? item.max : computedMax;
          const pct = Math.min(100, Math.max(0, (item.value / effectiveMax) * 100));
          const barColor = item.color ? colorStyles[item.color] || colorStyles.blue : colorStyles.blue;
          const display = item.displayValue ?? String(item.value);

          return (
            <div key={idx} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-xs text-zinc-600 dark:text-zinc-300 font-medium truncate">{item.label}</span>
                <span className="text-xs font-mono font-semibold text-zinc-800 dark:text-zinc-200 shrink-0">
                  {display}
                </span>
              </div>
              <div className="h-1.5 w-full bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${barColor}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const { registry: botdRegistry } = defineRegistry(botdUiCatalog, {
  components: {
    Stack: StackComponent as any,
    Card: CardComponent as any,
    MetricGrid: MetricGridComponent as any,
    MetricCard: MetricCardComponent as any,
    KeyValueList: KeyValueListComponent as any,
    TextInput: TextInputComponent as any,
    Select: SelectComponent as any,
    Switch: SwitchComponent as any,
    ActionBar: ActionBarComponent as any,
    Button: ButtonComponent as any,
    Callout: CalloutComponent as any,
    Tabs: TabsComponent as any,
    Steps: StepsComponent as any,
    Accordion: AccordionComponent as any,
    BarList: BarListComponent as any,
  },
  actions: {
    submit: async () => {},
  },
});

export interface BotdUiRendererProps {
  spec: BotdUiSpec;
  mode?: 'display' | 'ask';
  disabled?: boolean;
  onSubmit?: (payloadJson: string) => void;
}

export const BotdUiRenderer: React.FC<BotdUiRendererProps> = ({
  spec,
  mode = 'display',
  disabled = false,
  onSubmit,
}) => {
  const store = useMemo<StateStore>(() => createStateStore(spec.state ?? {}), [spec]);

  const normalizedSpec = useMemo(() => {
    if (!spec || !spec.elements) return spec;
    const nextElements = { ...spec.elements };
    let changed = false;
    for (const [key, el] of Object.entries(spec.elements)) {
      if (!el || !el.props) continue;
      const p = el.props as Record<string, unknown>;
      let nextProps = p;
      if (el.type === 'TextInput' || el.type === 'Select') {
        if (p.value && typeof p.value === 'object' && ('$state' in p.value) && !('$bindState' in p.value)) {
          nextProps = { ...nextProps, value: { ...p.value, $bindState: (p.value as any).$state } };
          changed = true;
        }
      } else if (el.type === 'Switch') {
        if (p.checked && typeof p.checked === 'object' && ('$state' in p.checked) && !('$bindState' in p.checked)) {
          nextProps = { ...nextProps, checked: { ...p.checked, $bindState: (p.checked as any).$state } };
          changed = true;
        }
      }
      if (nextProps !== p) {
        nextElements[key] = { ...el, props: nextProps };
      }
    }
    return changed ? { ...spec, elements: nextElements } : spec;
  }, [spec]);

  const hasButtons = useMemo(() => {
    return Object.values(spec.elements).some((el) => el.type === 'Button');
  }, [spec]);

  const handlers = useMemo(
    () => ({
      submit: async (params: Record<string, unknown> = {}) => {
        const currentState = store ? store.getSnapshot() : {};
        const payload = {
          ...(params?.decision !== undefined ? { decision: params.decision } : {}),
          ...(params && Object.keys(params).length > 0 ? { params } : {}),
          state: currentState,
        };
        const jsonStr = JSON.stringify(payload);
        onSubmit?.(jsonStr);
      },
    }),
    [store, onSubmit],
  );

  const contextValue = useMemo<UiRenderContextValue>(
    () => ({
      mode,
      disabled,
      onSubmit,
      getStoreSnapshot: () => (store ? store.getSnapshot() : {}),
    }),
    [mode, disabled, onSubmit, store],
  );

  return (
    <UiRenderContext.Provider value={contextValue}>
      <JSONUIProvider registry={botdRegistry} store={store} handlers={handlers}>
        <div className="w-full space-y-2">
          <Renderer spec={normalizedSpec as any} registry={botdRegistry} />
          {mode === 'ask' && !hasButtons && (
            <div className="flex justify-end pt-1">
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  const currentState = store ? store.getSnapshot() : {};
                  onSubmit?.(JSON.stringify({ decision: 'submit', state: currentState }));
                }}
                className="h-8 px-3 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white shadow-2xs transition-colors cursor-pointer disabled:opacity-50"
              >
                提交表单
              </button>
            </div>
          )}
        </div>
      </JSONUIProvider>
    </UiRenderContext.Provider>
  );
};

export const UiSpecBlock: React.FC<{ raw: string }> = ({ raw }) => {
  const [showRaw, setShowRaw] = useState(false);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return (
      <div className="my-2 h-8 px-3 rounded-lg border border-zinc-200/70 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/50 inline-flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />
        <span>正在渲染动态界面...</span>
      </div>
    );
  }

  const validation = validateUiSpec(parsed);
  if (!validation.ok) {
    return (
      <div className="my-2 rounded-lg border border-rose-200 dark:border-rose-900/60 bg-rose-50/50 dark:bg-rose-950/30 p-2.5 text-xs space-y-1.5 text-rose-800 dark:text-rose-200">
        <div className="flex items-center gap-1.5 font-medium">
          <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
          <span>动态界面 Spec 校验未通过</span>
        </div>
        <ul className="list-disc list-inside text-[11px] space-y-0.5 text-rose-700 dark:text-rose-300">
          {validation.errors.map((err, idx) => (
            <li key={idx} className="truncate">
              {err}
            </li>
          ))}
        </ul>
        <div className="pt-1">
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            className="flex items-center gap-1 text-[11px] font-mono text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors cursor-pointer"
          >
            <ChevronDown
              className={`w-3 h-3 transition-transform duration-150 ${showRaw ? '' : '-rotate-90'}`}
            />
            <span>{showRaw ? '隐藏原始 Spec' : '查看原始 Spec'}</span>
          </button>
          {showRaw && (
            <pre className="mt-1 font-mono text-[10px] leading-relaxed p-2 rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 overflow-x-auto max-h-48 overflow-y-auto">
              {raw}
            </pre>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="my-2">
      <BotdUiRenderer spec={validation.spec} mode="display" />
    </div>
  );
};
