// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640) on its own broker operation (ORCH47 ruling (b)8): a research
// run's model call is `model.research_compose`, catalogued in the API's
// broker beside the conversation's, its question bound to the run's own
// ticket. Three of the ticket's lines ride on it: `WF-7 holds no credential`,
// `WF-7 canary` and `WF-7 hostile provider`. The run is wf-7-egress's: a
// research ticket charted on a map, started by a person holding `run:write`,
// approved by another, picked up by the agent. `WF-7 skill pinned by digest`
// is `wf-7-pin.test.ts`.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt, vi } from 'vitest';
import { BROKER_OPERATIONS } from '../../apps/api/model-broker.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { RESEARCH_COMPOSE, type ReplayMode } from '../../packages/core-connectors/src/index.ts';
import type { Broker, ModelCallField } from '../../packages/core-custody/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approveBody,
  asPerson,
  freshPurpose,
  pickup,
  propose,
  type Work,
} from '../runtime/schedules-harness.ts';
import {
  broker,
  CLOUD,
  call,
  noDatabase,
  rowsOf,
  s,
  useBrokerWorld,
  world,
} from '../broker/broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('wf7research');

/** The API's own catalogue, so a research call reaches only what ships. */
const research = (): Broker => ({ ...broker, operations: BROKER_OPERATIONS, routes: [CLOUD] });

/** The question, bound to the run's own ticket's title: the one source the broker finds (S3). */
const question = (work: Work): readonly ModelCallField[] => [
  { name: 'question', from: { recordId: work.taskId, key: 'title' } },
];

const ask = async (work: Work, overrides: Record<string, unknown> = {}) =>
  await call(
    work,
    { operation: RESEARCH_COMPOSE.key, fields: question(work), ...overrides },
    research(),
  );

let approver: Member | undefined;
/** Each run's ticket, to the map it was charted on. */
const mapOf = new Map<string, string>();

/** A research ticket charted on a map, run: started, approved by a second person, picked up. */
async function researchRun(title: string, maximumMinor = 2_000): Promise<Work> {
  const charted = await asPerson(s, {
    command: 'map.chart',
    operationId: randomUUID(),
    title: `map for ${title}`,
    tickets: [{ ref: 'r1', title, type: 'research' }],
  });
  const ticket = String(
    (appliedDetail(charted, 'map.chart')['tickets'] as Record<string, string>)['r1'],
  );
  mapOf.set(ticket, String((charted as { recordId: string }).recordId));
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'write', { kind: 'record', id: ticket }, false, 'run');
  });
  if (approver === undefined) {
    const member = await enrol(s.db.app, s.business, 'wf7r-approver');
    await s.db.app.withBusiness(s.business, async (tx) => {
      for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, member, action, undefined, true);
      }
    });
    approver = member;
  }
  const proposal = await propose(s, ticket, { maximumMinor, purpose: freshPurpose() });
  const decision = appliedDetail(
    await executeCommand(
      s.db.app,
      s.business,
      approver.presented,
      'api',
      approveBody(proposal) as never,
    ),
    'task.decide',
  );
  const picked = await pickup(s, decision['reservationId']);
  return { taskId: ticket, proposal, decision, picked };
}

/** Every row the run's call could leave behind, as text. */
const leftBehind = async (): Promise<readonly string[]> =>
  (
    await s.db.admin.execute<{ readonly row: string }>(
      `select row_to_json(a)::text as row from public.audit_events a
       union all select row_to_json(r)::text from public.operations r
       union all select row_to_json(m)::text from public.model_calls m
       union all select row_to_json(l)::text from public.leases l`,
    )
  ).map((row) => row.row);

