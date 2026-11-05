export const BOTD_UI_CATALOG_VERSION = 'botd.v1';
export const MAX_UI_SPEC_BYTES = 64 * 1024; // 64KB
export const MAX_UI_ELEMENTS = 64;
export const MAX_UI_TREE_DEPTH = 6;

export const BOTD_UI_COMPONENT_TYPES = [
  'Stack',
  'Card',
  'MetricGrid',
  'MetricCard',
  'KeyValueList',
  'TextInput',
  'Select',
  'Switch',
  'CheckboxGroup',
  'ActionBar',
  'Button',
  'Callout',
  'Tabs',
  'Steps',
  'Accordion',
  'BarList',
  'Table',
] as const;

export type BotdUiComponentType = (typeof BOTD_UI_COMPONENT_TYPES)[number];

export type UiStateBinding = { $state: string } | { $bindState: string };

export interface StackElementProps {
  direction?: 'vertical' | 'horizontal';
  gap?: 'sm' | 'md';
}

export interface CardElementProps {
  title: string;
  subtitle?: string;
  badge?: string;
  icon?: string;
}

export interface MetricGridElementProps {
  columns?: 2 | 3 | 4;
}

export interface MetricCardElementProps {
  label: string;
  value: string;
  hint?: string;
  status?: 'ok' | 'warn' | 'error';
  trend?: 'up' | 'down' | 'flat';
  icon?: string;
}

export interface KeyValueListItem {
  key: string;
  value: string;
  mono?: boolean;
  badge?: string;
}

export interface KeyValueListElementProps {
  items: KeyValueListItem[];
}

export interface TextInputElementProps {
  label: string;
  value?: string | UiStateBinding;
  placeholder?: string;
  hint?: string;
  /** Render a multi-line textarea instead of a single-line input. */
  multiline?: boolean;
  /** Textarea visible line count (2-12), only used when multiline is true. */
  rows?: number;
  /** Mask the value as a password input; hub-side answers get redacted into the SecretStash. */
  secret?: boolean;
}

export interface SelectOptionItem {
  value: string;
  label: string;
}

export interface SelectElementProps {
  label: string;
  value?: string | UiStateBinding;
  options: SelectOptionItem[];
}

export interface SwitchElementProps {
  label: string;
  checked?: boolean | UiStateBinding;
  hint?: string;
}

export interface CheckboxOptionItem {
  value: string;
  label: string;
  description?: string;
}

export interface CheckboxGroupElementProps {
  label: string;
  options: CheckboxOptionItem[];
  value?: string[] | UiStateBinding;
  hint?: string;
}

export interface ActionBarElementProps {
  align?: 'left' | 'right' | 'between';
}

export interface ButtonElementProps {
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
}

export interface CalloutElementProps {
  title?: string;
  content: string;
  variant?: 'info' | 'tip' | 'warn' | 'error';
  icon?: string;
  /** Render content in monospace font (commands, logs, diffs). */
  mono?: boolean;
}

export interface TabItem {
  id: string;
  label: string;
  icon?: string;
}

export interface TabsElementProps {
  tabs: TabItem[];
  defaultTab?: string;
}

export interface StepItem {
  title: string;
  description?: string;
  status?: 'done' | 'current' | 'pending';
  icon?: string;
  badge?: string;
}

export interface StepsElementProps {
  items: StepItem[];
}

export interface AccordionItem {
  title: string;
  content?: string;
  defaultOpen?: boolean;
  icon?: string;
  badge?: string;
  /** Render content in monospace font (commands, logs, diffs). */
  mono?: boolean;
}

export interface AccordionElementProps {
  items: AccordionItem[];
}

export interface BarListItem {
  label: string;
  value: number;
  max?: number;
  displayValue?: string;
  color?: 'blue' | 'emerald' | 'amber' | 'rose' | 'purple';
}

export interface BarListElementProps {
  items: BarListItem[];
  title?: string;
}

