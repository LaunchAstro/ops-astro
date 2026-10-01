// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859) through the real broker, custody's real process and a stand-in
// runner on loopback: a side-panel message answered by the local session; a
// runner refusal (the cap) released with nothing held; an unattended task run
// carried by the subscription only under the local carve-out, and refused by
// name without it, on any other provider, or for another installation's
// tenant. The runner's planted key never reaches an answer, a row or output.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt, vi } from 'vitest';
import {
  catalogue,
  LOCAL_CLAUDE_COMPOSE,
  LOCAL_CLAUDE_CONVERSATION,
  LOCAL_CLAUDE_PROVIDER,
  localClaudeAdapter,
  localClaudeCostMinor,
  REPLAY_COMPOSE,
} from '../../packages/core-connectors/src/index.ts';
import {
  callModel,
  callModelInConversation,
  type Broker,
  type BrokerRoute,
  type ModelCaller,
} from '../../packages/core-custody/src/index.ts';
import { liveWork, type Work } from '../runtime/schedules-harness.ts';
import {
  CLOUD,
  broker,
  caller,
  noDatabase,
  requestFor,
  rowsOf,
  s,
  stepOf,
  useBrokerWorld,
  world,
} from './broker-world.ts';
import {
  LOCAL_MODEL,
  LOCAL_REPLY,
  SEAT_ACCOUNT,
  startStubRunner,
  type StubRunner,
} from './local-claude-stub.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('la1calls');

const ROUTE: BrokerRoute = {
  key: 'local_claude',
  reach: 'local',
  provider: LOCAL_CLAUDE_PROVIDER,
  credentialRef: 'local_runner',
  credentialKind: 'subscription',
  installation: 'here',
  ceiling: 4,
};

// What carried a settled call is custody's credential: here the runner's own
// loopback key (`api_key`), with the seat as its account. The subscription
// itself stays in Claude Code and is never stored, so the route's kind is what
// `mayCarry` ran on, and the route key names the local seat's route.
let runner: StubRunner;
const output: string[] = [];

