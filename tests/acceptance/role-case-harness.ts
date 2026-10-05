// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the role-and-case matrix is driven against, and everything the
// cases ask it.
//
// Three files rather than one, for T1h's reason: about 400 lines is the
// guide for a readable file, and the repository's answer is to split the
// file rather than the change or the comments. The seams are real ones —
// `role-case-ledger.ts` knows only about rows, `role-case-bodies.ts` (with
// `role-case-positive-body.ts`) knows only about tasks, and this (with its
// shape in `role-case-harness-shape.ts`) knows about callers — so
// `role-case-matrix.test.ts` is left reading as the cases themselves.
//
// **What this file is careful not to be.** It is not a second world. Every
// call goes through `world.ts`'s `call` against the real Hono application, and
// what this adds is the identities each case needs and the setup a real
// deployment already has. It substitutes nothing below the boundary.

import { randomUUID } from 'node:crypto';
import {
  DELEGATION_HEADER,
  pathOf,
  type CommandDeclaration,
  type CommandName,
} from '../../packages/core-wire/src/surface.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { agentPath, bearer, call, createWorld, personPath, type Answer } from './world.ts';
import { enrol } from '../commands/fixture.ts';
import { enrolCaller, type Caller } from './cast.ts';
import { isInvitation } from './role-case-invitation-bodies.ts';
import { PROPOSAL, type Task } from './role-case-bodies.ts';
import { createPositiveBody } from './role-case-positive-body.ts';
import { gateContext } from './role-case-gate-bodies.ts';
import { probeOperands } from './role-case-fixed-bodies.ts';
import { ownTaskRecipes } from './role-case-own-tasks.ts';
import { plainRows, seedFixtureClients } from './role-case-clients.ts';
import { pairFor, targetKeyOf, type Harness } from './role-case-harness-shape.ts';
import { heldByWithAdminTopUp } from './role-case-admin-grants.ts';
import { seedBrokenConnection } from '../connections/fixture.ts';

export { pairFor, targetKeyOf, type Harness } from './role-case-harness-shape.ts';

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
  const clients = await seedFixtureClients(world);

  const heldBy = await heldByWithAdminTopUp(world);

  // C39-T's limit is 30 invitation acts an hour per account, and the cells
  // of one run send many more: each recipe enrols a fresh inviter holding
  // `access:share` alone, so no cell spends another's hour.
  let inviter: Caller = world.ada;
  async function freshInviter(): Promise<void> {
    inviter = await enrolCaller(world.db, world.alpha, 'alpha', 'inviter', {
      membership: true,
      actions: ['share'],
      collections: ['access'],
    });
  }

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

  const { clientTask, ownComment } = ownTaskRecipes({ world, freshTask, asPerson, revisionOf });

  const alphaTask = await freshTask('a task every case can name');
  const inBravo = await asPerson('task.create', { fields: { title: 'a bravo task' } }, 'bravo', {
    token: world.bea.token,
  });
  const bravoRecordId = String(inBravo.body['recordId']);

  /**
   * The least a caller can send and still be asking the operation its own
   * question, for the cases whose answer arrives before the body is read.
   *
   * `recordId` goes only where the declaration names a record by it: `prepare.ts`
   * refuses an identifier a command has no use for, `COMMAND_BODY_INVALID`, before
   * the authority check, so a uniform body would have measured that refusal and
   * not the authority one the case is about.
   */
  function probeBody(declaration: CommandDeclaration): Readonly<Record<string, unknown>> {
    const targeted = declaration.targetsExistingRecord;
    return {
      operationId: randomUUID(),
      ...(targetKeyOf(declaration) === 'recordId' ? { recordId: alphaTask.id } : {}),
      ...(targeted ? { expectedRevision: alphaTask.revision } : {}),
      ...probeOperands(declaration.name),
      ...(declaration.name === 'task.duplicate' ? { recordId: alphaTask.id } : {}),
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
    const decided = await reserve(subject, PROPOSAL.purpose);
    return { subject, sibling, decided };
  }

  /**
   * A proposal on `task` for `purpose`, approved by the admin, answering with
   * the decision (its `detail` names the reservation an agent picks up).
   *
   * The purpose is a parameter because a live delegation is one per agent and
   * purpose (`delegations.ts`, `DELEGATION_ALREADY_LIVE`): a second pickup by
   * the same agent needs a second purpose, not a second agent.
   */
  async function reserve(task: Task, purpose: string): Promise<Answer> {
    const proposed = await asPerson('task.propose', {
      recordId: task.id,
      expectedRevision: await revisionOf(task.id),
      ...PROPOSAL,
      purpose,
    });
    const gate = proposed.body['detail'] as Record<string, string>;
    return await asPerson('task.decide', {
      gateId: gate['gateId'],
      versionId: gate['versionId'],
      decision: 'approve',
      note: 'approved so an agent can work it',
    });
  }

  /** Every role this business's active memberships carry; R4 adds none (case (g)). */
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
    world: { ...world, db: { ...world.db, admin: plainRows(world.db.admin) } },
    alphaTask,
    bravoRecordId,
    heldBy,
    otherCallers: [world.noah, world.mia, world.orphan, world.bea],
    clients,
    pairFor,
    asPerson,
    inviter: () => inviter,
    asAgent,
    freshTask,
    probeBody,
    positiveBody: createPositiveBody({
      alphaTaskId: alphaTask.id,
      assigneePersonId: world.mia.personId as string,
      asPerson: async (name, body) =>
        await asPerson(name, body, 'alpha', isInvitation(name) ? inviter : world.ada),
      asAgent,
      freshTask,
      clientTask,
      ownComment: async (author) => await ownComment(author as { readonly token: string }),
      freshInviter,
      freshMember: async () =>
        (await enrol(world.db.app, world.alpha, `ended-${randomUUID().slice(0, 8)}`)).personId,
      ...gateContext(world.db.admin, world.alpha),
      brokenConnection: async () => await seedBrokenConnection(world.db.admin, world.alpha),
    }),
    approvedReservation,
    reserve,
    activeRoleKeys,
    writeBothComments,
    close: async () => {
      await world.close();
    },
  };
}
