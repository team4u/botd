import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/react';
import { z } from 'zod';

export const botdUiCatalog = defineCatalog(schema, {
  components: {
    Stack: {
      props: z.object({
        direction: z.enum(['vertical', 'horizontal']).optional(),
        gap: z.enum(['sm', 'md']).optional(),
      }),
      slots: ['default'],
      description: 'Flex layout container for stacking elements vertically or horizontally',
    },
    Card: {
      props: z.object({
        title: z.string(),
        subtitle: z.string().optional(),
        badge: z.string().optional(),
        icon: z.string().optional(),
      }),
      slots: ['default'],
      description: 'Bordered card container with header, subtitle, badge, and icon',
    },
    MetricGrid: {
      props: z.object({
        columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
      }),
      slots: ['default'],
      description: 'Responsive grid layout specifically for metric cards',
    },
    MetricCard: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        hint: z.string().optional(),
        status: z.enum(['ok', 'warn', 'error']).optional(),
        trend: z.enum(['up', 'down', 'flat']).optional(),
        icon: z.string().optional(),
      }),
      slots: [],
      description: 'Key metric display card with optional status dot, trend indicator, and icon',
    },
    KeyValueList: {
      props: z.object({
        items: z.array(
          z.object({
            key: z.string(),
            value: z.string(),
            mono: z.boolean().optional(),
            badge: z.string().optional(),
          }),
        ),
      }),
      slots: [],
      description: 'Compact key-value property list separated by divider lines',
    },
    TextInput: {
      props: z.object({
        label: z.string(),
        value: z.string().optional(),
        placeholder: z.string().optional(),
        hint: z.string().optional(),
        multiline: z.boolean().optional(),
        rows: z.number().int().min(2).max(12).optional(),
        secret: z.boolean().optional(),
      }),
      slots: [],
      description: 'Single-line form input field with label and hint; multiline renders a textarea; secret masks as password',
    },
    Select: {
      props: z.object({
        label: z.string(),
        value: z.string().optional(),
        options: z.array(
          z.object({
            value: z.string(),
            label: z.string(),
          }),
        ),
      }),
      slots: [],
      description: 'Dropdown select form field with options',
    },
    Switch: {
      props: z.object({
        label: z.string(),
        checked: z.boolean().optional(),
        hint: z.string().optional(),
      }),
      slots: [],
      description: 'Compact toggle switch form field',
    },
    CheckboxGroup: {
      props: z.object({
        label: z.string(),
        options: z.array(
          z.object({
            value: z.string(),
            label: z.string(),
            description: z.string().optional(),
          }),
        ),
        value: z.array(z.string()).optional(),
        hint: z.string().optional(),
      }),
      slots: [],
      description: 'Multi-select checkbox group; state binding holds the selected value array',
    },
    ActionBar: {
      props: z.object({
        align: z.enum(['left', 'right', 'between']).optional(),
      }),
      slots: ['default'],
      description: 'Container for aligning interactive action buttons',
    },
    Button: {
      props: z.object({
        label: z.string(),
        variant: z.enum(['primary', 'secondary', 'danger']).optional(),
      }),
      slots: [],
      description: 'Action button that triggers submission or decisions',
    },
    Callout: {
      props: z.object({
        title: z.string().optional(),
        content: z.string(),
        variant: z.enum(['info', 'tip', 'warn', 'error']).optional(),
        icon: z.string().optional(),
        mono: z.boolean().optional(),
      }),
      slots: [],
      description: 'Highlighted note or warning box; mono renders content in monospace',
    },
    Tabs: {
      props: z.object({
        tabs: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            icon: z.string().optional(),
          }),
        ),
        defaultTab: z.string().optional(),
      }),
      slots: ['default'],
      description: 'Segmented switchable view for multi-angle concept explanation',
    },
    Steps: {
      props: z.object({
        items: z.array(
          z.object({
            title: z.string(),
            description: z.string().optional(),
            status: z.enum(['done', 'current', 'pending']).optional(),
            icon: z.string().optional(),
            badge: z.string().optional(),
          }),
        ),
      }),
      slots: [],
      description: 'Vertical timeline or lifecycle flow for algorithms and execution steps',
    },
    Accordion: {
      props: z.object({
        items: z.array(
          z.object({
            title: z.string(),
            content: z.string().optional(),
            defaultOpen: z.boolean().optional(),
            icon: z.string().optional(),
            badge: z.string().optional(),
            mono: z.boolean().optional(),
          }),
        ),
      }),
      slots: [],
      description: 'Progressive disclosure collapsible list; mono renders item content in monospace',
    },
    Table: {
      props: z.object({
        columns: z.array(z.string()),
        rows: z.array(z.array(z.string())),
        monoColumns: z.array(z.number().int().nonnegative()).optional(),
        title: z.string().optional(),
      }),
      slots: [],
      description: 'Simple multi-column data table with optional monospace columns',
    },
    BarList: {
      props: z.object({
        items: z.array(
          z.object({
            label: z.string(),
            value: z.number(),
            max: z.number().optional(),
            displayValue: z.string().optional(),
            color: z.enum(['blue', 'emerald', 'amber', 'rose', 'purple']).optional(),
          }),
        ),
        title: z.string().optional(),
      }),
      slots: [],
      description: 'Horizontal comparison or proportion bars for benchmarks and ratios',
    },
  },
  actions: {
    submit: {
      params: z.object({
        decision: z.string().optional(),
      }).passthrough(),
      description: 'Submit form action with decision and store state',
    },
  },
});

export type BotdUiCatalog = typeof botdUiCatalog;
