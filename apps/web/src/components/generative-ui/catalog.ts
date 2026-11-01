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
      }),
      slots: ['default'],
      description: 'Bordered card container with header, subtitle, and badge',
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
      }),
      slots: [],
      description: 'Key metric display card with optional status dot and trend indicator',
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
      }),
      slots: [],
      description: 'Single-line form input field with label and hint',
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
