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
  'ActionBar',
  'Button',
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

export interface ActionBarElementProps {
  align?: 'left' | 'right' | 'between';
}

export interface ButtonElementProps {
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
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

function isStringOrStateBinding(val: unknown): boolean {
  if (typeof val === 'string') return true;
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    return (
      (typeof obj.$state === 'string' && obj.$state.trim().length > 0) ||
      (typeof obj.$bindState === 'string' && obj.$bindState.trim().length > 0)
    );
  }
  return false;
}

function isBooleanOrStateBinding(val: unknown): boolean {
  if (typeof val === 'boolean') return true;
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    return (
      (typeof obj.$state === 'string' && obj.$state.trim().length > 0) ||
      (typeof obj.$bindState === 'string' && obj.$bindState.trim().length > 0)
    );
  }
  return false;
}

export function validateUiSpec(input: string | unknown): UiValidationResult {
  const errors: string[] = [];

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
  if (errors.length > 0 || !raw.elements || typeof raw.elements !== 'object') {
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

    if (typeof el.type !== 'string' || !BOTD_UI_COMPONENT_TYPES.includes(el.type as any)) {
      errors.push(`Unknown component type "${el.type}". Allowed types: ${allowedTypesStr}`);
    }

    if (el.children !== undefined) {
      if (!Array.isArray(el.children)) {
        errors.push(`Element "${id}".children must be an array of strings`);
      } else {
        for (const childId of el.children) {
          if (typeof childId !== 'string') {
            errors.push(`Element "${id}".children contains non-string child ID`);
          } else if (!(childId in raw.elements)) {
            errors.push(`Child "${childId}" referenced by "${id}" does not exist in elements`);
          }
        }
      }
    }

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
              errors.push(
                `Unknown action "${act.action}" on element "${id}". Allowed actions: submit`,
              );
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

    const props = el.props || {};
    if (typeof props !== 'object' || props === null || Array.isArray(props)) {
      errors.push(`Element "${id}".props must be an object`);
      continue;
    }

    switch (el.type) {
      case 'Stack': {
        if (props.direction !== undefined && props.direction !== 'vertical' && props.direction !== 'horizontal') {
          errors.push(`Element "${id}" (Stack) props.direction must be "vertical" or "horizontal"`);
        }
        if (props.gap !== undefined && props.gap !== 'sm' && props.gap !== 'md') {
          errors.push(`Element "${id}" (Stack) props.gap must be "sm" or "md"`);
        }
        break;
      }
      case 'Card': {
        if (typeof props.title !== 'string' || !props.title.trim()) {
          errors.push(`Element "${id}" (Card) requires a non-empty string "title" prop`);
        }
        if (props.subtitle !== undefined && typeof props.subtitle !== 'string') {
          errors.push(`Element "${id}" (Card) props.subtitle must be a string`);
        }
        if (props.badge !== undefined && typeof props.badge !== 'string') {
          errors.push(`Element "${id}" (Card) props.badge must be a string`);
        }
        break;
      }
      case 'MetricGrid': {
        if (props.columns !== undefined && ![2, 3, 4].includes(props.columns)) {
          errors.push(`Element "${id}" (MetricGrid) props.columns must be 2, 3, or 4`);
        }
        break;
      }
      case 'MetricCard': {
        if (typeof props.label !== 'string' || !props.label.trim()) {
          errors.push(`Element "${id}" (MetricCard) requires a non-empty string "label" prop`);
        }
        if (typeof props.value !== 'string') {
          errors.push(`Element "${id}" (MetricCard) requires a string "value" prop`);
        }
        if (props.hint !== undefined && typeof props.hint !== 'string') {
          errors.push(`Element "${id}" (MetricCard) props.hint must be a string`);
        }
        if (props.status !== undefined && !['ok', 'warn', 'error'].includes(props.status)) {
          errors.push(`Element "${id}" (MetricCard) props.status must be "ok", "warn", or "error"`);
        }
        if (props.trend !== undefined && !['up', 'down', 'flat'].includes(props.trend)) {
          errors.push(`Element "${id}" (MetricCard) props.trend must be "up", "down", or "flat"`);
        }
        break;
      }
      case 'KeyValueList': {
        if (!Array.isArray(props.items) || props.items.length === 0) {
          errors.push(`Element "${id}" (KeyValueList) requires a non-empty array "items" prop`);
        } else {
          for (let i = 0; i < props.items.length; i++) {
            const item = props.items[i];
            if (!item || typeof item !== 'object' || typeof item.key !== 'string' || typeof item.value !== 'string') {
              errors.push(`Element "${id}" (KeyValueList) item at index ${i} must have string "key" and "value"`);
            }
            if (item && item.mono !== undefined && typeof item.mono !== 'boolean') {
              errors.push(`Element "${id}" (KeyValueList) item at index ${i} "mono" must be a boolean`);
            }
            if (item && item.badge !== undefined && typeof item.badge !== 'string') {
              errors.push(`Element "${id}" (KeyValueList) item at index ${i} "badge" must be a string`);
            }
          }
        }
        break;
      }
      case 'TextInput': {
        if (typeof props.label !== 'string' || !props.label.trim()) {
          errors.push(`Element "${id}" (TextInput) requires a non-empty string "label" prop`);
        }
        if (props.value !== undefined && !isStringOrStateBinding(props.value)) {
          errors.push(`Element "${id}" (TextInput) props.value must be a string or state binding {"$state": "..."}`);
        }
        if (props.placeholder !== undefined && typeof props.placeholder !== 'string') {
          errors.push(`Element "${id}" (TextInput) props.placeholder must be a string`);
        }
        if (props.hint !== undefined && typeof props.hint !== 'string') {
          errors.push(`Element "${id}" (TextInput) props.hint must be a string`);
        }
        break;
      }
      case 'Select': {
        if (typeof props.label !== 'string' || !props.label.trim()) {
          errors.push(`Element "${id}" (Select) requires a non-empty string "label" prop`);
        }
        if (props.value !== undefined && !isStringOrStateBinding(props.value)) {
          errors.push(`Element "${id}" (Select) props.value must be a string or state binding {"$state": "..."}`);
        }
        if (!Array.isArray(props.options) || props.options.length === 0) {
          errors.push(`Element "${id}" (Select) requires a non-empty array "options" prop`);
        } else {
          for (let i = 0; i < props.options.length; i++) {
            const opt = props.options[i];
            if (!opt || typeof opt !== 'object' || typeof opt.value !== 'string' || typeof opt.label !== 'string') {
              errors.push(`Element "${id}" (Select) option at index ${i} must have string "value" and "label"`);
            }
          }
        }
        break;
      }
      case 'Switch': {
        if (typeof props.label !== 'string' || !props.label.trim()) {
          errors.push(`Element "${id}" (Switch) requires a non-empty string "label" prop`);
        }
        if (props.checked !== undefined && !isBooleanOrStateBinding(props.checked)) {
          errors.push(`Element "${id}" (Switch) props.checked must be a boolean or state binding {"$state": "..."}`);
        }
        if (props.hint !== undefined && typeof props.hint !== 'string') {
          errors.push(`Element "${id}" (Switch) props.hint must be a string`);
        }
        break;
      }
      case 'ActionBar': {
        if (props.align !== undefined && !['left', 'right', 'between'].includes(props.align)) {
          errors.push(`Element "${id}" (ActionBar) props.align must be "left", "right", or "between"`);
        }
        break;
      }
      case 'Button': {
        if (typeof props.label !== 'string' || !props.label.trim()) {
          errors.push(`Element "${id}" (Button) requires a non-empty string "label" prop`);
        }
        if (props.variant !== undefined && !['primary', 'secondary', 'danger'].includes(props.variant)) {
          errors.push(`Element "${id}" (Button) props.variant must be "primary", "secondary", or "danger"`);
        }
        break;
      }
    }
  }

  // Tree traversal: cycle detection and max depth check starting from root
  if (raw.root in raw.elements) {
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
      const elem = raw.elements[nodeId];
      if (elem && Array.isArray(elem.children)) {
        for (const childId of elem.children) {
          if (typeof childId === 'string' && childId in raw.elements) {
            checkTree(childId, depth + 1);
          }
        }
      }
      visitedPath.delete(nodeId);
    };

    checkTree(raw.root, 1);
    if (depthExceeded) {
      errors.push(`UI tree depth exceeds maximum depth of ${MAX_UI_TREE_DEPTH}`);
    }
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

export const BOTD_UI_SCHEMA_DOC = `# botd.v1 Generative UI Spec Schema & Component Catalog

Version: ${BOTD_UI_CATALOG_VERSION}
Max Bytes: ${MAX_UI_SPEC_BYTES} (64KB) | Max Elements: ${MAX_UI_ELEMENTS} | Max Depth: ${MAX_UI_TREE_DEPTH}

## Spec Structure
\`\`\`json
{
  "root": "root-element-id",
  "elements": {
    "root-element-id": {
      "type": "Stack | Card | MetricGrid | MetricCard | KeyValueList | TextInput | Select | Switch | ActionBar | Button",
      "props": { ... },
      "children": ["child-id-1", "child-id-2"],
      "on": {
        "press": {
          "action": "submit",
          "params": { "decision": "approve" }
        }
      }
    }
  },
  "state": {
    "key": "initialValue"
  }
}
\`\`\`

## Component Catalog (10 Components)

1. Stack (Layout container)
   - props: { direction?: "vertical" | "horizontal", gap?: "sm" | "md" }
   - children: string[]

2. Card (Visual grouping card)
   - props: { title: string, subtitle?: string, badge?: string }
   - children: string[]

3. MetricGrid (Responsive metric card container)
   - props: { columns?: 2 | 3 | 4 }
   - children: string[]

4. MetricCard (Key metric display)
   - props: { label: string, value: string, hint?: string, status?: "ok" | "warn" | "error", trend?: "up" | "down" | "flat" }

5. KeyValueList (Compact property-value table)
   - props: { items: Array<{ key: string, value: string, mono?: boolean, badge?: string }> }

6. TextInput (Single-line input)
   - props: { label: string, value?: string | { "$state": "/key" }, placeholder?: string, hint?: string }

7. Select (Dropdown selector)
   - props: { label: string, value?: string | { "$state": "/key" }, options: Array<{ value: string, label: string }> }

8. Switch (Toggle switch)
   - props: { label: string, checked?: boolean | { "$state": "/key" }, hint?: string }

9. ActionBar (Horizontal action button bar)
   - props: { align?: "left" | "right" | "between" }
   - children: string[]

10. Button (Action trigger)
    - props: { label: string, variant?: "primary" | "secondary" | "danger" }
    - on.press: { action: "submit", params?: { decision?: string, [k: string]: unknown } }

## State Binding Syntax
- Bind a form input to the spec store using \`{ "$state": "/key" }\` (or \`{ "$bindState": "/key" }\`).
- When a Button with action "submit" is pressed, the output will be serialized to JSON:
  \`{ decision: params.decision, params, state: currentStoreState }\`
`;
