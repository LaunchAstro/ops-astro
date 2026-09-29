// SPDX-License-Identifier: AGPL-3.0-only
//
// T3a, decide authority over the revision loop's controls, over a real
// database through the command entry: approve, reject, restart and cancel are
// refused to a person without `decide` on each surface and to an agent, and
// write nothing; another business's gate and lineage are not found; a person
// whose decide grant is on another task is refused; a client is refused.
// Split out of `t3a-revision-loop.test.ts` under CQ-12's lines; the loop and
// the terminal lineage stay there.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { EntryPoint } from '../../packages/core-records/src/tasks/placement.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  asAgent,
  asPerson,
  codeOf,
  openSchedules,
  propose,
  rows,
  type Body,
  type Schedules,
} from './schedules-harness.ts';
import { cq8World } from './t2d-harness.ts';

import {
  cancelBody,
  decideBody,
  restartBody,
  REVISION,
  SURFACES,
  t3aHarness,
} from './t3a-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/t3a-decide-authority: DATABASE_URL is unset, so nothing below ran.');
}

let s: Schedules;
const { work, settledWork } = t3aHarness(() => s);

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('t3a_authority', 1_000_000);
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

/** Everything a decision, a restart or a cancel could write. */
async function footprint(taskId: string) {
  return await rows<Record<string, unknown>>(
    s,
    `select (select count(*)::int from public.gate_decisions d where d.business_id = $1) as decisions,
            (select count(*)::int from public.proposal_lineages l
              where l.business_id = $1 and l.task_id = $2) as lineages,
            (select string_agg(l.state, ',' order by l.id) from public.proposal_lineages l
              where l.business_id = $1 and l.task_id = $2) as lineage_states,
            (select string_agg(e.state || ':' || e.held_minor || ':' || e.actual_minor, ',' order by e.id)
               from public.task_envelopes e where e.business_id = $1 and e.task_id = $2) as envelopes,
            (select string_agg(g.state, ',' order by g.id) from public.gates g
               join public.proposal_lineages l on l.business_id = g.business_id and l.id = g.lineage_id
              where g.business_id = $1 and l.task_id = $2) as gates`,
    [s.business, taskId],
  );
}

async function writer(scope?: { readonly kind: 'record'; readonly id: string }) {
  const member = await enrol(s.db.app, s.business, `writer-${randomUUID()}`);
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const action of ['read', 'write', 'comment'] as const) {
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, member, action);
    }
    if (scope !== undefined) await grantTo(tx, member, 'decide', scope);
  });
  return member;
}

const as = async (member: Member, surface: EntryPoint, body: Body) =>
  await executeCommand(s.db.app, s.business, member.presented, surface, body as never);

describe.skipIf(serverUrl === undefined)('T3 decide authority', () => {
  it('approve, reject, restart and cancel are refused to a person without decide, on the app, the API and the command line, and write nothing', async () => {
    const { w, lineageId } = await settledWork();
    const pending = await propose(s, w.taskId, { lineageId, maximumMinor: REVISION });
    const noDecide = await writer();
    const before = await footprint(w.taskId);
    for (const surface of SURFACES) {
      for (const body of [
        decideBody(pending, 'approve'),
        decideBody(pending, 'reject'),
        decideBody(pending, 'request_changes'),
        cancelBody(w.taskId, lineageId),
      ]) {
        // eslint-disable-next-line no-await-in-loop
        const code = codeOf(await as(noDecide, surface, body));
        expect({ surface, command: body['command'], decision: body['decision'], code }).toEqual({
          surface,
          command: body['command'],
          decision: body['decision'],
          code: 'SCOPE_NOT_GRANTED',
        });
      }
    }
    expect(await footprint(w.taskId)).toStrictEqual(before);

    // Restart needs a terminal lineage: the decider rejects, the writer tries.
    expect(codeOf(await asPerson(s, decideBody(pending, 'reject')))).toBe('applied');
    const rejected = await footprint(w.taskId);
    for (const surface of SURFACES) {
      // eslint-disable-next-line no-await-in-loop
      const code = codeOf(await as(noDecide, surface, restartBody(w.taskId, lineageId)));
      expect({ surface, code }).toEqual({ surface, code: 'SCOPE_NOT_GRANTED' });
    }
    expect(await footprint(w.taskId)).toStrictEqual(rejected);
  });
});

