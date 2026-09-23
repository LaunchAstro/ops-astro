// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control: the minimal valid body each declaration needs.
//
// It is its own file for T1h's reason, which is the same reason the harness is
// its own file: the per-file review cap is 400 changed lines, no waiver lifts
// it, and the repository's answer is to split the file rather than the change
// or the comments. The seam is a real one — this is the only part of the
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
import type {
  CommandDeclaration,
  CommandName,
} from '../../packages/core-records/src/commands/surface.ts';
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
        // The party link takes a uuid and nothing in this tree resolves one:
        // the party model is not installed, and `tasks-state.ts` says so where
        // it excludes `client` from the person links it checks. So this is the
        // operation succeeding on a well-formed identifier, which is the whole
        // of what it claims to check — written down so a reader is not left
        // believing a party was proved to exist.
        return { body: { ...(await target()), fields: { client: randomUUID() } } };
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
        // A purge with a zero-day window takes everything already in the trash,
        // so there has to be something in it: an empty purge succeeds too, and
        // would have proved the authority without proving the operation.
        const task = await context.freshTask('a task to trash and purge');
        await context.asPerson('task.trash', {
          recordId: task.id,
          expectedRevision: task.revision,
        });
        return { body: { olderThanDays: 0 } };
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
        return { body: {} };
      case 'preset.plan':
        return { body: { recordTypeKey: 'task', presetKey: 'acceptance', fields: [] } };
      case 'settings.set_four_eyes_threshold':
        return { body: { value: 1200 } };
      case 'settings.set_client_sign_off':
        return { body: { value: true } };
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