export interface TableElementProps {
  columns: string[];
  rows: string[][];
  /** 0-based column indexes rendered in monospace font. */
  monoColumns?: number[];
  title?: string;
}

export interface ButtonActionPress {
  action: 'submit';
  params?: {
    decision?: string;
    [k: string]: unknown;
  };
}

export interface BotdUiElement<P = Record<string, unknown>> {
  type: BotdUiComponentType | string;
  props?: P;
  children?: string[];
  slots?: Record<string, string[]>;
  on?: {
    press?: ButtonActionPress | { action: string; params?: Record<string, unknown> };
    [key: string]: unknown;
  };
}

export interface BotdUiSpec {
  root: string;
  elements: Record<string, BotdUiElement>;
  state?: Record<string, unknown>;
}

export type UiValidationResult =
  | { ok: true; spec: BotdUiSpec; normalizedJson: string }
  | { ok: false; errors: string[] };

function isStateBinding(val: unknown): boolean {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return false;
  const obj = val as Record<string, unknown>;
  return (
    (typeof obj.$state === 'string' && obj.$state.trim().length > 0) ||
    (typeof obj.$bindState === 'string' && obj.$bindState.trim().length > 0)
  );
}

function isStringOrStateBinding(val: unknown): boolean {
  return typeof val === 'string' || isStateBinding(val);
}

function isBooleanOrStateBinding(val: unknown): boolean {
  return typeof val === 'boolean' || isStateBinding(val);
}

function isStringArrayOrStateBinding(val: unknown): boolean {
  return (Array.isArray(val) && val.every((item) => typeof item === 'string')) || isStateBinding(val);
}

// --- per-component props validators -----------------------------------------
//
// 校验以小 helper 组合：requireXxx 校验必填字段，optionalXxx 校验可选字段，
// validateItems 统一处理「非空数组 + 逐项校验」模式（数组非法时只报
// requires 一条，与历史短路行为一致）。错误消息格式逐字节保持不变
// （tests/generative-ui.test.ts 与 tests/secret-ui-stash.test.ts 锚定）。

type PropsValidator = (id: string, props: Record<string, any>) => string[];

const isItemObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null;

/** `"a", "b", or "c"`（两个值时为 `"a" or "b"`）。 */
const quotedList = (values: readonly string[]): string =>
  values.length === 2
    ? `"${values[0]}" or "${values[1]}"`
    : `${values.slice(0, -1).map((v) => `"${v}"`).join(', ')}, or "${values[values.length - 1]}"`;

function requireNonEmptyString(id: string, component: string, props: Record<string, any>, field: string, errors: string[]): void {
  if (typeof props[field] !== 'string' || !props[field].trim()) {
    errors.push(`Element "${id}" (${component}) requires a non-empty string "${field}" prop`);
  }
}

function optionalString(id: string, component: string, props: Record<string, any>, field: string, errors: string[]): void {
  if (props[field] !== undefined && typeof props[field] !== 'string') {
    errors.push(`Element "${id}" (${component}) props.${field} must be a string`);
  }
}

function optionalBoolean(id: string, component: string, props: Record<string, any>, field: string, errors: string[]): void {
  if (props[field] !== undefined && typeof props[field] !== 'boolean') {
    errors.push(`Element "${id}" (${component}) props.${field} must be a boolean`);
  }
}

function optionalEnum(id: string, component: string, props: Record<string, any>, field: string, values: readonly string[], errors: string[]): void {
  const v = props[field];
  if (v !== undefined && !values.includes(v)) {
    errors.push(`Element "${id}" (${component}) props.${field} must be ${quotedList(values)}`);
  }
}

