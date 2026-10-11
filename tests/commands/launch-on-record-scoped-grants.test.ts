// SPDX-License-Identifier: AGPL-3.0-only
//
// Launch asks the launcher's grants where the run will work: on the task, the
// delegation's own purpose scope, and for the subjects the assignment
// envelope counts (the person and their acting identity). A person holding
// read, comment, write and assign on exactly that task, as themselves or on
// their actor, launches their agent; one lacking write on it is still refused,
// writing nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { issueGrant, type Action } from '../../packages/core-records/src/authority/grants.ts';
import { codeOf, type Decider } from './agent-fixture.ts';
import { enrol, type Member } from './fixture.ts';
import {
  aiWorld,
  assign,
  created,
  ownedAgent,
  revisionOf,
  type AiWorld,
} from './ai-assign-world.ts';

const APPLIED = 'not-a-refusal';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('launch-on-record-scoped-grants: DATABASE_URL is unset.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('launchrecord');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

/** A fresh person holding `actions` on one task only, granted to them or to their actor. */
async function boundTo(
  taskId: string,
  actions: readonly Action[],
  on: 'person' | 'actor',
): Promise<Member> {
  const member = await enrol(w.world.db.app, w.world.business, `b-${randomUUID().slice(0, 6)}`);
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    for (const action of actions) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of grants
      const issued = await issueGrant(tx, [], {
        subject:
          on === 'person'
            ? { kind: 'person', id: member.personId }
            : { kind: 'actor', id: member.actorId },
        scope: { kind: 'record', id: taskId },
        collection: 'task',
        action,
        canDelegate: false,
        parentGrantId: null,
        grantedByActorId: member.actorId,
      });
      if (!issued.ok) throw new Error(`fixture: grant refused ${issued.refusal.code}`);
    }
  });
  return member;
}

/** The task with its agent assigned by `by`, then Launch by `by`: the launch's answer. */
async function launchAs(by: Member, taskId: string): Promise<string> {
  const agent = await ownedAgent(w, by);
  expect(codeOf(await assign(w, by as Decider, taskId, { agent }))).toBe(APPLIED);
  return codeOf(
    await w.world.asPerson(by, {
      command: 'task.launch',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(w, taskId),
    }),
  );
}

/** The task's launches, as the delegation each one minted is scoped and held. */
const launches = async (taskId: string) =>
  await w.world.db.admin.execute<{ readonly scope: string; readonly person: string }>(
    `select d.purpose_scope_id::text as scope, d.delegate_person_id::text as person
       from public.task_launches l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where l.task_id = $1 and l.state = 'waiting'`,
    [taskId],
  );

const EVERY: readonly Action[] = ['read', 'comment', 'write', 'assign'];

describe.skipIf(serverUrl === undefined)('Launch on grants held on the task alone', () => {
  it.each(['person', 'actor'] as const)(
    'a launcher holding every grant on the task, on their %s, opens one run limited to it',
    async (on) => {
      const task = await created(w, w.p, `Bounded on the ${on}`);
      const launcher = await boundTo(task, EVERY, on);
      expect(await launchAs(launcher, task)).toBe(APPLIED);
      expect(await launches(task)).toEqual([{ scope: task, person: launcher.personId }]);
    },
  );

  it('a launcher lacking write on the task is refused, and no run opens', async () => {
    const task = await created(w, w.p, 'Missing write');
    const launcher = await boundTo(task, ['read', 'comment', 'assign'], 'person');
    expect(await launchAs(launcher, task)).toBe('DELEGATION_WIDENS');
    expect(await launches(task)).toEqual([]);
  });
});
