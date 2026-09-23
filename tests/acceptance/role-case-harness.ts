// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the role-and-case matrix is driven against, and everything the
// cases ask it.
//
// Three files rather than one, for T1h's reason: the per-file cap is 400
// changed lines, no waiver lifts it, and the repository's answer is to split
// the file rather than the change or the comments. The seams are real ones —
// `role-case-ledger.ts` knows only about rows, `role-case-bodies.ts` knows
// only about tasks, and this knows about callers — so
// `role-case-matrix.test.ts` is left reading as the cases themselves.
//
// **What this file is careful not to be.** It is not a second world. Every
// call goes through `world.ts`'s `call` against the real Hono application, and
// what this adds is the identities each case needs and the setup a real
// deployment already has. It substitutes nothing below the boundary.

import { randomUUID } from 'node:crypto';
import {
  COMMAND_SURFACE,
  pathOf,
  type CommandDeclaration,
  type CommandName,
} from '../../packages/core-records/src/commands/surface.ts';
import {
  issueGrant,
  revokeGrant,
  type Action,
} from '../../packages/core-records/src/authority/grants.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { DELEGATION_HEADER } from '../../apps/api/app.ts';
import {
  agentPath,
  bearer,
  call,
  createWorld,
  personPath,
  type Answer,
  type Caller,
  type World,
} from './world.ts';
import { PROPOSAL, createPositiveBody, type Prepared, type Task } from './role-case-bodies.ts';

/**
 * The grant pair a declaration is actually checked against.
 *
 * `preset.plan` is the one declaration whose collection is not the grant it
 * needs: `reads/dispatch.ts` checks `manage` on the family the request names,
 * not on a blanket `preset` collection, because a blanket holder would be
 * admitted to every installed type and the legitimate manager of the task
 * family refused. Everything else takes its own collection.
 */
export const pairFor = (declaration: CommandDeclaration): string =>
  `${declaration.name === 'preset.plan' ? 'task' : declaration.collection}:${declaration.action}`;

export interface Harness {
  readonly world: World;
  /** A live alpha task and a live bravo record, for the cases that need a real id. */
  readonly alphaTask: Task;
  readonly bravoRecordId: string;
  /** Who holds what, read back from `grants` rather than from the fixture's list. */
  readonly heldBy: ReadonlyMap<string, ReadonlySet<string>>;
  /** Everyone but the admin, in the order case (e) sweeps them. */
  readonly otherCallers: readonly Caller[];
  /** The grant pair a declaration is actually checked against. */
  pairFor(declaration: CommandDeclaration): string;
  asPerson(
    name: CommandName,
    body: Readonly<Record<string, unknown>>,
    businessKey?: string,
    caller?: { readonly token: string },
  ): Promise<Answer>;
  asAgent(
    name: CommandName,
    body: Readonly<Record<string, unknown>>,
    credential?: string,
  ): Promise<Answer>;
  freshTask(title: string): Promise<Task>;
  probeBody(declaration: CommandDeclaration): Readonly<Record<string, unknown>>;
  positiveBody(declaration: CommandDeclaration): Promise<Prepared>;
  approvedReservation(): Promise<{ subject: Task; sibling: Task; decided: Answer }>;
  revokeTaskRead(personId: string): Promise<number>;
  activeRoleKeys(): Promise<readonly string[]>;
  writeBothComments(taskId: string): Promise<readonly Answer[]>;
  close(): Promise<void>;
}

/**
 * Build the world and everything the cases ask it.
 *
 * Two things are set up here that `world.ts` does not do and a real deployment
 * does. `installBusinessSettings` is run, which `scripts/local-seed.mjs` runs
 * and `installTaskSpine` does not — without it both `settings.*` commands
 * answer `NOT_FOUND` for a reason that has nothing to do with authority, so two
 * positive controls would have measured the fixture rather than the product.
 * And the admin's grants are compared with the (collection, action) pairs the
 * surface declares, with anything missing issued through the real `issueGrant`
 * and printed: a fixture narrower than the surface records missing positive
 * controls as product failures, and a top-up nobody can see hides the same gap
 * from the other side. As of this run the printed list is empty, because
 * `world.ts` grants the admin all four collections.
 */