/** 非空数组字段 + 逐项校验；数组本身非法时只报一条 requires 错误。 */
function validateItems(
  id: string,
  component: string,
  arr: unknown,
  field: string,
  itemCheck: (item: Record<string, any> | undefined, index: number, errors: string[]) => void,
): string[] {
  const errors: string[] = [];
  if (!Array.isArray(arr) || arr.length === 0) {
    errors.push(`Element "${id}" (${component}) requires a non-empty array "${field}" prop`);
    return errors;
  }
  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i];
    // 与历史行为一致：非对象（或 null）项只报首条字段缺失错误，跳过其余字段检查
    itemCheck(isItemObject(raw) ? raw : undefined, i, errors);
  }
  return errors;
}

function validateStackProps(id: string, props: Record<string, any>): string[] {
  const errors: string[] = [];
  optionalEnum(id, 'Stack', props, 'direction', ['vertical', 'horizontal'], errors);
  optionalEnum(id, 'Stack', props, 'gap', ['sm', 'md'], errors);
  return errors;
}

function validateCardProps(id: string, props: Record<string, any>): string[] {
  const errors: string[] = [];
  requireNonEmptyString(id, 'Card', props, 'title', errors);
  optionalString(id, 'Card', props, 'subtitle', errors);
  optionalString(id, 'Card', props, 'badge', errors);
  optionalString(id, 'Card', props, 'icon', errors);
  return errors;
}

function validateMetricGridProps(id: string, props: Record<string, any>): string[] {
  const errors: string[] = [];
  if (props.columns !== undefined && ![2, 3, 4].includes(props.columns)) {
    errors.push(`Element "${id}" (MetricGrid) props.columns must be 2, 3, or 4`);
  }
  return errors;
}

function validateMetricCardProps(id: string, props: Record<string, any>): string[] {
  const errors: string[] = [];
  requireNonEmptyString(id, 'MetricCard', props, 'label', errors);
  if (typeof props.value !== 'string') {
    errors.push(`Element "${id}" (MetricCard) requires a string "value" prop`);
  }
  optionalString(id, 'MetricCard', props, 'hint', errors);
  optionalEnum(id, 'MetricCard', props, 'status', ['ok', 'warn', 'error'], errors);
  optionalEnum(id, 'MetricCard', props, 'trend', ['up', 'down', 'flat'], errors);
  optionalString(id, 'MetricCard', props, 'icon', errors);
  return errors;
}

function validateKeyValueListProps(id: string, props: Record<string, any>): string[] {
  return validateItems(id, 'KeyValueList', props.items, 'items', (item, i, errors) => {
    if (!item || typeof item.key !== 'string' || typeof item.value !== 'string') {
      errors.push(`Element "${id}" (KeyValueList) item at index ${i} must have string "key" and "value"`);
      return;
    }
    if (item.mono !== undefined && typeof item.mono !== 'boolean') {
      errors.push(`Element "${id}" (KeyValueList) item at index ${i} "mono" must be a boolean`);
    }
    if (item.badge !== undefined && typeof item.badge !== 'string') {
      errors.push(`Element "${id}" (KeyValueList) item at index ${i} "badge" must be a string`);
    }
  });
}

function validateTextInputProps(id: string, props: Record<string, any>): string[] {
  const errors: string[] = [];
  requireNonEmptyString(id, 'TextInput', props, 'label', errors);
  if (props.value !== undefined && !isStringOrStateBinding(props.value)) {
    errors.push(`Element "${id}" (TextInput) props.value must be a string or state binding {"$state": "..."}`);
  }
  optionalString(id, 'TextInput', props, 'placeholder', errors);
  optionalString(id, 'TextInput', props, 'hint', errors);
  optionalBoolean(id, 'TextInput', props, 'multiline', errors);
  const rows = props.rows;
  if (rows !== undefined && (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 2 || rows > 12)) {
    errors.push(`Element "${id}" (TextInput) props.rows must be an integer between 2 and 12`);
  }
  optionalBoolean(id, 'TextInput', props, 'secret', errors);
  return errors;
}

