// SPDX-License-Identifier: AGPL-3.0-only
//
// Four eyes asked gate by gate. P owns the agent and directs every agent. A
// pickup's proposal keeps P out after P hands the task to a person. P is
// refused only the gate P's agent proposed, and is named once when also its
// launcher. The board marks a task as awaiting P only when one gate admits P
// on every check task.decide makes: a refused ordinary gate beside an
// escalated gate P lacks the authority for leaves P nothing to decide.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { assignedPeople } from '../../packages/core-records/src/tasks/assignee.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { codeOf, type Decider } from './agent-fixture.ts';
import { grantTo } from './fixture.ts';
import {
  aiWorld,
  agentProposes,
  assign,
  created,
  decide,
  directsEvery,
  launch,
  offeredTo,
  revisionOf,
  type AiWorld,
  type Gate,
} from './ai-assign-world.ts';

const APPLIED = 'not-a-refusal';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('four-eyes-asked-per-gate: DATABASE_URL is unset.');

async function world(): Promise<AiWorld> {
  const w = await aiWorld('foureyespergate');
  await directsEvery(w, w.p);
  await w.world.db.admin.execute('update public.actors set owner_person_id = $1 where id = $2', [
    w.p.personId,
    w.world.agentActorId,
  ]);
  return w;
}

async function boardWait(w: AiWorld, by: Decider, task: string): Promise<boolean> {
  const answer = await executeRead(w.world.db.app, w.world.business, by.presented, {
    read: 'task.board',
    board: null,
  });
  if (isCommandRefusal(answer) || !('tasks' in answer)) throw new Error('board refused');
  const row = answer.tasks.find((taskRow) => taskRow.id === task);
  if (row === undefined) throw new Error('board omitted the readable task');
  return row.awaitingDecision;
}

async function personProposes(w: AiWorld, by: Decider, task: string, lineageId?: string) {
  const answer = await w.world.asPerson(by, {
    command: 'task.propose',
    operationId: randomUUID(),
    recordId: task,
    expectedRevision: await revisionOf(w, task),
    purpose: 'independent_gate',
    maximumMinor: 3_000,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
    ...(lineageId === undefined ? {} : { lineageId }),
  });
  if (isCommandRefusal(answer)) throw new Error(`propose refused ${answer.code}`);
  const detail: unknown = answer.detail;
  if (
    typeof detail !== 'object' ||
    detail === null ||
    !('gateId' in detail) ||
    !('versionId' in detail) ||
    !('lineageId' in detail) ||
    typeof detail.gateId !== 'string' ||
    typeof detail.versionId !== 'string' ||
    typeof detail.lineageId !== 'string'
  )
    throw new Error('invalid proposal answer');
  return { gateId: detail.gateId, versionId: detail.versionId, lineageId: detail.lineageId };
}

async function requestChanges(w: AiWorld, by: Decider, gate: Gate): Promise<void> {
  expect(
    codeOf(
      await w.world.asPerson(by, {
        command: 'task.decide',
        operationId: randomUUID(),
        gateId: gate.gateId,
        versionId: gate.versionId,
        decision: 'request_changes',
        note: 'revise within scope',
      }),
    ),
  ).toBe(APPLIED);
}

it.skipIf(serverUrl === undefined)(
  "a pickup proposal keeps its agent's owner out after the task is handed to a person",
  async () => {
    const w = await world();
    try {
      const r = await w.world.decider('independent reviewer');
      const pickup = await w.world.pickUp(r, 'Pickup owner regression');
      await w.world.db.admin.execute(
        'update public.task_envelopes set maximum_minor = maximum_minor * 2 where task_id = $1',
        [pickup.taskId],
      );
      expect(codeOf(await assign(w, w.p, pickup.taskId, { agent: w.world.agentActorId }))).toBe(
        APPLIED,
      );
      const gate = await agentProposes(w, pickup.taskId, pickup.credential);
      expect(await decide(w, w.p, gate)).toBe('FOUR_EYES_REQUIRED');
      expect(codeOf(await assign(w, w.p, pickup.taskId, { assignee: w.q.personId }))).toBe(APPLIED);
      expect(await offeredTo(w, gate.gateId)).not.toContain(w.p.personId);
      expect(await decide(w, w.p, gate)).toBe('FOUR_EYES_REQUIRED');
      expect(await boardWait(w, w.p, pickup.taskId)).toBe(false);
      expect(await decide(w, r, gate)).toBe(APPLIED);
    } finally {
      await w.world.drop();
    }
  },
);

