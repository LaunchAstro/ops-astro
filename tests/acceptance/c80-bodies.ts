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
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/verified-subject.ts';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { madeClient } from './role-case-access-bodies.ts';
import type { BodyContext, Prepared } from './role-case-bodies.ts';
import type { World } from './world.ts';

/** C80's one-word request, less the party and the task each recipe names. */
export const C80_REQUEST = {
  path: 'src/pages/about.md',
  word: 'friendly',
  replacement: 'welcoming',
  pageUrl: 'https://agency.example/about/',
  baseRevision: 'rev-1',
  before: 'We are a friendly studio.\n',
  after: 'We are a welcoming studio.\n',
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
    const stored = await insertLiveCorrection(tx, {
      ...C80_REQUEST_ROW,
      ...at,
      requestedByActorId: requester.actorId as string,
      requestedByPersonId: requester.personId as string,
      seam: `seam-${randomUUID()}`,
    });
    if ('code' in stored) throw new Error(`seedLiveCorrection: refused ${stored.code}`);
    return { correctionId: stored.id, versionId: stored.versionId };
  });
}

const C80_REQUEST_ROW = {
  delegationId: null,
  targetPath: C80_REQUEST.path,
  word: C80_REQUEST.word,
  replacement: C80_REQUEST.replacement,
  pageUrl: C80_REQUEST.pageUrl,
  preImageDigest: 'sha256:matrix',
  baseRevision: C80_REQUEST.baseRevision,
  versionDigest: 'sha256:matrix',
};

/**
 * The task the recipes name, with C80's approver (`ada`, the admin) and a
 * correction another member (`mia`) requested, under a client task `ada` makes.
 */
export const taskBodyContext = (
  world: Pick<World, 'db' | 'alpha' | 'ada' | 'mia'>,
  taskId: string,
): Pick<BodyContext, 'alphaTaskId' | 'adminPersonId' | 'seedCorrection'> => ({
  alphaTaskId: taskId,
  adminPersonId: world.ada.personId as string,
  seedCorrection: async () =>
    await seedLiveCorrection(world.db.app, world.alpha, taskId, world.mia, world.ada),
});

/** C80's four operations, whose positive bodies are the matrix's from here. */
export const C80_NAMES: ReadonlySet<string> = new Set([
  'settings.set_live_correction_approver',
  'live_correction.request',
  'live_correction.decide',
  'live_correction.read',
]);

/** The matrix's positive bodies for C80's four operations (`role-case-positive-body.ts`). */
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
    return { body: { ...C80_REQUEST, partyId, taskId: task.id } };
  }
  // Another member's request, and the admin named as the approver just
  // before: the requester never approves, and only the configured one does.
  if (context.seedCorrection === undefined || context.adminPersonId === undefined) {
    return { exception: 'this harness seeds no live correction (C80)' };
  }
  const correction = await context.seedCorrection();
  // The decision read: that request, read back under the admin's run:write.
  if (name === 'live_correction.read') return { body: { correctionId: correction.correctionId } };
  const named = await context.asPerson('settings.set_live_correction_approver', {
    value: context.adminPersonId,
  });
  if (named.code !== 'ok') throw new Error(`matrix: approver refused ${named.code}`);
  return { body: { ...correction, decision: 'approve' } };
}

/** D06's positive agent body for C80's request: the picked-up task, a party of its own. */
export const c80AgentBody = (
  operationId: string,
  held: { readonly taskId: string; readonly credential: string },
): { body: Record<string, unknown>; credential: string } => ({
  body: { operationId, ...C80_REQUEST, partyId: randomUUID(), taskId: held.taskId },
  credential: held.credential,
});