function validateSelectProps(id: string, props: Record<string, any>): string[] {
  const errors: string[] = [];
  requireNonEmptyString(id, 'Select', props, 'label', errors);
  if (props.value !== undefined && !isStringOrStateBinding(props.value)) {
    errors.push(`Element "${id}" (Select) props.value must be a string or state binding {"$state": "..."}`);
  }
  errors.push(...validateItems(id, 'Select', props.options, 'options', (opt, i, errors) => {
    if (!opt || typeof opt.value !== 'string' || typeof opt.label !== 'string') {
      errors.push(`Element "${id}" (Select) option at index ${i} must have string "value" and "label"`);
    }
  }));
  return errors;
}

function validateSwitchProps(id: string, props: Record<string, any>): string[] {
  const errors: string[] = [];
  requireNonEmptyString(id, 'Switch', props, 'label', errors);
  if (props.checked !== undefined && !isBooleanOrStateBinding(props.checked)) {
    errors.push(`Element "${id}" (Switch) props.checked must be a boolean or state binding {"$state": "..."}`);
  }
  optionalString(id, 'Switch', props, 'hint', errors);
  return errors;
}

function validateCheckboxGroupProps(id: string, props: Record<string, any>): string[] {
  const errors: string[] = [];
  requireNonEmptyString(id, 'CheckboxGroup', props, 'label', errors);
  if (props.value !== undefined && !isStringArrayOrStateBinding(props.value)) {
    errors.push(`Element "${id}" (CheckboxGroup) props.value must be a string array or state binding {"$state": "..."}`);
  }
  errors.push(...validateItems(id, 'CheckboxGroup', props.options, 'options', (opt, i, errors) => {
    if (!opt || typeof opt.value !== 'string' || typeof opt.label !== 'string') {
      errors.push(`Element "${id}" (CheckboxGroup) option at index ${i} must have string "value" and "label"`);
      return;
    }
    if (opt.description !== undefined && typeof opt.description !== 'string') {
      errors.push(`Element "${id}" (CheckboxGroup) option at index ${i} "description" must be a string`);
    }
  }));
  optionalString(id, 'CheckboxGroup', props, 'hint', errors);
  return errors;
}

function validateActionBarProps(id: string, props: Record<string, any>): string[] {
  const errors: string[] = [];
  optionalEnum(id, 'ActionBar', props, 'align', ['left', 'right', 'between'], errors);
  return errors;
}

function validateButtonProps(id: string, props: Record<string, any>): string[] {
  const errors: string[] = [];
  requireNonEmptyString(id, 'Button', props, 'label', errors);
  optionalEnum(id, 'Button', props, 'variant', ['primary', 'secondary', 'danger'], errors);
  return errors;
}

function validateCalloutProps(id: string, props: Record<string, any>): string[] {
  const errors: string[] = [];
  requireNonEmptyString(id, 'Callout', props, 'content', errors);
  optionalString(id, 'Callout', props, 'title', errors);
  optionalEnum(id, 'Callout', props, 'variant', ['info', 'tip', 'warn', 'error'], errors);
  optionalString(id, 'Callout', props, 'icon', errors);
  optionalBoolean(id, 'Callout', props, 'mono', errors);
  return errors;
}

function validateTabsProps(id: string, props: Record<string, any>): string[] {
  const errors: string[] = [];
  errors.push(...validateItems(id, 'Tabs', props.tabs, 'tabs', (tab, i, errors) => {
    if (!tab || typeof tab.id !== 'string' || typeof tab.label !== 'string') {
      errors.push(`Element "${id}" (Tabs) tab at index ${i} must have string "id" and "label"`);
      return;
    }
    if (tab.icon !== undefined && typeof tab.icon !== 'string') {
      errors.push(`Element "${id}" (Tabs) tab at index ${i} "icon" must be a string`);
    }
  }));
  optionalString(id, 'Tabs', props, 'defaultTab', errors);
  return errors;
}

