// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control: the minimal valid body each declaration needs.
//
// It is its own file for T1h's reason, which is the same reason the harness is
// its own file: about 400 lines is the guide for a readable file, and the
// repository's answer is to split the file rather than the change or the
// comments. The seam is a real one — this is the only part of the
// matrix that knows what a *task* is, as opposed to what a caller is — so
// `role-case-harness.ts` stays about identity and the ledger and this stays
// about the domain.
//
// **Why the positive control is the whole matrix.** Nine refusals prove
// nothing if the same request would have been refused anyway: for its shape,
// for a missing revision, for a record that was never there. So every recipe
// below is the smallest body that leaves nothing but authority between the
// caller and a 200, with whatever has to exist first brought into existence
// first — a task to complete before one can be reopened, a trash batch before
// a restore, a proposal before a decision.
//
// **A declaration with no recipe fails.** The switch is exhaustive over
// `CommandName` and its default throws. That is what keeps the generation
// honest: an operation added to the surface cannot be skipped here quietly,
// because being skipped is a thrown error rather than an absent row.

import { randomUUID } from 'node:crypto';
import type { CommandDeclaration, CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer } from './world.ts';

/** The proposal every case that needs a gate proposes, spelled once. */
export const PROPOSAL = {
  purpose: 'draft_the_reply',
  maximumMinor: 3_000,
  currency: 'AUD',
  payload: { instruction: 'draft a reply' },
  step: { kind: 'compose', payload: {} },
} as const;

/** A proposal on `task`, answering with the lineage it opened. */
async function lineageOn(context: BodyContext, task: Task): Promise<string> {
  const proposed = await context.asPerson('task.propose', {
    recordId: task.id,
    expectedRevision: task.revision,
    ...PROPOSAL,
  });
  if (proposed.code !== 'ok') throw new Error(`matrix: propose refused ${proposed.code}`);
  return String((proposed.body['detail'] as Record<string, unknown>)['lineageId']);
}

/** A body the case can send, or the reason there is no such body. */
export type Prepared = { readonly body: Record<string, unknown> } | { readonly exception: string };

export interface Task {
  readonly id: string;
  readonly revision: number;
}

/** What a recipe needs from the world, and nothing else. */
export interface BodyContext {
  /** The task every case can name, for the reads that only need one. */
  readonly alphaTaskId: string;
  /** A person of this business, for the one field that must name one. */
  readonly assigneePersonId: string;
  asPerson(name: CommandName, body: Readonly<Record<string, unknown>>): Promise<Answer>;
  freshTask(title: string): Promise<Task>;
}

const batchOf = (answer: Answer): string =>
  String((answer.body['detail'] as Record<string, unknown>)['batchId']);

/** A proposal a person may decide on, which is what `task.decide` needs to exist. */
export async function approvableGate(
  context: BodyContext,
): Promise<{ gateId: string; versionId: string }> {
  const task = await context.freshTask('a task with a proposal on it');
  const proposed = await context.asPerson('task.propose', {
    recordId: task.id,
    expectedRevision: task.revision,
    ...PROPOSAL,
  });
  if (proposed.code !== 'ok') throw new Error(`matrix: propose refused ${proposed.code}`);
  const detail = proposed.body['detail'] as Record<string, string>;
  return { gateId: detail['gateId'] as string, versionId: detail['versionId'] as string };
}

/** Proposed and approved by the context's person: a reservation on the queue. */
async function approvedReservationId(context: BodyContext): Promise<string> {
  const gate = await approvableGate(context);
  const decided = await context.asPerson('task.decide', {
    ...gate,
    decision: 'approve',
    note: 'approved so a person can work it',
  });
  if (decided.code !== 'ok') throw new Error(`matrix: decide refused ${decided.code}`);
  return String((decided.body['detail'] as Record<string, unknown>)['reservationId']);
}

/** A lease the context's person holds: their own pickup of fresh approved work (EX-01). */
/** Clients made by the matrix, each under a name of its own (one name per business). */
let clientsMade = 0;
const nextClientName = (): string =>
  `A made-up client ${String((clientsMade += 1))} ${randomUUID()}`;

/** A client of the context's business, made by its admin (C32). */
async function madeClient(context: BodyContext): Promise<string> {
  const made = await context.asPerson('client.create', { name: nextClientName() });
  if (made.code !== 'ok') throw new Error(`matrix: client.create refused ${made.code}`);
  return String((made.body['detail'] as Record<string, unknown>)['clientId']);
}

/** Legal document versions drafted by the matrix, each under a label of its own. */
let legalDrafts = 0;