it('WF-7 holds no credential: the research call goes through its catalogued operation, the key stays in custody, and an echoed key comes back redacted', async () => {
  const work = await researchRun('which suppliers ship to Townsville?');
  world.provider.mode('answer');
  const answered = await ask(work);
  expect(answered).toMatchObject({ ok: true, text: 'Drafted.' });
  const sent = world.provider.seen.at(-1);
  expect(sent?.authorization).toContain(world.canary);
  expect(sent?.body).not.toContain(world.canary);
  expect(JSON.parse(String(sent?.body))).toMatchObject({
    fields: { question: 'which suppliers ship to Townsville?' },
  });

  world.provider.mode('echo_credential');
  try {
    const echoed = await ask(work);
    expect(echoed.ok).toBe(true);
    expect(JSON.stringify(echoed)).not.toContain(world.canary);
    expect(JSON.stringify(echoed)).toContain('[redacted]');
  } finally {
    world.provider.mode('answer');
  }

  // Outside reading is a catalogued operation or nothing: no other name, no undeclared field.
  const seen = world.provider.seen.length;
  expect(await ask(work, { operation: 'model.fetch_url' })).toMatchObject({
    ok: false,
    code: 'OPERATION_NOT_CATALOGUED',
  });
  expect(
    await ask(work, {
      fields: [
        ...question(work),
        { name: 'credential', from: { recordId: work.taskId, key: 'title' } },
      ],
    }),
  ).toMatchObject({ ok: false });
  expect(world.provider.seen.length).toBe(seen);
  for (const text of await leftBehind()) expect(text).not.toContain(world.canary);
  expect(world.custody.stderr()).not.toContain(world.canary);
});

it("WF-7 canary: the ticket's words reach the provider as the question and nowhere else, and a planted answer reaches no row or log", async () => {
  const canary = `CANARY-${randomUUID()}`;
  const work = await researchRun(`${canary} what is decided?`);
  const said: string[] = [];
  const heard = (...parts: unknown[]): void => {
    said.push(parts.map(String).join(' '));
  };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(heard),
    vi.spyOn(console, 'warn').mockImplementation(heard),
    vi.spyOn(console, 'error').mockImplementation(heard),
  ];
  world.provider.mode('planted');
  let planted = '';
  try {
    const answered = await ask(work);
    expect(answered.ok).toBe(true);
    planted = answered.ok ? answered.text : '';
    expect(planted.length).toBeGreaterThan(0);
  } finally {
    world.provider.mode('answer');
    for (const spy of spies) spy.mockRestore();
  }
  expect(world.provider.seen.at(-1)?.body).toContain(canary);
  for (const text of [...(await leftBehind()), ...said, world.custody.stderr()]) {
    expect(text).not.toContain(canary);
    expect(text).not.toContain(planted);
  }
  // Beyond the approved context: the question bound to the map, not the run's ticket, is refused unsent.
  const seen = world.provider.seen.length;
  const map = String(mapOf.get(work.taskId));
  expect(
    await ask(work, { fields: [{ name: 'question', from: { recordId: map, key: 'title' } }] }),
  ).toMatchObject({ ok: false });
  expect(world.provider.seen.length).toBe(seen);
});

const HOSTILE: readonly ReplayMode[] = [
  'oversized',
  'redirect',
  'malformed',
  'bad_model',
  'slow',
  'costly',
];

it('WF-7 hostile provider: a hostile answer to a research call is held at its maximum and recorded, and hands the run no text', async () => {
  const work = await researchRun('is the hostile answer refused?', 5_000);
  try {
    for (const mode of HOSTILE) {
      world.provider.mode(mode);
      // oxlint-disable-next-line no-await-in-loop
      const result = await ask(work);
      expect(result, mode).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN' });
      expect(result, mode).not.toHaveProperty('text');
      // oxlint-disable-next-line no-await-in-loop
      const [row] = await rowsOf(result.ok ? null : result.callId);
      expect(row, mode).toMatchObject({
        state: 'liability_unknown',
        operation_key: RESEARCH_COMPOSE.key,
        reserved_minor: String(RESEARCH_COMPOSE.maximumMinor),
        actual_minor: null,
      });
    }
  } finally {
    world.provider.mode('answer');
  }
});
