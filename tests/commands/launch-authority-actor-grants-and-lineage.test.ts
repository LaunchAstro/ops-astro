// SPDX-License-Identifier: AGPL-3.0-only
//
// Launch authority at use: a launch minted on the launcher's task grants,
// held on the person or on their actor, lets its agent propose; and the
// launcher's four-eyes exclusion holds for the proposal made under their
// Launch only, never for another lineage on the task, in the decision and
// the inbox alike. Bodies kept as written for the PR's review. Settings ▸
// Access shows such a Launch with what its agent may do.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { configuredCredentialKeys } from '../../packages/core-records/src/index.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  checkDelegatedAuthority,
  resolveLiveById,
} from '../../packages/core-records/src/authority/delegations.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { aiWorld, assign, created, revisionOf, type AiWorld } from './ai-assign-world.ts';
import { codeOf, type Decider } from './agent-fixture.ts';
import { enrol, grantTo, type Member } from './fixture.ts';

let w: AiWorld;
beforeAll(async () => {
  w = await aiWorld('sol1236');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

async function launch(by: Member, taskId: string) {
  return await w.world.asPerson(by, {
    command: 'task.launch',
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(w, taskId),
  });
}

async function credentialFor(taskId: string) {
  const [row] = await w.world.db.admin.execute<{ id: string; key: string }>(
    `select d.id, d.credential_key_id as key from public.task_launches l
     join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
     where l.task_id = $1 and l.state = 'waiting'`,
    [taskId],
  );
  const keys = configuredCredentialKeys();
  if (row === undefined || !keys.ok) throw new Error('No launch credential');
  const credential = keys.keys.derive(row.key, {
    businessId: w.world.business,
    agentActorId: w.world.agentActorId,
    delegationId: row.id,
  });
  if (credential === undefined) throw new Error('No key');
  return credential;
}

async function proposal(taskId: string) {
  return {
    command: 'task.propose',
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(w, taskId),
    purpose: `sol_${randomUUID().slice(0, 8)}`,
    maximumMinor: 3_000,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
  };
}

const LAUNCH_ACTIONS = ['read', 'comment', 'write', 'assign'] as const;

/** A task launched by a fresh person whose task grants on it are held on `on`. */
async function launchedOn(on: 'person' | 'actor'): Promise<string> {
  const task = await created(w, w.p, `Record grants on ${on}`);
  const launcher = await enrol(w.world.db.app, w.world.business, `launcher-${on}`);
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    for (const action of LAUNCH_ACTIONS) {
      // oxlint-disable-next-line no-await-in-loop -- one transaction and connection
      const issued = await issueGrant(tx, [], {
        subject: { kind: on, id: on === 'person' ? launcher.personId : launcher.actorId },
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
  // Use the fixture's signed-in agent, owned by the launcher as in issue #1225.
  await w.world.db.admin.execute('update public.actors set owner_person_id = $1 where id = $2', [
    launcher.personId,
    w.world.agentActorId,
  ]);
  expect(codeOf(await assign(w, launcher as Decider, task, { agent: w.world.agentActorId }))).toBe(
    'not-a-refusal',
  );
  expect(codeOf(await launch(launcher, task))).toBe('not-a-refusal');
  return task;
}

it.each(['person', 'actor'] as const)(
  'a launch minted on %s-held task grants permits its agent to propose',
  async (on) => {
    const task = await launchedOn(on);
    const answer = await w.world.asAgent(await proposal(task), await credentialFor(task));
    expect(codeOf(answer)).toBe('not-a-refusal');
  },
);

it.each(['person', 'actor'] as const)(
  'Access shows a launch minted on %s-held task grants with what its agent may do',
  async (on) => {
    const task = await launchedOn(on);
    const manager = await enrol(w.world.db.app, w.world.business, `access-${on}`);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, manager, 'manage', undefined, false, 'access');
    });
    const [launched] = await w.world.db.admin.execute<{ id: string }>(
      `select delegation_id as id from public.task_launches where task_id = $1 and state = 'waiting'`,
      [task],
    );
    const answer = await executeRead(w.world.db.app, w.world.business, manager.presented, {
      read: 'access.read',
    });
    if (!('team' in answer)) throw new Error(`access.read refused ${JSON.stringify(answer)}`);
    const shown = answer.agents.find((agent) => agent.delegationId === launched?.id);
    const granted = await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      const delegation = await resolveLiveById(tx, w.world.agentActorId, launched?.id ?? '');
      if (delegation === undefined) throw new Error('the launch delegation is not live');
      const scope = { kind: 'record', id: task } as const;
      const asked = await Promise.all(
        LAUNCH_ACTIONS.map(
          async (action) =>
            (await checkDelegatedAuthority(tx, delegation, { collection: 'task', action, scope }))
              .ok,
        ),
      );
      return LAUNCH_ACTIONS.filter((_, index) => asked[index]);
    });
    expect(granted).not.toHaveLength(0);
    expect(shown?.permissions.map((permission) => permission.action).toSorted()).toStrictEqual(
      [...granted].toSorted(),
    );
    expect(shown?.permissions.every((permission) => permission.scope.id === task)).toBe(true);
  },
);

it.each(['decision', 'inbox'] as const)(
  'launching one pending proposal does not bar another lineage from %s',
  async (through) => {
    const task = await created(w, w.q, 'Two independent lineages');
    await w.world.db.admin.execute('update public.actors set owner_person_id = $1 where id = $2', [
      w.q.personId,
      w.world.agentActorId,
    ]);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, w.p, 'assign', undefined, false, 'agent');
    });
    expect(codeOf(await assign(w, w.q, task, { agent: w.world.agentActorId }))).toBe(
      'not-a-refusal',
    );
    // A launches B's agent and is barred from its first proposal.
    expect(codeOf(await launch(w.p, task))).toBe('not-a-refusal');
    const first = await w.world.asAgent(await proposal(task), await credentialFor(task));
    if (isCommandRefusal(first)) throw new Error(first.code);
    const firstGate = first.detail as { gateId: string; versionId: string };
    expect(
      codeOf(
        await w.world.asPerson(w.p, {
          command: 'task.decide',
          operationId: randomUUID(),
          gateId: firstGate.gateId,
          versionId: firstGate.versionId,
          decision: 'approve',
          note: 'Launcher must not decide their own launch proposal',
        }),
      ),
    ).toBe('FOUR_EYES_REQUIRED');
    // A separate person proposes a separate lineage. A did not launch or propose this work.
    const independent = await w.world.asPerson(w.q, await proposal(task));
    if (isCommandRefusal(independent)) throw new Error(independent.code);
    const independentGate = independent.detail as { gateId: string; versionId: string };
    if (through === 'inbox') {
      const items = await w.world.db.admin.execute<{ person: string }>(
        `select recipient_person_id::text as person from public.inbox_items
       where fact_kind = 'gate' and fact_id = $1 and reason = 'decision' and work_state = 'open'`,
        [independentGate.gateId],
      );
      expect(items.map((item) => item.person)).toContain(w.p.personId);
      return;
    }
    const answer = await w.world.asPerson(w.p, {
      command: 'task.decide',
      operationId: randomUUID(),
      gateId: independentGate.gateId,
      versionId: independentGate.versionId,
      decision: 'approve',
      note: 'Independent reviewer of this person proposal',
    });
    expect(codeOf(answer)).toBe('not-a-refusal');
  },
);
