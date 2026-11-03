import type { BotdUiSpec } from '@botd/protocol';

// ---------------------------------------------------------------------------
// Risk approval card (botd ask --risk/--reason/--resource)
// ---------------------------------------------------------------------------

export type AskRiskLevel = 'low' | 'medium' | 'high';

export interface ApprovalCardInput {
  /** Ask prompt; used as the card title and callout fallback content. */
  prompt: string;
  risk?: AskRiskLevel;
  reason?: string;
  resource?: string;
  filePath?: string;
  /** Raw preview text read from --file/--stdin, folded into an Accordion. */
  rawPreview?: string;
  /** Label the Accordion as a diff preview. */
  diffPreview?: boolean;
  /** Quick-reply options rendered as ActionBar buttons. */
  optionList: string[];
}

const APPROVAL_CALLOUT_META: Record<'low' | 'medium' | 'high' | 'none', { variant: 'info' | 'warn' | 'error'; title: string }> = {
  high: { variant: 'error', title: '高风险操作确认' },
  medium: { variant: 'warn', title: '中风险操作确认' },
  low: { variant: 'info', title: '低风险操作确认' },
  none: { variant: 'warn', title: '人工审批确认' },
};

/** Buttons whose label matches these (negative) words render as danger. */
const NEGATIVE_DECISION_RE = /拒绝|取消|中止|reject|cancel|deny/i;

/** Keep the generated spec far below the 64KB UI spec limit. */
const MAX_ACCORDION_PREVIEW_CHARS = 20_000;

function clampAccordionPreview(text: string): string {
  if (text.length <= MAX_ACCORDION_PREVIEW_CHARS) return text;
  return `${text.slice(0, MAX_ACCORDION_PREVIEW_CHARS - 2_000)}\n...(已截断)...\n${text.slice(-1_500)}`;
}

/**
 * Build a botd.v1 Generative UI approval card: Card(Callout, KeyValueList?,
 * Accordion?, ActionBar+Buttons). The result always passes validateUiSpec.
 */
export function buildApprovalCardSpec(input: ApprovalCardInput): BotdUiSpec {
  const calloutMeta = APPROVAL_CALLOUT_META[input.risk ?? 'none'];
  const children: string[] = ['approval_callout'];
  const elements: Record<string, BotdUiSpec['elements'][string]> = {
    approval_card: {
      type: 'Card',
      props: {
        title: input.prompt || '需要人工审批',
        badge: input.risk ? input.risk.toUpperCase() : 'APPROVAL',
        icon: 'shield',
      },
      children,
    },
    approval_callout: {
      type: 'Callout',
      props: {
        title: calloutMeta.title,
        content: input.reason || input.prompt || '需要人工审批',
        variant: calloutMeta.variant,
      },
    },
  };

  const kvItems: { key: string; value: string; mono: true }[] = [];
  if (input.resource) kvItems.push({ key: '目标资源', value: input.resource, mono: true });
  if (input.filePath) kvItems.push({ key: '关联文件', value: input.filePath, mono: true });
  if (kvItems.length > 0) {
    elements.approval_details = { type: 'KeyValueList', props: { items: kvItems } };
    children.push('approval_details');
  }

  if (input.rawPreview && input.rawPreview.trim().length > 0) {
    elements.approval_preview = {
      type: 'Accordion',
      props: {
        items: [
          {
            title: input.diffPreview ? '变更差异预览 (Diff)' : '附加内容预览',
            content: clampAccordionPreview(input.rawPreview),
            defaultOpen: true,
            mono: true,
          },
        ],
      },
    };
    children.push('approval_preview');
  }

  const buttonIds: string[] = [];
  let primaryAssigned = false;
  input.optionList.forEach((opt, idx) => {
    const id = `approval_btn_${idx}`;
    let variant: 'primary' | 'secondary' | 'danger';
    if (NEGATIVE_DECISION_RE.test(opt)) {
      variant = 'danger';
    } else if (!primaryAssigned) {
      variant = 'primary';
      primaryAssigned = true;
    } else {
      variant = 'secondary';
    }
    elements[id] = {
      type: 'Button',
      props: { label: opt, variant },
      on: { press: { action: 'submit', params: { decision: opt } } },
    };
    buttonIds.push(id);
  });
  if (buttonIds.length > 0) {
    elements.approval_actions = { type: 'ActionBar', children: buttonIds };
    children.push('approval_actions');
  }

  return { root: 'approval_card', elements };
}

/**
 * Approval cards return `{ decision, params, state }` JSON from the UI form.
 * Extract the plain decision so `choice=$(botd ask ...)` keeps working;
 * non-JSON answers (quick-reply chips) pass through unchanged.
 */
export function extractApprovalDecision(answer: string): string {
  try {
    const parsed = JSON.parse(answer) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const decision = (parsed as { decision?: unknown }).decision;
      if (typeof decision === 'string' && decision.trim().length > 0) {
        return decision;
      }
    }
  } catch {
    // Not JSON: fall through and return the raw answer.
  }
  return answer;
}