// eslint-disable-next-line max-lines-per-function -- one world, built in one place
export async function createHarness(part: string): Promise<Harness> {
  const world = await createWorld(part);
  await world.db.app.withBusiness(world.alpha, installBusinessSettings);

  const needed = new Map(COMMAND_SURFACE.map((one) => [pairFor(one), one]));
  const heldBy = new Map<string, ReadonlySet<string>>();
  const added: string[] = [];

  await world.db.app.withBusiness(world.alpha, async (tx) => {
    // Read back rather than copied from the fixture's own list of actions: the
    // cases decide what to expect from what a person really holds, so a list
    // that drifted from the rows would quietly change what is proved.
    for (const caller of [world.ada, world.mia, world.noah] as readonly Caller[]) {
      // eslint-disable-next-line no-await-in-loop -- one caller at a time reads as a list
      const grants = await tx.query<{ readonly collection: string; readonly action: string }>(
        `select collection, action from public.grants
          where subject_kind = 'person' and subject_id = $1 and revoked_at is null`,
        [caller.personId],
      );
      heldBy.set(caller.name, new Set(grants.map((row) => `${row.collection}:${row.action}`)));
    }
    const adaHolds = heldBy.get('ada') as ReadonlySet<string>;
    for (const [pair, declaration] of needed) {
      if (adaHolds.has(pair)) continue;
      const [collection, action] = pair.split(':');
      // eslint-disable-next-line no-await-in-loop
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: world.ada.personId as string },
        scope: { kind: 'business', id: null },
        collection: collection as string,
        action: action as Action,
        parentGrantId: null,
        grantedByActorId: world.ada.actorId as string,
      });
      if (!issued.ok) throw new Error(`matrix: grant ${pair} refused ${issued.refusal.code}`);
      added.push(`${pair} (${declaration.name})`);
    }
    heldBy.set('ada', new Set(needed.keys()));
  });
  console.log(
    `matrix: admin grants the surface needs and the world does not seed: ${
      added.length === 0 ? 'none' : added.join(', ')
    }`,
  );

  async function asPerson(
    name: CommandName,
    body: Readonly<Record<string, unknown>>,
    businessKey = 'alpha',
    caller: { readonly token: string } = world.ada,
  ): Promise<Answer> {
    return await call(
      world.api,
      personPath(businessKey, pathOf(name)),
      { operationId: randomUUID(), ...body },
      bearer(caller.token),
    );
  }

  /** The agent's own prefix. The credential travels in a header, never a field. */
  async function asAgent(
    name: CommandName,
    body: Readonly<Record<string, unknown>>,
    credential?: string,
  ): Promise<Answer> {
    return await call(
      world.api,
      agentPath('alpha', pathOf(name)),
      { operationId: randomUUID(), ...body },
      credential === undefined
        ? bearer(world.agent.token)
        : { ...bearer(world.agent.token), [DELEGATION_HEADER]: credential },
    );
  }

  async function freshTask(title: string): Promise<Task> {
    const created = await asPerson('task.create', { fields: { title } });
    if (created.code !== 'ok') throw new Error(`matrix: task.create refused ${created.code}`);
    return { id: String(created.body['recordId']), revision: Number(created.body['revision']) };
  }

  /**
   * The revision a record is actually at, read on the administrative
   * connection.
   *
   * Not carried over from the last answer: a comment moves the task's revision,
   * so a second write reusing the first one's would be refused `VERSION_STALE`
   * for doing the honest thing. Reading it keeps the case about what it is
   * about, and optimistic concurrency is proved in `lost-update`.
   */
  async function revisionOf(recordId: string): Promise<number> {
    const rows = await world.db.admin.execute<{ readonly revision: string }>(
      `select revision::text as revision from public.records where business_id = $1 and id = $2`,
      [world.alpha, recordId],
    );
    return Number(rows[0]?.revision ?? '0');
  }

  const alphaTask = await freshTask('a task every case can name');
  const inBravo = await asPerson('task.create', { fields: { title: 'a bravo task' } }, 'bravo', {
    token: world.bea.token,
  });
  const bravoRecordId = String(inBravo.body['recordId']);

  /**
   * The least a caller can send and still be asking the operation its own
   * question, for the cases whose answer arrives before the body is read.
   *
   * `recordId` is sent only where the declaration targets a record, because
   * `prepare.ts` refuses an identifier on a command that has no use for one —
   * `COMMAND_BODY_INVALID`, and before the authority check — so a body that was
   * uniform across the table would have measured that refusal rather than the
   * authority one the case is about.
   */
  function probeBody(declaration: CommandDeclaration): Readonly<Record<string, unknown>> {
    const targeted = declaration.targetsExistingRecord;
    return {
      operationId: randomUUID(),
      ...(targeted || declaration.name === 'task.read' ? { recordId: alphaTask.id } : {}),
      ...(targeted ? { expectedRevision: alphaTask.revision } : {}),
      ...(declaration.name === 'task.board' ? { board: null } : {}),
      ...(declaration.name === 'preset.plan'
        ? { recordTypeKey: 'task', presetKey: 'acceptance', fields: [] }
        : {}),
    };
  }

  /**
   * A task an agent may pick up, and a sibling it may not touch, with the
   * person's own decision returned so the case can record it as the control.
   *
   * The two tasks are made together because the one-task ceiling is only
   * observable against a second task the delegating person can see perfectly
   * well: without the sibling, "the agent is refused" and "there is nothing
   * else there" look the same.
   */
  async function approvedReservation(): Promise<{
    subject: Task;
    sibling: Task;
    decided: Answer;
  }> {
    const subject = await freshTask('the one task this delegation is for');
    const sibling = await freshTask('a sibling the agent may not reach');
    const proposed = await asPerson('task.propose', {
      recordId: subject.id,
      expectedRevision: subject.revision,
      ...PROPOSAL,
    });
    const gate = proposed.body['detail'] as Record<string, string>;
    const decided = await asPerson('task.decide', {
      gateId: gate['gateId'],
      versionId: gate['versionId'],
      decision: 'approve',
      note: 'approved so an agent can work it',
    });
    return { subject, sibling, decided };
  }

  /**
   * Take a person's `task:read` back, through the boundary that owns it.
   *
   * `revokeGrant` writes a timestamp: there is no delete path and the
   * application role holds no DELETE, because a trail that can be amended is
   * not a trail. It returns how many rows it took so a case can assert it
   * revoked something rather than silently revoking nothing.
   */
  async function revokeTaskRead(personId: string): Promise<number> {
    return await world.db.app.withBusiness(world.alpha, async (tx) => {
      const held = await tx.query<{ readonly id: string }>(
        `select id from public.grants
          where subject_kind = 'person' and subject_id = $1 and collection = 'task'
            and action = 'read' and revoked_at is null`,
        [personId],
      );
      for (const grant of held) {
        // eslint-disable-next-line no-await-in-loop
        await revokeGrant(tx, grant.id);
      }
      return held.length;
    });
  }

  /** Every role this business's active memberships carry, for the I09 gap. */
  async function activeRoleKeys(): Promise<readonly string[]> {
    return await world.db.app.withBusiness(world.alpha, async (tx) => {
      const rows = await tx.query<{ readonly role_key: string }>(
        `select distinct role_key from public.memberships where active`,
      );
      return rows.map((row) => row.role_key);
    });
  }

  /** One internal note and one addressed to the client, on the same task. */
  async function writeBothComments(taskId: string): Promise<readonly Answer[]> {
    const written: Answer[] = [];
    for (const comment of [
      { body: 'an internal note the client must never see', audience: 'internal' },
      { body: 'a note addressed to the client', audience: 'client', commentType: 'client' },
    ]) {
      written.push(
        // eslint-disable-next-line no-await-in-loop -- the revision moves with each one
        await asPerson('task.comment', {
          recordId: taskId,
          // eslint-disable-next-line no-await-in-loop
          expectedRevision: await revisionOf(taskId),
          ...comment,
        }),
      );
    }
    return written;
  }

  return {
    world,
    alphaTask,
    bravoRecordId,
    heldBy,
    otherCallers: [world.noah, world.mia, world.orphan, world.bea],
    pairFor,
    asPerson,
    asAgent,
    freshTask,
    probeBody,
    positiveBody: createPositiveBody({
      alphaTaskId: alphaTask.id,
      assigneePersonId: world.mia.personId as string,
      asPerson: async (name, body) => await asPerson(name, body),
      freshTask,
    }),
    approvedReservation,
    revokeTaskRead,
    activeRoleKeys,
    writeBothComments,
    close: async () => {
      await world.close();
    },
  };
}
