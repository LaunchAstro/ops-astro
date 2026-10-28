// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's bodies for the matrix and the identifier suites: the one-word request,
// and a correction another member requested, written through the records
// module so a positive approval has someone else's request to approve. A
// correction's party is its task's client (P26 low 4), so each names a task
// under a client and that client.

import { randomUUID } from 'node:crypto';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type {
  CommandHandle,
  CommandResult,
} from '../../packages/core-commands/src/commands/register-store.ts';
import { insertLiveCorrection } from '../../packages/core-records/src/site/live-corrections.ts';
import { pinAsRunner } from '../site/located.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { enrol } from '../commands/fixture.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/verified-subject.ts';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { madeClient } from './role-case-access-bodies.ts';
import { revertBody, reviewBody } from './c80-revert-body.ts';
import { reviseAsAnother } from './c35-x-seeds.ts';
import type { C80Seeds } from './c80-seeds.ts';
import { bindAboutPage } from '../site/party-site-fixture.ts';
import { PROPOSAL, type BodyContext, type Prepared, type Task } from './role-case-bodies.ts';
import type { Answer, World } from './world.ts';

/** C80's one-word request, less the task each recipe names (#1693: the page as typed). */
export const C80_REQUEST = {
  page: 'about',
  word: 'friendly',
  replacement: 'welcoming',
};

/** Who asks for a seeded correction, and who makes the task it is worked under. */
interface Seeder {
  readonly actorId?: string | null;
  readonly personId?: string | null;
  readonly presented: VerifiedSubject;
}

/** A setup step's answer, or the refusal thrown. */
function setUp(result: CommandResult, what: string): CommandHandle {
  if (isCommandRefusal(result))
    throw new Error(`seedLiveCorrection: ${what} refused ${result.code}`);
  return result;
}

/**
 * `taskId` and its client when it has one; otherwise a task `maker` creates and
 * puts under a client it makes, through the commands, so the pair is one the
 * product itself writes. The task named is left as it was: its revision is
 * one the caller may be holding.
 */
async function underClient(
  database: Database,
  business: string,
  taskId: string,
  maker: Seeder,
): Promise<{ readonly taskId: string; readonly partyId: string }> {
  const [row] = await database.withBusiness(
    business,
    async (tx) =>
      await tx.query<{ readonly client: string | null }>(
        'select uuid_7 as client from public.records where business_id = $1 and id = $2',
        [business, taskId],
      ),
  );
  if (row?.client) return { taskId, partyId: row.client };
  const as = async (body: Readonly<Record<string, unknown>>, what: string) =>
    setUp(
      await executeCommand(database, business, maker.presented, 'api', {
        operationId: randomUUID(),
        ...body,
      } as never),
      what,
    );
  const name = `A correction client ${randomUUID()}`;
  const client = String(
    (await as({ command: 'client.create', name }, 'client.create')).detail['clientId'],
  );
  const title = 'a task a seeded live correction is worked under';
  const task = await as({ command: 'task.create', fields: { title } }, 'task.create');
  const set = { recordId: task.recordId, expectedRevision: task.revision, fields: { client } };
  await as({ command: 'task.set_party', ...set }, 'task.set_party');
  return { taskId: String(task.recordId), partyId: client };
}

/**
 * A live correction `requester` asked for, written through the records module
 * so a positive approval has another member's request to approve. It is
 * worked under `taskId` at its client, or, for a task with none, under a task
 * of a client of its own that `maker` (the requester unless named) makes.
 */
export async function seedLiveCorrection(
  database: Database,
  business: string,
  taskId: string,
  requester: Seeder,
  maker: Seeder = requester,
): Promise<{ readonly correctionId: string; readonly versionId: string }> {
  const at = await underClient(database, business, taskId, maker);
  return await database.withBusiness(business, async (tx) => {
    const pageUrl = await bindAboutPage(tx, at.partyId, requester.actorId as string);
    // The run:write a request rests on, which its decision reads again.
    const granted = await issueGrant(tx, [], {
      subject: { kind: 'person', id: requester.personId as string },
      scope: { kind: 'business', id: null },
      collection: 'run',
      action: 'write',
      canDelegate: false,
      parentGrantId: null,
      grantedByActorId: requester.actorId as string,
    });
    if (!granted.ok) throw new Error(`seedLiveCorrection: grant refused ${granted.refusal.code}`);
    const stored = await insertLiveCorrection(tx, {
      ...C80_REQUEST_ROW,
      taskId: at.taskId,
      page: pageUrl,
      requestedByActorId: requester.actorId as string,
      requestedByPersonId: requester.personId as string,
      seam: `seam-${randomUUID()}`,
    });
    if ('code' in stored) throw new Error(`seedLiveCorrection: refused ${stored.code}`);
    const { versionId } = await pinAsRunner(tx, stored.id);
    return { correctionId: stored.id, versionId };
  });
}

const C80_REQUEST_ROW = {
  delegationId: null,
  word: C80_REQUEST.word,
  replacement: C80_REQUEST.replacement,
};

/**
 * The task the recipes name, with C80's approver (`ada`, the admin) and a
 * correction a member of its own requested, under a client task `ada` makes.
 */