it.skipIf(serverUrl === undefined)(
  'the owner is refused only the gate their agent proposed, and named once when also its launcher',
  async () => {
    const w = await world();
    try {
      const task = await created(w, w.p, 'Mixed gates');
      expect(codeOf(await assign(w, w.p, task, { agent: w.world.agentActorId }))).toBe(APPLIED);
      expect(await launch(w, w.p, task)).toBe(APPLIED);
      const own = await agentProposes(w, task);
      expect(codeOf(await assign(w, w.p, task, { assignee: w.q.personId }))).toBe(APPLIED);
      const other = await personProposes(w, w.p, task);
      expect(await offeredTo(w, own.gateId)).not.toContain(w.p.personId);
      expect(await offeredTo(w, other.gateId)).toContain(w.p.personId);
      expect(await decide(w, w.p, own)).toBe('FOUR_EYES_REQUIRED');
      expect(await boardWait(w, w.p, task)).toBe(true);
      expect(await decide(w, w.p, other)).toBe(APPLIED);
      expect(await boardWait(w, w.p, task)).toBe(false);
      const excluded = await w.world.db.app.withBusiness(
        w.world.business,
        async (tx) => await assignedPeople(tx, task),
      );
      expect(excluded.filter((id) => id === w.p.personId)).toHaveLength(1);
    } finally {
      await w.world.drop();
    }
  },
);

it.skipIf(serverUrl === undefined)(
  'the board offers no decision when four eyes refuses the ordinary gate and authority the escalated one',
  async () => {
    const w = await world();
    try {
      const r = await w.world.decider('escalation reviewer');
      const task = await created(w, w.p, 'Mixed escalation and ownership');
      expect(codeOf(await assign(w, w.p, task, { agent: w.world.agentActorId }))).toBe(APPLIED);
      await directsEvery(w, r);
      await w.world.db.app.withBusiness(w.world.business, async (tx) => {
        await grantTo(tx, r, 'assign');
      });
      expect(await launch(w, r, task)).toBe(APPLIED);
      const own = await agentProposes(w, task);
      expect(codeOf(await assign(w, w.p, task, { assignee: w.q.personId }))).toBe(APPLIED);
      const v1 = await personProposes(w, r, task);
      await requestChanges(w, r, v1);
      const v2 = await personProposes(w, r, task, v1.lineageId);
      await requestChanges(w, r, v2);
      const v3 = await personProposes(w, r, task, v1.lineageId);
      expect(
        codeOf(
          await w.world.asPerson(r, {
            command: 'task.decide',
            operationId: randomUUID(),
            gateId: v3.gateId,
            versionId: v3.versionId,
            decision: 'escalate',
            recipientPersonId: r.personId,
            note: 'two revision rounds exhausted',
          }),
        ),
      ).toBe(APPLIED);
      await w.world.revokeGrant(w.p.grants.decide);
      await w.world.db.app.withBusiness(w.world.business, async (tx) => {
        await grantTo(tx, w.p, 'decide', { kind: 'record', id: task });
      });
      expect(await decide(w, w.p, own)).toBe('FOUR_EYES_REQUIRED');
      expect(await decide(w, w.p, v3)).toBe('SCOPE_NOT_GRANTED');
      const pending = await executeRead(w.world.db.app, w.world.business, w.p.presented, {
        read: 'gate.pending',
      });
      if (isCommandRefusal(pending) || !('awaiting' in pending))
        throw new Error('pending read refused');
      expect(pending.awaiting.filter((row) => row.taskId === task)).toHaveLength(0);
      expect(await boardWait(w, w.p, task)).toBe(false);
    } finally {
      await w.world.drop();
    }
  },
);
