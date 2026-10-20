// SPDX-License-Identifier: AGPL-3.0-only
//
// #1760 (owner, #804): a grant on a Launch's minting identity counts only
// while it is active, in the grant fingerprint as in the check (#1499). A
// cache keyed by the fingerprint moves when the identity goes dormant.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantFingerprint, issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  delegatingSubjects,
  resolveLiveById,
} from '../../packages/core-records/src/authority/delegations.ts';
import { serverUrl } from '../acceptance/world.ts';
import { aiWorld, assign, created, revisionOf, type AiWorld } from './ai-assign-world.ts';
import { codeOf, type Decider } from './agent-fixture.ts';
import { enrol } from './fixture.ts';

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('fill1760');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

/** A task launched by a fresh person whose only task grants on it sit on their acting identity. */
async function launchedOnActor(): Promise<{ readonly delegation: string; readonly actor: string }> {
  const task = await created(w, w.p, 'Record grants on actor');
  const launcher = await enrol(w.world.db.app, w.world.business, 'launcher-actor');
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    for (const action of ['read', 'comment', 'write', 'assign'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one transaction and connection
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'actor', id: launcher.actorId },
        scope: { kind: 'record', id: task },
        collection: 'task',
        action,
        canDelegate: false,
        parentGrantId: null,
        grantedByActorId: launcher.actorId,
      });
      if (!issued.ok) throw new Error(issued.refusal.code);
    }
  });
  await w.world.db.admin.execute('update public.actors set owner_person_id = $1 where id = $2', [
    launcher.personId,
    w.world.agentActorId,
  ]);
  expect(codeOf(await assign(w, launcher as Decider, task, { agent: w.world.agentActorId }))).toBe(
    'not-a-refusal',
  );
  const launched = await w.world.asPerson(launcher, {
    command: 'task.launch',
    operationId: randomUUID(),
    recordId: task,
    expectedRevision: await revisionOf(w, task),
  });
  expect(codeOf(launched)).toBe('not-a-refusal');
  const [row] = await w.world.db.admin.execute<{ delegation: string; actor: string }>(
    `select d.id as delegation, d.minted_by_actor_id as actor from public.task_launches l
       join public.delegations d on d.id = l.delegation_id where l.task_id = $1`,
    [task],
  );
  if (row === undefined) throw new Error('No Launch');
  return row;
}

describe.skipIf(serverUrl === undefined)('the grant fingerprint over a Launch', () => {
  it("moves when a Launch's launcher identity goes dormant, leaving only the person's grants", async () => {
    const launched = await launchedOnActor();
    const fingerprints = async () =>
      await w.world.db.app.withBusiness(w.world.business, async (tx) => {
        const delegation = await resolveLiveById(tx, w.world.agentActorId, launched.delegation);
        if (delegation === undefined) throw new Error('Launch no longer live');
        const subjects = await delegatingSubjects(tx, delegation);
        const person = subjects.filter((subject) => subject.kind === 'person');
        return {
          launch: await grantFingerprint(tx, subjects),
          person: await grantFingerprint(tx, person),
        };
      });

    const active = await fingerprints();
    expect(active.launch).not.toBe(active.person);
    await w.world.db.admin.execute(
      'update public.actors set active = false, deactivated_at = now() where id = $1',
      [launched.actor],
    );

    const dormant = await fingerprints();
    expect(dormant.launch).not.toBe(active.launch);
    expect(dormant.launch).toBe(dormant.person);
  });
});
