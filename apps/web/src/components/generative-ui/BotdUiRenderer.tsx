import React, { createContext, useContext, useMemo, useRef, useState } from 'react';
import { createStateStore, type StateStore } from '@json-render/core';
import {
  defineRegistry,
  JSONUIProvider,
  Renderer,
  useBoundProp,
  useStateStore,
  type ComponentRenderProps,
} from '@json-render/react';
import { AlertCircle, ChevronDown, Loader2 } from 'lucide-react';
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
  ComponentRenderProps<{ direction?: 'vertical' | 'horizontal'; gap?: 'sm' | 'md' }>
> = ({ element, children }) => {
  const props = element.props;
  const direction = props.direction === 'horizontal' ? 'flex-row flex-wrap items-center' : 'flex-col';
  const gap = props.gap === 'sm' ? 'gap-2' : 'gap-3';
  return <div className={`flex ${direction} ${gap} w-full`}>{children}</div>;
};

const CardComponent: React.FC<
  ComponentRenderProps<{ title: string; subtitle?: string; badge?: string }>
> = ({ element, children }) => {
  const props = element.props;
  return (
    <div className="rounded-lg border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900/80 p-3 space-y-2.5 shadow-2xs w-full">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate">{props.title}</h4>
          {props.subtitle && (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 truncate">{props.subtitle}</p>
          )}
        </div>
        {props.badge && (
          <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 shrink-0">
            {props.badge}
          </span>
        )}
      </div>
      {children && <div className="space-y-2.5">{children}</div>}
    </div>
  );
};

const MetricGridComponent: React.FC<ComponentRenderProps<{ columns?: 2 | 3 | 4 }>> = ({ element, children }) => {
  const props = element.props;
  const cols =
    props.columns === 2
      ? 'grid-cols-1 sm:grid-cols-2'
      : props.columns === 4
        ? 'grid-cols-2 sm:grid-cols-4'
        : 'grid-cols-1 sm:grid-cols-3';
  return <div className={`grid gap-2 w-full ${cols}`}>{children}</div>;
};

const MetricCardComponent: React.FC<
  ComponentRenderProps<{
    label: string;
    value: string;
    hint?: string;
    status?: 'ok' | 'warn' | 'error';
    trend?: 'up' | 'down' | 'flat';
  }>
> = ({ element }) => {
  const props = element.props;
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
        <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 truncate">{props.label}</span>
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
  ComponentRenderProps<{
    items: Array<{ key: string; value: string; mono?: boolean; badge?: string }>;
  }>
> = ({ element }) => {
  const props = element.props;
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
  ComponentRenderProps<{
    label: string;
    value?: string;
    placeholder?: string;
    hint?: string;
  }>
> = ({ element, bindings }) => {
  const props = element.props;
  const { mode, disabled } = useUiRenderContext();
  const rawProp = (element.props as Record<string, unknown> | undefined)?.value;
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
  ComponentRenderProps<{
    label: string;
    value?: string;
    options: Array<{ value: string; label: string }>;
  }>
> = ({ element, bindings }) => {
  const props = element.props;
  const { mode, disabled } = useUiRenderContext();
  const rawProp = (element.props as Record<string, unknown> | undefined)?.value;
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
  ComponentRenderProps<{
    label: string;
    checked?: boolean;
    hint?: string;
  }>
> = ({ element, bindings }) => {
  const props = element.props;
  const { mode, disabled } = useUiRenderContext();
  const rawProp = (element.props as Record<string, unknown> | undefined)?.checked;
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

const ActionBarComponent: React.FC<ComponentRenderProps<{ align?: 'left' | 'right' | 'between' }>> = ({
  element,
  children,
}) => {
  const props = element.props;
  const justify =
    props.align === 'left' ? 'justify-start' : props.align === 'between' ? 'justify-between' : 'justify-end';
  return <div className={`flex items-center gap-1.5 pt-1 w-full ${justify}`}>{children}</div>;
};

const ButtonComponent: React.FC<
  ComponentRenderProps<{
    label: string;
    variant?: 'primary' | 'secondary' | 'danger';
  }>
> = ({ element, emit }) => {
  const props = element.props;
  const { mode, disabled, onSubmit, getStoreSnapshot } = useUiRenderContext();
  const pressBinding = (element.on as any)?.press;
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
      if (pressBinding && pressBinding.action === 'submit') {
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
  const storeRef = useRef<StateStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createStateStore(spec.state ?? {});
  }

  const hasButtons = useMemo(() => {
    return Object.values(spec.elements).some((el) => el.type === 'Button');
  }, [spec]);

  const handlers = useMemo(
    () => ({
      submit: async (params: Record<string, unknown> = {}) => {
        const currentState = storeRef.current ? storeRef.current.getSnapshot() : {};
        const payload = {
          ...(params?.decision !== undefined ? { decision: params.decision } : {}),
          ...(params && Object.keys(params).length > 0 ? { params } : {}),
          state: currentState,
        };
        const jsonStr = JSON.stringify(payload);
        onSubmit?.(jsonStr);
      },
    }),
    [onSubmit],
  );

  const contextValue = useMemo<UiRenderContextValue>(
    () => ({
      mode,
      disabled,
      onSubmit,
      getStoreSnapshot: () => (storeRef.current ? storeRef.current.getSnapshot() : {}),
    }),
    [mode, disabled, onSubmit],
  );

  return (
    <UiRenderContext.Provider value={contextValue}>
      <JSONUIProvider registry={botdRegistry} store={storeRef.current} handlers={handlers}>
        <div className="w-full space-y-2">
          <Renderer spec={spec as any} registry={botdRegistry} />
          {mode === 'ask' && !hasButtons && (
            <div className="flex justify-end pt-1">
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  const currentState = storeRef.current ? storeRef.current.getSnapshot() : {};
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
