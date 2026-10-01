// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640) on a restart: `task.restart` of a research ticket's ended run is
// a person's start of a run, so it asks what `task.propose` asks there. A
// restarter without `run:write` on the ticket is refused with nothing written;
// one with it leaves the research skill pinned by digest on the new run (one
// `run_definition_pins` row, SKILL.md, as wf-7-pin.test.ts checks for a
// start); a tampered skill refuses the restart with nothing written. On the
// real commands against Postgres.

import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it as vitestIt, vi } from 'vitest';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { InstructionSource } from '../../packages/core-runtime/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approveBody,
  asPerson,
  codeOf,
  freshPurpose,
  openSchedules,
  proposeBody,
  revisionOf,
  type Detail,
  type Schedules,
} from '../runtime/schedules-harness.ts';

/** When set, the research skill's folder serves SKILL.md with one byte added. */
const tamper = vi.hoisted(() => ({ on: false }));

vi.mock('../../packages/core-runtime/src/instruction-root.ts', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../packages/core-runtime/src/instruction-root.ts')>();
  return {
    ...original,
    directorySource: (root: string): InstructionSource => {
      const real = original.directorySource(root);
      if (!root.split(sep).join('/').endsWith('.claude/skills/research')) return real;
      return {
        ...real,
        read: async (path) => {
          const bytes = await real.read(path);
          return tamper.on && path === 'SKILL.md' && bytes !== undefined
            ? new Uint8Array([...bytes, 0x0a])
            : bytes;
        },
      };
    },
  };
});

/** Every case needs the database; without one the file is skipped. */
const noDatabase = databaseUrlFromEnvironment() === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

let s: Schedules;
/** A second person holding decide across the business and no run:write anywhere. */
let other: Member;

beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('wf7restart', 1_000_000);
  other = await enrol(s.db.app, s.business, `wf7restart-${randomUUID()}`);
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, other, action, undefined, true);
    }
  });
}, 180_000);
afterAll(async () => await s?.db.drop());
afterEach(() => {
  tamper.on = false;
});

const as = async (who: Member, body: Readonly<Record<string, unknown>>): Promise<CommandResult> =>
  await executeCommand(s.db.app, s.business, who.presented, 'api', body as never);

/** A research ticket the decider may run, its run started and rejected by the other person. */
const rejectedResearch = async (title: string): Promise<{ ticket: string; lineageId: string }> => {
  const created = await asPerson(s, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title },
    taskType: 'research',
  });
  appliedDetail(created, 'task.create');
  const ticket = String((created as { recordId: string }).recordId);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'write', { kind: 'record', id: ticket }, false, 'run');
  });
  const body = proposeBody(ticket, await revisionOf(s, ticket), { purpose: freshPurpose() });
  const started = appliedDetail(await asPerson(s, body), 'task.propose');
  appliedDetail(await as(other, { ...approveBody(started), decision: 'reject' }), 'task.decide');
  return { ticket, lineageId: String(started['lineageId']) };
};

const restartBody = (ticket: string, lineageId: string) => ({
  command: 'task.restart',
  operationId: randomUUID(),
  recordId: ticket,
  lineageId,
});

const count = async (sql: string, ...params: readonly unknown[]): Promise<number> =>
  (await s.db.admin.execute<{ n: number }>(sql, [s.business, ...params]))[0]?.n ?? 0;

/** What a restart writes: runs and lineages on the ticket, and pins anywhere in the business. */
const written = async (ticket: string) => ({
  runs: await count(
    'select count(*)::int as n from public.planned_runs where business_id = $1 and task_id = $2',
    ticket,
  ),
  lineages: await count(
    'select count(*)::int as n from public.proposal_lineages where business_id = $1 and task_id = $2',
    ticket,
  ),
  pins: await count(
    'select count(*)::int as n from public.run_definition_pins where business_id = $1',
  ),
  revision: await revisionOf(s, ticket),
});

it('WF-7 run started (research): a restart by a person without run:write on the ticket is refused, and nothing is written', async () => {
  const { ticket, lineageId } = await rejectedResearch('wf7 restart without run:write');
  const before = await written(ticket);
  const answer = await as(other, restartBody(ticket, lineageId));
  expect(answer).toMatchObject({ code: 'SCOPE_NOT_GRANTED', names: ['run:write'] });
  expect(await written(ticket)).toStrictEqual(before);
}, 60_000);

it('WF-7 skill pinned by digest: a restart by a person with run:write pins the research skill on the new run', async () => {
  const { ticket, lineageId } = await rejectedResearch('wf7 restart pins');
  const restarted = appliedDetail(
    await asPerson(s, restartBody(ticket, lineageId)),
    'task.restart',
  );
  const rows = await s.db.admin.execute<Record<string, unknown>>(
    `select p.ref_kind, p.path, p.pinned_by_actor_id
       from public.run_definition_pins p
       join public.planned_runs r on r.business_id = p.business_id and r.id = p.run_id
      where p.business_id = $1 and r.version_id = $2`,
    [s.business, (restarted as Detail)['versionId']],
  );
  expect(rows).toEqual([
    { ref_kind: 'bootstrap_file', path: 'SKILL.md', pinned_by_actor_id: s.decider.actorId },
  ]);
}, 60_000);

it('WF-7 skill pinned by digest: a tampered skill refuses the restart, and nothing is written', async () => {
  const { ticket, lineageId } = await rejectedResearch('wf7 restart tampered');
  const before = await written(ticket);
  tamper.on = true;
  expect(codeOf(await asPerson(s, restartBody(ticket, lineageId)))).toBe(
    'DEFINITION_DIGEST_MISMATCH',
  );
  expect(await written(ticket)).toStrictEqual(before);
  // The untouched skill restarts the same lineage, and pins once.
  tamper.on = false;
  appliedDetail(await asPerson(s, restartBody(ticket, lineageId)), 'task.restart');
  expect(await written(ticket)).toMatchObject({
    runs: before.runs + 1,
    lineages: before.lineages + 1,
    pins: before.pins + 1,
  });
}, 60_000);
