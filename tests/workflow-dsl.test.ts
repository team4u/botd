import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractMentions,
  parseSlashCommand,
  buildGroupContextPrompt,
} from '../apps/hub/src/group-router.js';
import type { SessionRecord } from '../packages/protocol/src/index.js';

const session = {
  id: 'sess_test',
  title: 'Direct Session',
  mode: 'direct',
  leadBotId: 'lead',
  memberBotIds: ['lead'],
  status: 'idle',
  createdAt: '',
  updatedAt: '',
} as unknown as SessionRecord;

test('extractMentions: extracts known bots only', () => {
  const valid = new Set(['lead', 'bot_a']);
  const result = extractMentions('Hello @lead and @bot_a and @unknown', valid);
  assert.deepEqual(result, ['lead', 'bot_a']);
});

test('parseSlashCommand: parses slash command for single bot session', () => {
  const valid = new Set(['lead']);
  const res = parseSlashCommand('/review file.txt', valid);
  assert.equal(res.isCommand, true);
  assert.equal(res.commandText, '/review file.txt');
});

test('buildGroupContextPrompt: stripped of blackboard and group orchestration DSL', () => {
  const prompt = buildGroupContextPrompt(session);
  assert.ok(prompt.includes('会话上下文'));
  assert.ok(prompt.includes('单聊模式'));
  assert.equal(prompt.includes('群备忘录'), false);
  assert.equal(prompt.includes('群聊跨 BOT 编排指令'), false);
  assert.equal(prompt.includes('blackboard'), false);
});