/** A fresh breach-runbook version drafted by the admin, `approved` or not (C81). */
async function legalVersion(
  context: BodyContext,
  approved: boolean,
): Promise<{ versionId: string; digest: string }> {
  legalDrafts += 1;
  const drafted = await context.asPerson('legal.draft_version', {
    document: 'breach-runbook',
    version: `${String(Math.floor(legalDrafts / 1000) + 1)}.${String(legalDrafts % 1000)}`,
    body: 'The matrix drafts a made-up runbook.',
  });
  if (drafted.code !== 'ok') throw new Error(`matrix: legal draft refused ${drafted.code}`);
  const detail = drafted.body['detail'] as Record<string, unknown>;
  const version = { versionId: String(detail['versionId']), digest: String(detail['digest']) };
  if (approved) {
    const done = await context.asPerson('legal.approve_version', version);
    if (done.code !== 'ok') throw new Error(`matrix: legal approval refused ${done.code}`);
  }
  return version;
}

async function ownLease(context: BodyContext): Promise<{ leaseId: string; fence: number }> {
  const picked = await context.asPerson('task.pickup', {
    reservationId: await approvedReservationId(context),
  });
  if (picked.code !== 'ok') throw new Error(`matrix: person pickup refused ${picked.code}`);
  const detail = picked.body['detail'] as Record<string, unknown>;
  return { leaseId: String(detail['leaseId']), fence: Number(detail['fence']) };
}

