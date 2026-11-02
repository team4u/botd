import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOrchestrationPlan, extractBotRoutingDirective, ChainBudget } from '../apps/hub/src/group-router.js';
import type { SessionRecord } from '../packages/protocol/src/index.js';

const session = {
  id: 'sess_test', title: 'T', mode: 'lead',
  leadBotId: 'lead', memberBotIds: ['lead', 'a', 'b'],
  status: 'idle', createdAt: '', updatedAt: '',
} as unknown as SessionRecord;

test('parseOrchestrationPlan: parallel group + serial join', () => {
  const items = parseOrchestrationPlan('(@a @b) -> @lead', new Set(['lead', 'a', 'b']), session);
  assert.equal(items.length, 3);
  assert.equal(items[0].parallelGroupId, items[1].parallelGroupId);
  assert.equal(items[0].botId, 'a');
  assert.equal(items[2].botId, 'lead');
  assert.equal(items[2].parallelGroupId, undefined);
});

test('parseOrchestrationPlan: serial pipeline', () => {
  const items = parseOrchestrationPlan('@a -> @b -> @lead', new Set(['lead', 'a', 'b']), session);
  assert.deepEqual(items.map(i => i.botId), ['a', 'b', 'lead']);
  assert.ok(items.every(i => !i.parallelGroupId && !i.loopGroupId && !i.whisperTargetBotIds));
});

test('parseOrchestrationPlan: @all expands to parallel members + lead', () => {
  const items = parseOrchestrationPlan('@all', new Set(['lead', 'a', 'b']), session);
  assert.deepEqual(items.map(i => i.botId), ['a', 'b', 'lead']);
  assert.equal(items[0].parallelGroupId, items[1].parallelGroupId);
  assert.notEqual(items[2].parallelGroupId, items[0].parallelGroupId);
});

test('parseOrchestrationPlan: maker-checker loop with round cap', () => {
  const items = parseOrchestrationPlan('@a <-> @b *3', new Set(['lead', 'a', 'b']), session);
  assert.deepEqual(items.map(i => i.botId), ['a', 'b', 'a', 'b', 'a', 'b']);
  assert.ok(items.every(i => i.loopGroupId === items[0].loopGroupId));
});

test('parseOrchestrationPlan: round count capped at 4', () => {
  const items = parseOrchestrationPlan('@a <-> @b *99', new Set(['lead', 'a', 'b']), session);
  assert.equal(items.length, 8); // 4 rounds × 2 bots
});

test('parseOrchestrationPlan: whisper sub-thread', () => {
  const items = parseOrchestrationPlan('@a >> @b -> @lead', new Set(['lead', 'a', 'b']), session);
  assert.deepEqual(items.map(i => i.botId), ['a', 'b', 'lead']);
  assert.deepEqual(items[0].whisperTargetBotIds, ['a', 'b']);
  assert.deepEqual(items[1].whisperTargetBotIds, ['a', 'b']);
  assert.equal(items[2].whisperTargetBotIds, undefined);
});

test('parseOrchestrationPlan: @none returns empty', () => {
  assert.equal(parseOrchestrationPlan('@none', new Set(['lead']), session).length, 0);
  assert.equal(parseOrchestrationPlan('', new Set(['lead']), session).length, 0);
});

test('parseOrchestrationPlan: unknown bot ids are dropped', () => {
  const items = parseOrchestrationPlan('@ghost -> @lead', new Set(['lead', 'a', 'b']), session);
  assert.deepEqual(items.map(i => i.botId), ['lead']);
});

test('extractBotRoutingDirective: trailing -> line', () => {
  assert.deepEqual(
    extractBotRoutingDirective('分析完成。\n-> (@a @b) -> @lead'),
    { directive: '-> (@a @b) -> @lead', plan: '(@a @b) -> @lead' }
  );
  assert.deepEqual(
    extractBotRoutingDirective('总结\nROUTE: @a -> @lead'),
    { directive: 'ROUTE: @a -> @lead', plan: '@a -> @lead' }
  );
  assert.equal(extractBotRoutingDirective('我认为 @a 说得对'), null);
  assert.deepEqual(extractBotRoutingDirective('-> @none'), { directive: '-> @none', plan: '@none' });
});

test('extractBotRoutingDirective: ignores -> in middle of prose', () => {
  assert.equal(extractBotRoutingDirective('我同意 -> 这个方案\n但还需要验证'), null);
});

test('ChainBudget shared consumption still works', () => {
  const budget = new ChainBudget(2);
  assert.equal(budget.consumeRelay(), true);
  assert.equal(budget.consumeRelay(), true);
  assert.equal(budget.consumeRelay(), false);
});