describe.skipIf(serverUrl === undefined)('T3 decide authority', () => {
  it('each is refused to an agent under its live delegation, and writes nothing', async () => {
    const { w, lineageId } = await settledWork();
    const pending = await propose(s, w.taskId, { lineageId, maximumMinor: REVISION });
    const before = await footprint(w.taskId);
    for (const body of [
      decideBody(pending, 'approve'),
      decideBody(pending, 'reject'),
      decideBody(pending, 'request_changes'),
      cancelBody(w.taskId, lineageId),
      restartBody(w.taskId, lineageId),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const code = codeOf(await asAgent(s, body, w.credential));
      expect({ command: body['command'], code }).not.toMatchObject({ code: 'applied' });
    }
    expect(await footprint(w.taskId)).toStrictEqual(before);
  });

  it('a person whose decide grant is on another task is refused here, and writes nothing', async () => {
    const { w, lineageId } = await settledWork();
    const other = await work();
    const elsewhere = await writer({ kind: 'record', id: other.taskId });
    const pending = await propose(s, w.taskId, { lineageId, maximumMinor: REVISION });
    const before = await footprint(w.taskId);
    for (const body of [
      decideBody(pending, 'approve'),
      decideBody(pending, 'reject'),
      cancelBody(w.taskId, lineageId),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      expect(codeOf(await as(elsewhere, 'api', body))).toBe('SCOPE_NOT_GRANTED');
    }
    expect(await footprint(w.taskId)).toStrictEqual(before);
  });
});

describe.skipIf(serverUrl === undefined)('T3 decide authority', () => {
  it("a client shared on this task, and another task's client, are each refused, and nothing moves", async () => {
    const { w, lineageId } = await settledWork();
    const other = await work();
    const world = cq8World(s);
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, s.decider, 'share');
    });
    const own = await world.client(s.business, s.decider, 't3a-own-client', w.taskId);
    const foreign = await world.client(s.business, s.decider, 't3a-other-client', other.taskId);
    const pending = await propose(s, w.taskId, { lineageId, maximumMinor: REVISION });
    const before = await footprint(w.taskId);
    for (const who of [own, foreign]) {
      for (const body of [
        decideBody(pending, 'approve'),
        decideBody(pending, 'reject'),
        cancelBody(w.taskId, lineageId),
        restartBody(w.taskId, lineageId),
      ]) {
        // eslint-disable-next-line no-await-in-loop
        const result = await as(who, 'api', body);
        expect(codeOf(result)).not.toBe('applied');
        if (who === foreign) expect(JSON.stringify(result)).not.toContain(w.taskId);
      }
    }
    expect(await footprint(w.taskId)).toStrictEqual(before);
  });
});

describe.skipIf(serverUrl === undefined)('T3 decide authority', () => {
  it("another business's gate and lineage are not found, and nothing moves", async () => {
    const { w, lineageId } = await settledWork();
    const pending = await propose(s, w.taskId, { lineageId, maximumMinor: REVISION });
    const foreign = await insertBusiness(s.db.app, `t3a-foreign-${randomUUID()}`);
    await installSpine(s.db.app, foreign);
    const stranger = await enrol(s.db.app, foreign, 'stranger');
    await s.db.app.withBusiness(foreign, async (tx) => {
      for (const action of ['read', 'write', 'decide'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, stranger, action);
      }
      // A cap of its own, so the decision reaches the gate lookup.
      await tx.query(
        `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, $2, 'local', 100000, 'AUD')`,
        [foreign, randomUUID()],
      );
    });
    const before = await footprint(w.taskId);
    for (const body of [
      decideBody(pending, 'approve'),
      decideBody(pending, 'reject'),
      cancelBody(w.taskId, lineageId),
      restartBody(w.taskId, lineageId),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await executeCommand(
        s.db.app,
        foreign as never,
        stranger.presented,
        'api',
        body as never,
      );
      expect(codeOf(result)).toBe('NOT_FOUND');
      expect(JSON.stringify(result)).not.toContain(String(pending['gateId']));
      expect(JSON.stringify(result)).not.toContain(lineageId);
    }
    expect(await footprint(w.taskId)).toStrictEqual(before);
  });
});