export const taskBodyContext = (
  world: Pick<World, 'db' | 'alpha' | 'ada'>,
  taskId: string,
): Required<Pick<BodyContext, keyof C80Seeds | 'alphaTaskId' | 'adminPersonId'>> => {
  // Asked for by a member of its own, holding the run:write the request rests on,
  // so the matrix's callers keep exactly their declared grants.
  const asked = async () =>
    await seedLiveCorrection(
      world.db.app,
      world.alpha,
      taskId,
      await enrol(world.db.app, world.alpha, 'asker'),
      world.ada,
    );
  return {
    alphaTaskId: taskId,
    adminPersonId: world.ada.personId as string,
    seedCorrection: asked,
    seedLiveCorrection: async () => {
      const seeded = await asked();
      await recordLive(world, seeded.correctionId);
      return seeded;
    },
    bindClientSite: async (partyId) =>
      await world.db.app.withBusiness(
        world.alpha,
        async (tx) => await bindAboutPage(tx, partyId, world.ada.actorId as string),
      ),
    reviseAsAnother: reviseAsAnother(world),
  };
};

/** A requested correction decided by `ada` and recorded live: the runner's publish, no command's. */
async function recordLive(world: Pick<World, 'db' | 'ada'>, correctionId: string): Promise<void> {
  const [admin, decider] = [world.db.admin, world.ada];
  await admin.execute(
    `update public.live_corrections
        set state = 'approved', decided_by_actor_id = $2, decided_by_person_id = $3,
            decided_at = now(), decided_version_digest = version_digest, revision = revision + 1
      where id = $1`,
    [correctionId, decider.actorId, decider.personId],
  );
  await admin.execute(
    `update public.live_corrections set state = 'live', revision = revision + 1 where id = $1`,
    [correctionId],
  );
}

/** C80's operations, whose positive bodies are the matrix's from here. */
export const C80_NAMES: ReadonlySet<string> = new Set([
  'settings.set_live_correction_approver',
  'live_correction.request',
  'live_correction.decide',
  'live_correction.read',
  'live_correction.receipts',
  'live_correction.revert',
  'live_correction.record_review',
]);

/** The matrix's positive bodies for C80's operations (`role-case-positive-body.ts`). */
export async function c80PositiveBody(name: CommandName, context: BodyContext): Promise<Prepared> {
  if (name === 'settings.set_live_correction_approver') {
    return { body: { value: context.assigneePersonId } };
  }
  if (name === 'live_correction.request') {
    // A task under a client the admin makes, named with that client.
    const task = await context.freshTask('a task a live correction is worked under');
    const partyId = await madeClient(context);
    const set = await context.asPerson('task.set_party', {
      recordId: task.id,
      expectedRevision: task.revision,
      fields: { client: partyId },
    });
    if (set.code !== 'ok') throw new Error(`matrix: task.set_party refused ${set.code}`);
    // The client's own page, bound on its site: a request stores only for such a page.
    if (context.bindClientSite === undefined) {
      return { exception: 'this harness binds no client site (C80)' };
    }
    const pageUrl = await context.bindClientSite(partyId);
    return { body: { ...C80_REQUEST, taskId: task.id, page: pageUrl } };
  }
  // Another member's request, and the admin named as the approver just
  // before: the requester never approves, and only the configured one does.
  if (context.seedCorrection === undefined || context.adminPersonId === undefined) {
    return { exception: 'this harness seeds no live correction (C80)' };
  }
  if (name === 'live_correction.revert') return await revertBody(context);
  const correction = await context.seedCorrection();
  if (name === 'live_correction.record_review') return reviewBody(correction.correctionId);
  // The decision and receipts reads: that request, read back under the admin's run:write.
  if (name !== 'live_correction.decide') return { body: { correctionId: correction.correctionId } };
  const named = await context.asPerson('settings.set_live_correction_approver', {
    value: context.adminPersonId,
  });
  if (named.code !== 'ok') throw new Error(`matrix: approver refused ${named.code}`);
  return { body: { ...correction, decision: 'approve' } };
}

/** What D06's agent case asks of its harness (`role-case-harness.ts`). */
type AgentCase = Pick<BodyContext, 'asPerson' | 'freshTask' | 'bindClientSite'> & {
  reserve(task: Task, purpose: string): Promise<Answer>;
  asAgent(name: CommandName, body: Readonly<Record<string, unknown>>): Promise<Answer>;
};

/**
 * D06's pickup for C80's request: a fresh task the admin puts under a client it
 * makes while the task is still empty, then reserved and picked up. Its
 * proposal locks the client, so the client is set first (P26 low 4).
 */
export async function c80AgentPickup(
  harness: AgentCase,
): Promise<{ readonly pickup: Answer; readonly partyId: string; readonly pageUrl: string }> {
  const task = await harness.freshTask('a task an agent asks a live correction under');
  const made = await harness.asPerson('client.create', { name: `A client ${randomUUID()}` });
  if (made.code !== 'ok') throw new Error(`d06: client.create refused ${made.code}`);
  const partyId = String((made.body['detail'] as Record<string, unknown>)['clientId']);
  const set = await harness.asPerson('task.set_party', {
    recordId: task.id,
    expectedRevision: task.revision,
    fields: { client: partyId },
  });
  if (set.code !== 'ok') throw new Error(`d06: task.set_party refused ${set.code}`);
  if (harness.bindClientSite === undefined)
    throw new Error('d06: the harness binds no client site');
  const pageUrl = await harness.bindClientSite(partyId);
  const decided = await harness.reserve(task, PROPOSAL.purpose);
  if (decided.code !== 'ok') throw new Error(`d06: the reservation refused ${decided.code}`);
  const { reservationId } = decided.body['detail'] as Record<string, unknown>;
  return { pickup: await harness.asAgent('task.pickup', { reservationId }), partyId, pageUrl };
}

/** D06's positive agent body for C80's request: the picked-up task and its client's page. */
export const c80AgentBody = (
  operationId: string,
  held: { readonly taskId: string; readonly credential: string },
  at: { readonly pageUrl: string },
): { body: Record<string, unknown>; credential: string } => ({
  body: { operationId, ...C80_REQUEST, page: at.pageUrl, taskId: held.taskId },
  credential: held.credential,
});