function validateStepsProps(id: string, props: Record<string, any>): string[] {
  return validateItems(id, 'Steps', props.items, 'items', (step, i, errors) => {
    if (!step || typeof step.title !== 'string' || !step.title.trim()) {
      errors.push(`Element "${id}" (Steps) step at index ${i} must have non-empty string "title"`);
      return;
    }
    if (step.description !== undefined && typeof step.description !== 'string') {
      errors.push(`Element "${id}" (Steps) step at index ${i} "description" must be a string`);
    }
    if (step.status !== undefined && !['done', 'current', 'pending'].includes(step.status)) {
      errors.push(`Element "${id}" (Steps) step at index ${i} "status" must be "done", "current", or "pending"`);
    }
    if (step.icon !== undefined && typeof step.icon !== 'string') {
      errors.push(`Element "${id}" (Steps) step at index ${i} "icon" must be a string`);
    }
    if (step.badge !== undefined && typeof step.badge !== 'string') {
      errors.push(`Element "${id}" (Steps) step at index ${i} "badge" must be a string`);
    }
  });
}

function validateAccordionProps(id: string, props: Record<string, any>): string[] {
  return validateItems(id, 'Accordion', props.items, 'items', (acc, i, errors) => {
    if (!acc || typeof acc.title !== 'string' || !acc.title.trim()) {
      errors.push(`Element "${id}" (Accordion) item at index ${i} must have non-empty string "title"`);
      return;
    }
    if (acc.content !== undefined && typeof acc.content !== 'string') {
      errors.push(`Element "${id}" (Accordion) item at index ${i} "content" must be a string`);
    }
    if (acc.defaultOpen !== undefined && typeof acc.defaultOpen !== 'boolean') {
      errors.push(`Element "${id}" (Accordion) item at index ${i} "defaultOpen" must be a boolean`);
    }
    if (acc.icon !== undefined && typeof acc.icon !== 'string') {
      errors.push(`Element "${id}" (Accordion) item at index ${i} "icon" must be a string`);
    }
    if (acc.badge !== undefined && typeof acc.badge !== 'string') {
      errors.push(`Element "${id}" (Accordion) item at index ${i} "badge" must be a string`);
    }
    if (acc.mono !== undefined && typeof acc.mono !== 'boolean') {
      errors.push(`Element "${id}" (Accordion) item at index ${i} "mono" must be a boolean`);
    }
  });
}

function validateBarListProps(id: string, props: Record<string, any>): string[] {
  const errors: string[] = [];
  errors.push(...validateItems(id, 'BarList', props.items, 'items', (bar, i, errors) => {
    if (!bar || typeof bar.label !== 'string' || typeof bar.value !== 'number' || !Number.isFinite(bar.value)) {
      errors.push(`Element "${id}" (BarList) item at index ${i} must have string "label" and finite number "value"`);
      return;
    }
    if (bar.max !== undefined && (typeof bar.max !== 'number' || !Number.isFinite(bar.max) || bar.max <= 0)) {
      errors.push(`Element "${id}" (BarList) item at index ${i} "max" must be a positive number`);
    }
    if (bar.displayValue !== undefined && typeof bar.displayValue !== 'string') {
      errors.push(`Element "${id}" (BarList) item at index ${i} "displayValue" must be a string`);
    }
    if (bar.color !== undefined && !['blue', 'emerald', 'amber', 'rose', 'purple'].includes(bar.color)) {
      errors.push(`Element "${id}" (BarList) item at index ${i} "color" must be "blue", "emerald", "amber", "rose", or "purple"`);
    }
  }));
  optionalString(id, 'BarList', props, 'title', errors);
  return errors;
}