beforeAll(async () => {
  if (noDatabase) return;
  runner = await startStubRunner();
  const capture = (chunk: unknown): boolean => {
    output.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await runner?.close();
});

/** The broker as the composition root builds it under `local-claude` on the laptop. */
const local = (overrides: Partial<Broker> = {}): Broker => ({
  ...broker,
  custody: runner.custody,
  operations: catalogue([LOCAL_CLAUDE_COMPOSE, LOCAL_CLAUDE_CONVERSATION]),
  providers: new Map([
    [LOCAL_CLAUDE_PROVIDER, { build: localClaudeAdapter, price: localClaudeCostMinor }],
  ]),
  routes: [ROUTE],
  localOwnerTesting: true,
  ...overrides,
});

const owner = (): ModelCaller => ({
  actorId: s.decider.actorId,
  delegationId: null,
  attendedByPersonId: s.decider.personId,
});

const ask = (message: string) => ({
  conversation: { id: randomUUID(), businessId: s.business, ownerPersonId: s.decider.personId },
  operation: LOCAL_CLAUDE_CONVERSATION.key,
  fields: [{ name: 'message', source: 'outside' as const, value: message }],
});

const conversationRows = async (id: string): Promise<readonly Record<string, unknown>[]> =>
  await s.db.admin.execute(`select * from public.model_calls where conversation_id = $1`, [id]);

/** An unattended task run's model step, as a scheduled job or a task's agent run makes it. */
async function runStep(work: Work, with_: Broker, operation = LOCAL_CLAUDE_COMPOSE.key) {
  await stepOf(work);
  return await callModel(
    s.db.app,
    s.business,
    caller(work),
    requestFor(work, { operation }),
    with_,
  );
}

it('LA-1 side panel: a conversation message is answered by the local session, settled at nothing', async () => {
  runner.mode('answer');
  const before = runner.seen.length;
  const request = ask(`hello ${randomUUID()}`);
  const result = await callModelInConversation(s.db.app, s.business, owner(), request, local());
  expect(result).toMatchObject({
    ok: true,
    text: LOCAL_REPLY,
    reservedMinor: 0,
    actualMinor: 0,
    releasedMinor: 0,
  });
  expect(runner.seen.length).toBe(before + 1);
  const sent = runner.seen.at(-1);
  expect(sent?.path).toBe('/v1/local-claude/complete');
  expect(sent?.authorization).toBe(`Bearer ${runner.canary}`);
  expect(JSON.parse(sent?.body ?? '{}')).toEqual({
    model: 'haiku',
    fields: { message: request.fields[0]?.value },
  });
  const [row, ...more] = await conversationRows(request.conversation.id);
  expect(more).toEqual([]);
  expect(row).toMatchObject({
    state: 'settled',
    route_key: 'local_claude',
    route_reach: 'local',
    credential_kind: 'api_key',
    account: SEAT_ACCOUNT,
    reserved_minor: '0',
  });
}, 60_000);

it('LA-1 cap: a runner at its cap answers LOCAL_CAP_REACHED, and the call is released, nothing held', async () => {
  runner.mode('cap');
  try {
    const request = ask('one more');
    const result = await callModelInConversation(s.db.app, s.business, owner(), request, local());
    expect(result).toMatchObject({ ok: false, code: 'CALL_RELEASED', reason: 'LOCAL_CAP_REACHED' });
    const [row] = await conversationRows(request.conversation.id);
    expect(row).toMatchObject({ state: 'released', reserved_minor: '0' });
  } finally {
    runner.mode('answer');
  }
}, 60_000);

it('LA-1 task run: an unattended step is carried by the subscription under the local carve-out', async () => {
  const work = await liveWork(s, 'la1 unattended local', 2_000);
  const before = runner.seen.length;
  const result = await runStep(work, local());
  expect(result).toMatchObject({ ok: true, text: LOCAL_REPLY, actualMinor: 0 });
  expect(runner.seen.length).toBe(before + 1);
  const rows = await rowsOf(result.ok ? result.callId : null);
  expect(rows).toMatchObject([
    {
      state: 'settled',
      route_key: 'local_claude',
      credential_kind: 'api_key',
      account: SEAT_ACCOUNT,
      model_id: LOCAL_MODEL,
    },
  ]);
}, 120_000);

it.each([
  ['without the carve-out', () => local({ localOwnerTesting: false }), LOCAL_CLAUDE_COMPOSE.key],
  [
    'with the carve-out flag unset',
    (): Broker => {
      const { localOwnerTesting: _unset, ...rest } = local();
      return rest;
    },
    LOCAL_CLAUDE_COMPOSE.key,
  ],
  [
    'on another provider',
    (): Broker => ({
      ...broker,
      routes: [{ ...CLOUD, reach: 'local', credentialKind: 'subscription' }],
      localOwnerTesting: true,
    }),
    REPLAY_COMPOSE.key,
  ],
])(
  'LA-1 task run: an unattended subscription step %s is refused SUBSCRIPTION_UNATTENDED, nothing sent',
  async (_how, with_, operation) => {
    const work = await liveWork(s, 'la1 unattended refused', 2_000);
    const seen = [runner.seen.length, world.provider.seen.length];
    const result = await runStep(work, with_(), operation);
    expect(result).toMatchObject({ ok: false, code: 'SUBSCRIPTION_UNATTENDED' });
    expect([runner.seen.length, world.provider.seen.length]).toEqual(seen);
  },
  120_000,
);

it("LA-1 task run: another installation's tenant is refused under the carve-out, nothing sent", async () => {
  const work = await liveWork(s, 'la1 other tenant', 2_000);
  const seen = runner.seen.length;
  const result = await runStep(work, local({ routes: [{ ...ROUTE, installation: 'there' }] }));
  expect(result).toMatchObject({ ok: false, code: 'SUBSCRIPTION_OTHER_TENANT' });
  expect(runner.seen.length).toBe(seen);
}, 120_000);

it("LA-1 canary: the runner's key never reaches an answer, a row, an audit event or output", async () => {
  runner.mode('answer');
  const work = await liveWork(s, 'la1 canary', 2_000);
  const answers = [
    await callModelInConversation(s.db.app, s.business, owner(), ask('canary check'), local()),
    await runStep(work, local()),
  ];
  expect(answers.map((answer) => answer.ok)).toEqual([true, true]);
  expect(JSON.stringify(answers)).not.toContain(runner.canary);
  const everything = await s.db.admin.execute<{ row: string }>(
    `select row_to_json(m)::text as row from public.model_calls m
     union all select row_to_json(a)::text from public.audit_events a`,
  );
  expect(everything.length).toBeGreaterThan(0);
  expect(everything.map((entry) => entry.row).join('\n')).not.toContain(runner.canary);
  expect(output.join('')).not.toContain(runner.canary);
}, 120_000);
