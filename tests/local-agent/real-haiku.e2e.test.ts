// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859) end to end on the owner's laptop: the real runner, the real
// `claude` binary on a real seat, Haiku, custody's real process and the real
// broker. A side-panel message answered by the local session, and a task's
// agent run completed by the local tick. Each case makes one real Haiku call
// on the subscription (no money; its API-equivalent cost lands in the ledger),
// so the file runs only when OPS_LOCAL_AGENT_E2E=1 and a database is set. It
// never runs in CI. Made-up words only.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brokerSettings, startModelBroker } from '../../apps/api/model-broker.ts';
import { createRunner, type Runner } from '../../apps/local-agent/runner.ts';
import { readSettings } from '../../apps/local-agent/settings.ts';
import { runQueuedTasks } from '../../apps/local-agent/tick.ts';
import {
  catalogue,
  LOCAL_CLAUDE_COMPOSE,
  LOCAL_CLAUDE_CONVERSATION,
  LOCAL_CLAUDE_PROVIDER,
  localClaudeAdapter,
  localClaudeCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import {
  callModelInConversation,
  startCustody,
  type Broker,
  type BrokerRoute,
  type Custody,
} from '../../packages/core-custody/src/index.ts';
import type { ModelCallExecutor } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { broker as baseBroker, s, useBrokerWorld } from '../broker/broker-world.ts';
import {
  approve,
  createTask,
  freshPurpose,
  openSchedules,
  propose,
  type Schedules,
} from '../runtime/schedules-harness.ts';

const enabled =
  process.env['OPS_LOCAL_AGENT_E2E'] === '1' && databaseUrlFromEnvironment() !== undefined;

const ROUTE: BrokerRoute = {
  key: 'local_claude',
  reach: 'local',
  provider: LOCAL_CLAUDE_PROVIDER,
  credentialRef: 'local_runner',
  credentialKind: 'subscription',
  installation: 'here',
  ceiling: 1,
};

interface Ledgered {
  readonly model: string;
  readonly costUsd: number;
}

interface LocalStack {
  readonly runner: Runner;
  readonly custody: Custody;
  readonly started: Awaited<ReturnType<typeof startModelBroker>>;
}

/** The real runner on a real seat, custody holding its loopback key, and the broker under `local-claude`. */
async function startLocalStack(folder: string, key: string): Promise<LocalStack> {
  const read = readSettings({
    OPS_ENVIRONMENT: 'local',
    OPS_LOCAL_AGENT_SEAT: process.env['OPS_LOCAL_AGENT_SEAT'] ?? 'hey',
    OPS_LOCAL_AGENT_HOME: folder,
    OPS_LOCAL_AGENT_KEY: key,
    PATH: process.env['PATH'],
    USER: process.env['USER'],
  });
  if (!read.ok) throw new Error(read.code);
  const runner = await createRunner(read.settings, () => {});
  const credentialsFile = join(folder, 'credentials.json');
  const credential = {
    ref: 'local_runner',
    kind: 'api_key',
    account: `seat-${read.settings.seat}`,
    destination: 'local_claude',
    header: 'authorization',
    value: key,
  };
  writeFileSync(credentialsFile, JSON.stringify([credential]), { mode: 0o600 });
  const destinations = [{ key: 'local_claude', origin: runner.origin }];
  const custody = await startCustody({ credentialsFile, destinations });
  const settings = brokerSettings({
    OPS_ENVIRONMENT: 'local',
    OPS_AGENT_PROVIDER: 'local-claude',
    MODEL_BROKER_CREDENTIALS_FILE: credentialsFile,
    MODEL_BROKER_DESTINATIONS: JSON.stringify(destinations),
    MODEL_BROKER_ROUTES: JSON.stringify([{ ...ROUTE, ceiling: 2 }]),
    MODEL_BROKER_INSTALLATION: 'here',
  });
  if (settings.kind !== 'configured') throw new Error(`broker: ${settings.kind}`);
  return { runner, custody, started: await startModelBroker(settings) };
}

/** The side panel's broker: custody to the real runner, the local carve-out on. */
const sidePanelBroker = (custody: Custody): Broker => ({
  ...baseBroker,
  custody,
  operations: catalogue([LOCAL_CLAUDE_COMPOSE, LOCAL_CLAUDE_CONVERSATION]),
  providers: new Map([
    [LOCAL_CLAUDE_PROVIDER, { build: localClaudeAdapter, price: localClaudeCostMinor }],
  ]),
  routes: [ROUTE],
  localOwnerTesting: true,
});

/** The owner's own message in their side panel, through the broker to the local session. */
async function askSidePanel(custody: Custody, message: string) {
  const owner = s.decider;
  return await callModelInConversation(
    s.db.app,
    s.business,
    { actorId: owner.actorId, delegationId: null, attendedByPersonId: owner.personId },
    {
      conversation: { id: randomUUID(), businessId: s.business, ownerPersonId: owner.personId },
      operation: LOCAL_CLAUDE_CONVERSATION.key,
      fields: [{ name: 'message', source: 'outside', value: message }],
    },
    sidePanelBroker(custody),
  );
}

/** One local tick over the queued task work, its model step on the local-claude route. */
async function tickTasks(tasks: Schedules, executor: ModelCallExecutor) {
  return await runQueuedTasks({
    environment: { OPS_ENVIRONMENT: 'local' },
    database: tasks.db.app,
    businessId: tasks.business,
    agent: tasks.agent,
    executeModelCall: executor,
    operation: LOCAL_CLAUDE_COMPOSE.key,
    fieldsFor: (entry) => [{ name: 'instruction', from: { recordId: entry.taskId, key: 'title' } }],
  });
}

describe.skipIf(!enabled)('LA-1 end to end on a real seat (Haiku)', () => {
  useBrokerWorld('la1e2e');
  let folder = '';
  const key = randomBytes(24).toString('hex');
  let runner: Runner;
  let custody: Custody;
  let started: Awaited<ReturnType<typeof startModelBroker>>;
  let tasks: Schedules;

  const ledger = (): readonly Ledgered[] =>
    readFileSync(join(folder, 'ledger.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Ledgered);

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'la1-e2e-'));
    ({ runner, custody, started } = await startLocalStack(folder, key));
    tasks = await openSchedules('la1e2etask', 1_000_000);
  }, 180_000);

  afterAll(async () => {
    await started?.stop();
    await custody?.stop();
    await runner?.close();
    await tasks?.db.drop();
    if (folder !== '') rmSync(folder, { recursive: true, force: true });
  });

  it('a side-panel message is answered by the local session on Haiku', async () => {
    const result = await askSidePanel(custody, 'Reply with exactly: side panel ok');
    expect(result).toMatchObject({ ok: true, actualMinor: 0 });
    if (result.ok) expect(result.text.toLowerCase()).toContain('side panel ok');
    expect(ledger().at(-1)?.model).toMatch(/haiku/u);
    expect(ledger().at(-1)?.costUsd).toBeGreaterThan(0);
  }, 180_000);

  it("a task's agent run completes locally through the tick on Haiku", async () => {
    const taskId = await createTask(tasks, 'Reply with exactly: task run ok');
    await approve(
      tasks,
      await propose(tasks, taskId, { maximumMinor: 2_000, purpose: freshPurpose() }),
    );
    const ran = await tickTasks(tasks, started.executor);
    expect(ran.ok).toBe(true);
    if (!ran.ok) return;
    expect(ran.ran.find((r) => r.taskId === taskId)).toMatchObject({ outcome: 'completed' });
    expect(ledger()).toHaveLength(2);
  }, 180_000);
});