function validateTableProps(id: string, props: Record<string, any>): string[] {
  const errors: string[] = [];
  if (!Array.isArray(props.columns) || props.columns.length === 0 || props.columns.some((c: unknown) => typeof c !== 'string')) {
    errors.push(`Element "${id}" (Table) requires a non-empty array "columns" prop of strings`);
  }
  optionalString(id, 'Table', props, 'title', errors);
  if (props.monoColumns !== undefined) {
    const monoOk = Array.isArray(props.monoColumns) && props.monoColumns.every((n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0);
    if (!monoOk) {
      errors.push(`Element "${id}" (Table) props.monoColumns must be an array of non-negative integers`);
    } else if (Array.isArray(props.columns)) {
      const colCount = props.columns.length;
      for (const n of props.monoColumns as number[]) {
        if (n >= colCount) {
          errors.push(`Element "${id}" (Table) props.monoColumns index ${n} is out of range (columns: ${colCount})`);
        }
      }
    }
  }
  if (!Array.isArray(props.rows)) {
    errors.push(`Element "${id}" (Table) requires an array "rows" prop`);
  } else if (Array.isArray(props.columns)) {
    const colCount = props.columns.length;
    for (let i = 0; i < props.rows.length; i++) {
      const row = props.rows[i];
      if (!Array.isArray(row) || row.length !== colCount || row.some((cell: unknown) => typeof cell !== 'string')) {
        errors.push(`Element "${id}" (Table) row at index ${i} must be a string array of length ${colCount} matching columns`);
      }
    }
  }
  return errors;
}

const propsValidators: Record<BotdUiComponentType, PropsValidator> = {
  Stack: validateStackProps,
  Card: validateCardProps,
  MetricGrid: validateMetricGridProps,
  MetricCard: validateMetricCardProps,
  KeyValueList: validateKeyValueListProps,
  TextInput: validateTextInputProps,
  Select: validateSelectProps,
  Switch: validateSwitchProps,
  CheckboxGroup: validateCheckboxGroupProps,
  ActionBar: validateActionBarProps,
  Button: validateButtonProps,
  Callout: validateCalloutProps,
  Tabs: validateTabsProps,
  Steps: validateStepsProps,
  Accordion: validateAccordionProps,
  BarList: validateBarListProps,
  Table: validateTableProps,
};

// --- element structure validation (children / slots / on) -------------------

function validateChildren(id: string, el: Record<string, any>, elements: Record<string, any>): string[] {
  const errors: string[] = [];
  if (el.children !== undefined) {
    if (!Array.isArray(el.children)) {
      errors.push(`Element "${id}".children must be an array of strings`);
    } else {
      for (const childId of el.children) {
        if (typeof childId !== 'string') {
          errors.push(`Element "${id}".children contains non-string child ID`);
        } else if (!(childId in elements)) {
          errors.push(`Child "${childId}" referenced by "${id}" does not exist in elements`);
        }
      }
    }
  }
  return errors;
}

function validateSlots(id: string, el: Record<string, any>, elements: Record<string, any>): string[] {
  const errors: string[] = [];
  if (el.slots !== undefined) {
    if (typeof el.slots !== 'object' || el.slots === null || Array.isArray(el.slots)) {
      errors.push(`Element "${id}".slots must be an object`);
    } else {
      for (const [slotName, slotChildren] of Object.entries(el.slots)) {
        if (!Array.isArray(slotChildren)) {
          errors.push(`Element "${id}".slots.${slotName} must be an array of strings`);
        } else {
          for (const childId of slotChildren) {
            if (typeof childId !== 'string') {
              errors.push(`Element "${id}".slots.${slotName} contains non-string child ID`);
            } else if (!(childId in elements)) {
              errors.push(`Child "${childId}" in slot "${slotName}" of "${id}" does not exist in elements`);
            }
          }
        }
      }
    }
  }
  return errors;
}

function validateOn(id: string, el: Record<string, any>): string[] {
  const errors: string[] = [];
  if (el.on !== undefined) {
    if (typeof el.on !== 'object' || el.on === null || Array.isArray(el.on)) {
      errors.push(`Element "${id}".on must be an object`);
    } else {
      for (const [eventKey, actionBinding] of Object.entries(el.on)) {
        if (!actionBinding || typeof actionBinding !== 'object' || Array.isArray(actionBinding)) {
          errors.push(`Element "${id}".on.${eventKey} must be an action object`);
        } else {
          const act = actionBinding as Record<string, any>;
          if (act.action !== 'submit') {
            errors.push(`Unknown action "${act.action}" on element "${id}". Allowed actions: submit`);
          }
          if (
            act.params !== undefined &&
            (typeof act.params !== 'object' || act.params === null || Array.isArray(act.params))
          ) {
            errors.push(`Element "${id}".on.${eventKey}.params must be an object if provided`);
          }
        }
      }
    }
  }
  return errors;
}

/** Tree traversal from root: cycle detection and max depth check. */
function validateTree(root: string, elements: Record<string, any>): string[] {
  const errors: string[] = [];
  const visitedPath = new Set<string>();
  let depthExceeded = false;

  const checkTree = (nodeId: string, depth: number) => {
    if (depth > MAX_UI_TREE_DEPTH) {
      depthExceeded = true;
      return;
    }
    if (visitedPath.has(nodeId)) {
      errors.push(`Cycle detected in UI tree at element "${nodeId}"`);
      return;
    }
    visitedPath.add(nodeId);
    const elem = elements[nodeId];
    if (elem) {
      if (Array.isArray(elem.children)) {
        for (const childId of elem.children) {
          if (typeof childId === 'string' && childId in elements) {
            checkTree(childId, depth + 1);
          }
        }
      }
      if (elem.slots && typeof elem.slots === 'object') {
        for (const slotChildren of Object.values(elem.slots)) {
          if (Array.isArray(slotChildren)) {
            for (const childId of slotChildren) {
              if (typeof childId === 'string' && childId in elements) {
                checkTree(childId, depth + 1);
              }
            }
          }
        }
      }
    }
    visitedPath.delete(nodeId);
  };

  checkTree(root, 1);
  if (depthExceeded) {
    errors.push(`UI tree depth exceeds maximum depth of ${MAX_UI_TREE_DEPTH}`);
  }
  return errors;
}

/** Size limit + JSON parsing: accepts a JSON string or an object, returns a plain object. */
function parseUiSpecInput(input: string | unknown): { ok: true; raw: any } | { ok: false; errors: string[] } {
  let raw: any;
  if (typeof input === 'string') {
    const byteLength = new TextEncoder().encode(input).length;
    if (byteLength > MAX_UI_SPEC_BYTES) {
      return {
        ok: false,
        errors: [`Spec exceeds maximum size of ${MAX_UI_SPEC_BYTES} bytes (actual: ${byteLength})`],
      };
    }
    try {
      raw = JSON.parse(input);
    } catch (err: unknown) {
      return {
        ok: false,
        errors: [`Invalid JSON in UI spec: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  } else if (typeof input === 'object' && input !== null) {
    try {
      const jsonStr = JSON.stringify(input);
      const byteLength = new TextEncoder().encode(jsonStr).length;
      if (byteLength > MAX_UI_SPEC_BYTES) {
        return {
          ok: false,
          errors: [`Spec exceeds maximum size of ${MAX_UI_SPEC_BYTES} bytes (actual: ${byteLength})`],
        };
      }
      raw = JSON.parse(jsonStr);
    } catch (err: unknown) {
      return {
        ok: false,
        errors: [`Failed to serialize UI spec object: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  } else {
    return {
      ok: false,
      errors: ['UI spec must be a JSON object or string'],
    };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['UI spec must be a plain object'] };
  }
  return { ok: true, raw };
}

export function validateUiSpec(input: string | unknown): UiValidationResult {
  const parsed = parseUiSpecInput(input);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors };
  }
  const raw = parsed.raw;

  const errors: string[] = [];

  if (typeof raw.root !== 'string' || !raw.root.trim()) {
    errors.push('UI spec must contain a non-empty string "root" property');
  }

  if (!raw.elements || typeof raw.elements !== 'object' || Array.isArray(raw.elements)) {
    errors.push('UI spec must contain a non-empty "elements" object');
  } else {
    const elemKeys = Object.keys(raw.elements);
    if (elemKeys.length === 0) {
      errors.push('UI spec "elements" object cannot be empty');
    }
    if (elemKeys.length > MAX_UI_ELEMENTS) {
      errors.push(`UI spec element count (${elemKeys.length}) exceeds maximum of ${MAX_UI_ELEMENTS}`);
    }
  }

  if (raw.state !== undefined && (typeof raw.state !== 'object' || raw.state === null || Array.isArray(raw.state))) {
    errors.push('UI spec "state" must be an object if provided');
  }

  // If basic top-level structure failed, return early
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  if (!(raw.root in raw.elements)) {
    errors.push(`Root element "${raw.root}" not found in elements`);
  }

  const allowedTypesStr = BOTD_UI_COMPONENT_TYPES.join(', ');

  for (const [id, elem] of Object.entries(raw.elements)) {
    if (!elem || typeof elem !== 'object' || Array.isArray(elem)) {
      errors.push(`Element "${id}" must be a plain object`);
      continue;
    }
    const el = elem as Record<string, any>;

    const type = (BOTD_UI_COMPONENT_TYPES as readonly string[]).includes(el.type)
      ? (el.type as BotdUiComponentType)
      : undefined;
    if (!type) {
      errors.push(`Unknown component type "${el.type}". Allowed types: ${allowedTypesStr}`);
    }

    errors.push(...validateChildren(id, el, raw.elements));
    errors.push(...validateSlots(id, el, raw.elements));
    errors.push(...validateOn(id, el));

    const props = el.props || {};
    if (typeof props !== 'object' || props === null || Array.isArray(props)) {
      errors.push(`Element "${id}".props must be an object`);
      continue;
    }
    if (type) {
      errors.push(...propsValidators[type](id, props));
    }
  }

  if (raw.root in raw.elements) {
    errors.push(...validateTree(raw.root, raw.elements));
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    spec: raw as BotdUiSpec,
    normalizedJson: JSON.stringify(raw),
  };
}

// --- secret extraction -------------------------------------------------------

/**
 * Extract the state binding paths of every `TextInput` marked `secret: true`.
 *
 * The Hub uses these JSON pointer paths (e.g. `/credentials/password`) to find
 * the plaintext secret fields inside an answered UI form state, stash them
 * into the in-memory SecretStash, and replace the values with
 * `[REDACTED:$BOTD_SECRET_...]` before the answer is persisted or broadcast.
 * Accepts a raw JSON string or an already-parsed spec object; an invalid spec
 * yields no paths (the answer is then treated as non-secret).
 */
export function extractSecretStatePaths(specOrJson: string | BotdUiSpec): string[] {
  let spec: BotdUiSpec | undefined;
  if (typeof specOrJson === 'string') {
    try {
      spec = JSON.parse(specOrJson) as BotdUiSpec;
    } catch {
      return [];
    }
  } else {
    spec = specOrJson;
  }
  if (spec === null || typeof spec !== 'object' || spec.elements === undefined) return [];
  const paths: string[] = [];
  for (const el of Object.values(spec.elements)) {
    if (!el || el.type !== 'TextInput') continue;
    const props = el.props as TextInputElementProps | undefined;
    if (props === null || typeof props !== 'object' || (props as { secret?: unknown }).secret !== true) continue;
    const value = props.value as UiStateBinding | string | undefined;
    if (value === null || typeof value !== 'object') continue;
    const binding = value as { $state?: unknown; $bindState?: unknown };
    if (typeof binding.$state === 'string' && binding.$state) paths.push(binding.$state);
    else if (typeof binding.$bindState === 'string' && binding.$bindState) paths.push(binding.$bindState);
  }
  return [...new Set(paths)];
}
