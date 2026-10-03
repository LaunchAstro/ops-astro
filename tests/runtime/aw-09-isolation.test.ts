// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-09 isolation`: the review round on agent output reads and changes only
// its own business, client, person and delegation. Each crossing is real and
// has its positive control:
//
// - business to business: another business's decider deciding this output is
//   `NOT_FOUND` in the same bytes as a gate that does not exist, and that
//   decider's own agent output decides;
// - client to client in one business: two clients, one share each; a client
//   reads their own task, is refused the other's in a body that names none of
//   its ids or title, and decides neither gate;
// - person to person: a member without decide is refused; the decider is not;
// - agent under a live delegation: the delegation narrowed to one task cannot
//   revise the other task's lineage, and revises its own.
// The other task's gate, versions and decisions are unchanged by every one.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import {
  asPerson,
  codeOf,
  openSchedules,
  rows,
  seedSchedules,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';
import { decideBody } from './t3a-support.ts';
import { cq8World } from './t2d-harness.ts';
import { agentOutput, agentProposes, type AgentOutput } from './aw-09-agent-round.ts';

const serverUrl = databaseUrlFromEnvironment();
const KINDS = ['approve', 'request_changes', 'reject'] as const;

const at = (output: AgentOutput): Detail => ({ ...output });

/** A body read across never names the other task's ids or title. */
const unseen = (body: unknown, output: AgentOutput, title: string): void => {
  const text = JSON.stringify(body);
  for (const id of [output.taskId, output.lineageId, output.gateId, title]) {
    expect(text).not.toContain(id);
  }
};

// eslint-disable-next-line max-lines-per-function -- four crossings over one shared world
describe.skipIf(serverUrl === undefined)('AW-09 isolation', () => {
  let s: Schedules;
  let other: Schedules;
  let a: Awaited<ReturnType<typeof agentOutput>>;
  let b: Awaited<ReturnType<typeof agentOutput>>;

  beforeAll(async () => {
    s = await openSchedules('aw09_iso', 1_000_000);
    other = await seedSchedules(s.db, 'aw09_iso_other', 1_000_000);
    a = await agentOutput(s, `aw-09 canary A ${crypto.randomUUID()}`);
    b = await agentOutput(s, `aw-09 canary B ${crypto.randomUUID()}`);
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  /** Everything a crossing into B could move: its gates, versions and decisions. */
  const footprint = async (output: AgentOutput) =>
    await rows(
      s,
      `select g.id, g.state, g.round, v.superseded_at is null as live,
              (select count(*)::int from public.gate_decisions d
                where d.business_id = g.business_id and d.gate_id = g.id) as decisions
         from public.gates g
         join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
        where g.business_id = $1 and g.lineage_id = $2 order by g.id`,
      [s.business, output.lineageId],
    );

  it('AW-09 isolation: another business deciding this output is NOT_FOUND in the bytes of no gate, and decides its own', async () => {
    const before = await footprint(b.output);
    const strayed = await asPerson(other, decideBody(at(b.output), 'approve'));
    const nothing = await asPerson(
      other,
      decideBody({ gateId: crypto.randomUUID(), versionId: crypto.randomUUID() }, 'approve'),
    );
    expect(codeOf(strayed)).toBe('NOT_FOUND');
    expect(JSON.stringify(strayed)).toBe(JSON.stringify(nothing));
    unseen(strayed, b.output, b.title);
    expect(await footprint(b.output)).toStrictEqual(before);
    const own = await agentOutput(other);
    expect(codeOf(await asPerson(other, decideBody(at(own.output), 'request_changes')))).toBe(
      'applied',
    );
  });

  it('AW-09 isolation: two clients with one share each read their own task only and decide neither gate', async () => {
    const world = cq8World(s);
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, s.decider, 'share');
    });
    const clientA = await world.client(s.business, s.decider, 'aw09-client-a', a.output.taskId);
    const clientB = await world.client(s.business, s.decider, 'aw09-client-b', b.output.taskId);
    const beforeA = await footprint(a.output);
    const beforeB = await footprint(b.output);
    const readOwn = await world.read(s.business, clientA, {
      read: 'task.read',
      recordId: a.output.taskId,
    });
    expect(isCommandRefusal(readOwn)).toBe(false);
    const readOther = await world.read(s.business, clientA, {
      read: 'task.read',
      recordId: b.output.taskId,
    });
    expect(isCommandRefusal(readOther)).toBe(true);
    unseen(readOther, b.output, b.title);
    for (const [client, own, foreign] of [
      [clientA, a, b],
      [clientB, b, a],
    ] as const) {
      for (const kind of KINDS) {
        // eslint-disable-next-line no-await-in-loop -- one refusal at a time
        const crossed = await world.command(
          s.business,
          client,
          decideBody(at(foreign.output), kind),
        );
        expect(codeOf(crossed)).not.toBe('applied');
        unseen(crossed, foreign.output, foreign.title);
        // eslint-disable-next-line no-await-in-loop -- a client never decides, own gate included
        const onOwn = await world.command(s.business, client, decideBody(at(own.output), kind));
        expect(codeOf(onOwn)).not.toBe('applied');
      }
    }
    expect(await footprint(a.output)).toStrictEqual(beforeA);
    expect(await footprint(b.output)).toStrictEqual(beforeB);
  });

  it('AW-09 isolation: a member without decide is refused and the decider is not', async () => {
    const member = await enrol(s.db.app, s.business, `aw09-member-${crypto.randomUUID()}`);
    await s.db.app.withBusiness(s.business, async (tx) => {
      for (const action of ['read', 'write', 'comment'] as const) {
        // eslint-disable-next-line no-await-in-loop -- `issueGrant` reads the granter's rows
        await grantTo(tx, member, action);
      }
    });
    const fresh = await agentOutput(s);
    const before = await footprint(fresh.output);
    const refused = await cq8World(s).command(
      s.business,
      member,
      decideBody(at(fresh.output), 'approve'),
    );
    expect(codeOf(refused)).toBe('SCOPE_NOT_GRANTED');
    expect(await footprint(fresh.output)).toStrictEqual(before);
    expect(codeOf(await asPerson(s, decideBody(at(fresh.output), 'request_changes')))).toBe(
      'applied',
    );
  });

  it("AW-09 isolation: the agent's delegation on one task cannot revise another task's lineage, and revises its own", async () => {
    const before = await footprint(b.output);
    const crossed = await agentProposes(
      s,
      { ...a.output, taskId: b.output.taskId },
      {
        lineageId: b.output.lineageId,
      },
    );
    expect(codeOf(crossed)).not.toBe('applied');
    unseen(crossed, b.output, b.title);
    expect(await footprint(b.output)).toStrictEqual(before);
    expect(codeOf(await agentProposes(s, a.output, { lineageId: a.output.lineageId }))).toBe(
      'applied',
    );
  });
});
