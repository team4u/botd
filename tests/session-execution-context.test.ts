import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';

import { TargetDoc } from '../apps/hub/src/harness/docs.js';
import { HubDurableRuntime } from '../apps/hub/src/harness/hub-harness.js';
import { globalSecretStash } from '../apps/hub/src/harness/secret-stash.js';

const run = promisify(execFile);

test('forked workers keep session credentials and worktree ownership while using their own persona model', { timeout: 60_000 }, async () => {
  const repoDir = await mkdtemp(path.join(tmpdir(), 'botd-execution-context-'));
  let runtime: HubDurableRuntime | undefined;
  let secretKey: string | undefined;
  const scopeA = 'session-context-a';
  const scopeB = 'session-context-b';
  try {
    await run('git', ['init', '-q', repoDir]);
    await writeFile(path.join(repoDir, 'README.md'), '# context fixture\n');
    await run('git', ['-C', repoDir, 'add', 'README.md']);
    await run('git', ['-C', repoDir, '-c', 'user.name=botd-test', '-c', 'user.email=botd@test', 'commit', '-qm', 'init']);

    const faux = fauxProvider({ models: [{ id: 'default-model' }, { id: 'parent-override' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models, codemode: false });
    const persona = {
      botId: 'context-bot',
      name: 'Context Bot',
      model: { provider: 'faux', modelId: 'default-model' },
      instructions: 'Run the requested context probe.',
      nodeId: 'local',
      cwd: repoDir,
    };
    runtime.registerPersona(persona);
    const parent = await runtime.ensureBotMainSession(persona.botId);
    await runtime.harness.commit(async (tx) => {
      (await tx.doc(TargetDoc, parent.id)).sessionId = scopeA;
    }, BACKGROUND_CONTEXT);
    await runtime.setConversationModelOverride(String(parent.id), {
      provider: 'faux',
      modelId: 'parent-override',
    });
    secretKey = globalSecretStash.stash('context-credential', scopeA);
    const probeScript = `require("node:fs").writeFileSync("context-probe.json", JSON.stringify({ cwd: process.cwd(), session: process.env.BOTD_SESSION_ID, secret: process.env[${JSON.stringify(secretKey)}] ?? null }))`;
    const command = `node -e '${probeScript}'`;
    faux.setResponses(Array.from({ length: 64 }, () => ((context: { messages: readonly { role: string; content: unknown }[] }) => {
      const reversed = [...context.messages].reverse();
      const userIndex = reversed.findIndex((message) => message.role === 'user');
      const user = reversed[userIndex];
      const hasToolResult = userIndex >= 0 && reversed.slice(0, userIndex).some((message) => message.role === 'toolResult');
      if (typeof user?.content === 'string' && user.content.startsWith('Probe session context') && !hasToolResult) {
        return fauxAssistantMessage([fauxToolCall('bash', { command })], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage('Context probe complete.');
    }) as never));

    await (await runtime.submitUserMessage(String(parent.id), 'Seed the parent conversation.')).wait(BACKGROUND_CONTEXT);
    const spawnProbe = async (scopeId: string) => {
      const spawned = await runtime!.forkSessionToWorker(String(parent.id), {
        botId: persona.botId,
        title: `Context ${scopeId}`,
        task: `Probe session context ${scopeId}`,
        sessionId: scopeId,
        forkContext: true,
        worktree: true,
      });
      await runtime!.harness.waitForIdle(BACKGROUND_CONTEXT);
      const target = await runtime!.harness.snapshot(TargetDoc, spawned.conversation.id, BACKGROUND_CONTEXT);
      assert.ok(target?.worktreePath);
      assert.equal(target.sessionId, scopeId);
      assert.equal(target.modelOverride, undefined, 'a new worker uses its persona model');
      assert.equal((await spawned.conversation.agent(BACKGROUND_CONTEXT)).model?.modelId, 'default-model');
      const probe = JSON.parse(await readFile(path.join(target.worktreePath, 'context-probe.json'), 'utf8')) as {
        cwd: string;
        session: string;
        secret: string | null;
      };
      assert.equal(probe.cwd, target.worktreePath);
      assert.equal(probe.session, scopeId);
      return { ...spawned, probe };
    };

    const workerA = await spawnProbe(scopeA);
    const workerB = await spawnProbe(scopeB);
    assert.equal(workerA.probe.secret, 'context-credential');
    assert.equal(workerB.probe.secret, null, 'another session cannot inherit the credential');
    await assert.rejects(readFile(path.join(repoDir, 'context-probe.json')), { code: 'ENOENT' });

    await runtime.syncPersonas([{ ...persona, instructions: 'Updated instructions.' }]);
    assert.equal((await parent.agent(BACKGROUND_CONTEXT)).model?.modelId, 'parent-override');
    for (const worker of [workerA, workerB]) {
      assert.equal((await worker.conversation.agent(BACKGROUND_CONTEXT)).model?.modelId, 'default-model');
    }
  } finally {
    await runtime?.close();
    if (secretKey !== undefined) globalSecretStash.consume(secretKey, scopeA);
    await rm(repoDir, { recursive: true, force: true });
  }
});