export function createPositiveBody(
  context: BodyContext,
): (declaration: CommandDeclaration) => Promise<Prepared> {
  // eslint-disable-next-line max-lines-per-function -- one recipe per declaration reads as a table
  return async function positiveBody(declaration: CommandDeclaration): Promise<Prepared> {
    const target = async (): Promise<Record<string, unknown>> => {
      const task = await context.freshTask(`a task for ${declaration.name}`);
      return { recordId: task.id, expectedRevision: task.revision };
    };
    switch (declaration.name) {
      case 'task.create':
        return { body: { fields: { title: 'the admin creates a task' } } };
      case 'task.update':
        return { body: { ...(await target()), fields: { title: 'edited by the admin' } } };
      case 'task.start':
      case 'task.complete':
      case 'task.trash':
        return { body: await target() };
      case 'task.reopen': {
        // Only a completed task can be reopened (`tasks-state.ts`), so this
        // completes one first and writes against the revision that move
        // produced rather than the one the create returned.
        const task = await context.freshTask('a task to complete and reopen');
        const done = await context.asPerson('task.complete', {
          recordId: task.id,
          expectedRevision: task.revision,
        });
        return {
          body: {
            recordId: task.id,
            expectedRevision: Number(done.body['revision']),
            reason: 'the admin reopens it',
          },
        };
      }
      case 'task.comment':
        return { body: { ...(await target()), body: 'a note', audience: 'internal' } };
      case 'task.assign':
        return { body: { ...(await target()), fields: { assignee: context.assigneePersonId } } };
      case 'task.triage':
        return { body: { ...(await target()), fields: { intake_state: 'accepted' } } };
      case 'task.set_stage':
        return { body: { ...(await target()), fields: { stage: 'drafting' } } };
      case 'task.set_audience':
        return { body: { ...(await target()), fields: { client_visible: true } } };
      case 'task.set_party':
        // The party link names a client of this business (C32), so the admin
        // makes one first.
        return { body: { ...(await target()), fields: { client: await madeClient(context) } } };
      case 'task.reparent':
        return { body: { ...(await target()), parentId: null } };
      case 'task.move':
        return { body: { ...(await target()), board: null, boardSection: null } };
      case 'task.rank': {
        // Neighbours, never a number (specification 14.2 point 3), so a rank
        // needs a sibling to be ranked against: a lone task cannot be ranked.
        const neighbour = await context.freshTask('a neighbour to rank against');
        return { body: { ...(await target()), afterId: neighbour.id } };
      }
      case 'task.restore': {
        const task = await context.freshTask('a task to trash and restore');
        const trashed = await context.asPerson('task.trash', {
          recordId: task.id,
          expectedRevision: task.revision,
        });
        return { body: { batchId: batchOf(trashed) } };
      }
      case 'task.purge': {
        // The purge takes no window: it reads the business's installed
        // retention_window_days, thirty days here, so this fresh trash stays
        // and the case proves the authority and the operation's reach. The
        // window boundary itself is `tests/commands/purge-retention.test.ts`.
        const task = await context.freshTask('a task to trash and purge');
        await context.asPerson('task.trash', {
          recordId: task.id,
          expectedRevision: task.revision,
        });
        return { body: {} };
      }
      case 'task.propose':
        return { body: { ...(await target()), ...PROPOSAL } };
      case 'task.decide': {
        const gate = await approvableGate(context);
        return { body: { ...gate, decision: 'approve', note: 'the admin approves' } };
      }
      case 'task.pickup':
        // Person pickup (EX-01, transaction contract T3 line 66, minimum
        // contract line 331, ledger line 30): the admin claims approved work
        // as themselves. The agent's pickup is asserted in case (h).
        return { body: { reservationId: await approvedReservationId(context) } };
      case 'task.handback':
        // The person's own lease, handed back by that person. The agent's
        // own-lease handback is case (h), `k-handback` rows.
        return { body: { ...(await ownLease(context)), outcome: 'completed' } };
      case 'task.read':
        return { body: { recordId: context.alphaTaskId } };
      case 'task.board':
        return { body: { board: null } };
      case 'task.queue':
      case 'person.list':
      // Both take an empty body and neither carries an `expectedRevision`:
      // `settings.read` because `business_settings` has no revision column to
      // be stale against, `session.capabilities` because it reports the
      // caller's own grants and there is nothing of the caller's to be stale.
      // `settings.read` needs `settings:read`, which the seed grants the
      // admin; `session.capabilities` needs a live grant of any kind, which
      // the admin holds, so the admin reaches both here.
      case 'settings.read':
      case 'session.capabilities':
      // `access:manage`, which the fixture admin holds on every collection.
      case 'access.read':
      // `operations:read`, which the fixture admin holds as the owner does
      // (C55); and `client.list` (C32), any live grant, which the admin holds.
      case 'operations.read':
      case 'client.list':
        return { body: {} };
      // C32: `record:write`, a name no other call has used.
      case 'client.create':
        return { body: { name: nextClientName() } };
      // C32: `access:manage`. The key is one the member already holds over
      // the whole business, so the answer is that grant and no caller's
      // holdings change under the cases that read them.
      case 'access.grant':
        return {
          body: { holderId: context.assigneePersonId, collection: 'task', action: 'read' },
        };
      // C32: a grant the admin has just given over one client, revoked. The
      // member already holds the same key over the whole business.
      case 'access.revoke': {
        const given = await context.asPerson('access.grant', {
          holderId: context.assigneePersonId,
          collection: 'task',
          action: 'read',
          clientId: await madeClient(context),
        });
        if (given.code !== 'ok') throw new Error(`matrix: access.grant refused ${given.code}`);
        return { body: { grantId: (given.body['detail'] as Record<string, unknown>)['grantId'] } };
      }
      case 'preset.plan':
        return { body: { recordTypeKey: 'task', presetKey: 'acceptance', fields: [] } };
      case 'settings.set_four_eyes_threshold':
        return { body: { value: 1200 } };
      case 'settings.set_client_sign_off':
        return { body: { value: true } };
      case 'settings.set_money_step_up':
        return { body: { value: true } };
      // C81: the admin holds `privacy:manage`, as the owner does.
      case 'legal.draft_version':
        return {
          body: {
            document: 'breach-runbook',
            version: `0.${String((legalDrafts += 1))}`,
            body: 'The matrix drafts a made-up runbook.',
          },
        };
      case 'legal.approve_version':
        return { body: await legalVersion(context, false) };
      case 'legal.publish_version':
        return { body: { versionId: (await legalVersion(context, true)).versionId } };
      case 'privacy.set_overseas_service':
        return {
          body: {
            service: 'A made-up service the matrix sets',
            receives: 'nothing real',
            where: 'nowhere',
            trainsOnIt: 'no',
            contract: 'none',
            toConfirm: false,
            inUse: true,
          },
        };
      case 'privacy.record_incident':
        return {
          body: {
            whatHappened: 'The matrix records a made-up incident.',
            foundAt: new Date(Date.now() - 60_000).toISOString(),
            foundBy: 'The matrix',
            affected: 'Nobody; it is made up.',
            informationKinds: ['other'],
          },
        };
      case 'task.cancel': {
        // A lineage to cancel is a proposal's, so one is proposed first.
        const task = await context.freshTask('a task whose lineage is cancelled');
        const lineageId = await lineageOn(context, task);
        return { body: { recordId: task.id, lineageId, reason: 'the admin cancels it' } };
      }
      case 'task.restart': {
        // Only a rejected or cancelled lineage is restarted, so this one is
        // proposed and cancelled through the routes before the restart.
        const task = await context.freshTask('a task whose lineage is restarted');
        const lineageId = await lineageOn(context, task);
        const cancelled = await context.asPerson('task.cancel', {
          recordId: task.id,
          lineageId,
          reason: 'cancelled so it can be restarted',
        });
        if (cancelled.code !== 'ok') throw new Error(`matrix: cancel refused ${cancelled.code}`);
        return { body: { recordId: task.id, lineageId } };
      }
      case 'grant.revoke':
        // Its positive control is case (f): the admin revokes a member's read
        // through this route, and the member's next read is refused. A body
        // here would need a grant id, and the only way to one is the grant it
        // then takes away from a later case.
        return {
          exception: 'executed alternative: success asserted in case (f), ada grant.revoke row',
        };
      case 'delegation.revoke':
        // A delegation exists only after an agent's pickup, which this recipe
        // cannot make. The journey makes one and the admin revokes it through
        // this route, case (h), `k-revoke` rows.
        return {
          exception:
            'executed alternative: needs a pickup; ada revokes a live delegation in ' +
            'case (h), k-revoke rows',
        };
      case 'task.heartbeat':
        // The person renews their own lease (ledger line 38, "current lease
        // owner"). The agent's renewal is in the agent journey.
        return { body: await ownLease(context) };
      default:
        throw new Error(`matrix: no positive control recipe for ${String(declaration.name)}`);
    }
  };
}
