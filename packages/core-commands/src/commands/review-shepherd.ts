// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 (#2017): the review shepherd's weekly walk-through. A scheduled occurrence's worker,
// under its run's live lease, tells a review's own client how many of their requests are still
// open: one client comment on the review's task, an inbox item for each of the client's people
// and the send that is the comment's email cause, written with the lease held, in the same
// transaction. Nothing is sent here. The broker sends an item only while the send stands, a
// person's approval of its exact digest or a live standing mandate for the shepherd's class
// (`core-runtime/src/review-shepherd-authority.ts`). No release, install or activation path:
// a business adopts the shepherd's definition as it adopts any other (#2086 holds that).

import { createHash } from 'node:crypto';
import {
  advisoryLock,
  approveShepherdSend,
  existingShepherdSend,
  holdShepherdRun,
  isUuid,
  readShepherdPending,
  shepherdRecipients,
  writeShepherdSend,
  type Covering,
  type ShepherdApprover,
  type ShepherdHoldRefusal,
  type ShepherdLease,
  type ShepherdSendRow,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { writeAuditEvent } from './audit.ts';

export interface ShepherdRunRequest {
  readonly occurrenceId: string;
  readonly reviewId: string;
  readonly lease: ShepherdLease;
}

export type ShepherdRunOutcome =
  | {
      readonly kind: 'raised';
      readonly sendId: string;
      readonly commentId: string;
      readonly digest: string;
      readonly recipients: number;
      readonly replayed: boolean;
    }
  | { readonly kind: 'nothing_pending' }
  | { readonly kind: 'no_recipients' }
  | { readonly kind: 'refused'; readonly code: ShepherdHoldRefusal | 'NOT_FOUND' };

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The walk-through's words: counts and the revision number only, never a request's text. */
export function shepherdBody(open: number, revision: number): string {
  const requests = open === 1 ? '1 of your requests is' : `${open} of your requests are`;
  return `Your weekly review walk-through: ${requests} still open on this page, at revision ${revision}.`;
}

/**
 * One occurrence's walk-through of one review, in the caller's transaction: the lease and the
 * occurrence's standing approval are held first, and every write follows under them. A replayed
 * occurrence answers its first send. A review of the business's own site has no client to tell.
 */
export async function runReviewShepherd(
  tx: TenantQuery,
  request: ShepherdRunRequest,
): Promise<ShepherdRunOutcome> {
  if (!isUuid(request.occurrenceId) || !isUuid(request.reviewId)) {
    return { kind: 'refused', code: 'NOT_FOUND' };
  }
  const refused = await holdShepherdRun(tx, request.occurrenceId, request.lease);
  if (refused !== undefined) return { kind: 'refused', code: refused };
  // Held to commit: a second run of the same walk-through waits, then answers the first.
  await advisoryLock(
    tx,
    `review_shepherd:${tx.businessId}:${request.occurrenceId.toLowerCase()}:${request.reviewId.toLowerCase()}`,
  );
  const earlier = await existingShepherdSend(tx, request.occurrenceId, request.reviewId);
  if (earlier !== undefined) return raised(earlier, 0);
  const pending = await readShepherdPending(tx, request.reviewId);
  if (pending === undefined || pending.partyId === null) {
    return { kind: 'refused', code: 'NOT_FOUND' };
  }
  if (pending.open === 0) return { kind: 'nothing_pending' };
  const recipients = await shepherdRecipients(tx, pending.taskId, pending.partyId);
  if (recipients.length === 0) return { kind: 'no_recipients' };
  const send = await writeShepherdSend(tx, {
    occurrenceId: request.occurrenceId,
    reviewId: request.reviewId,
    taskId: pending.taskId,
    partyId: pending.partyId,
    body: shepherdBody(pending.open, pending.revision),
    recipients,
    workerActorId: request.lease.workerActorId,
  });
  await auditRaise(tx, request, pending.taskId, send);
  return raised(send, recipients.length);
}

const raised = (send: ShepherdSendRow, recipients: number): ShepherdRunOutcome => ({
  kind: 'raised',
  sendId: send.id,
  commentId: send.commentId,
  digest: send.digest,
  recipients,
  replayed: send.replayed,
});

/** One `review.shepherd_raise` event by the worker, on the review's task, naming the send. */
async function auditRaise(
  tx: TenantQuery,
  request: ShepherdRunRequest,
  taskId: string,
  send: ShepherdSendRow,
): Promise<void> {
  await writeAuditEvent(tx, {
    actorId: request.lease.workerActorId,
    command: 'review.shepherd_raise',
    outcome: 'applied',
    subjectRecordId: taskId,
    payloadDigest: sha256(
      JSON.stringify({
        occurrenceId: request.occurrenceId,
        reviewId: request.reviewId,
        sendId: send.id,
        commentId: send.commentId,
        digest: send.digest,
      }),
    ),
  });
}

export type ShepherdApproveOutcome =
  | { readonly ok: true; readonly id: string; readonly digest: string }
  | {
      readonly ok: false;
      readonly code: 'NOT_FOUND' | 'SHEPHERD_DIGEST_STALE' | 'SHEPHERD_ALREADY_APPROVED';
    };

/** A person approves one exact send they were shown, audited under their own actor. */
export async function approveShepherdSendAsPerson(
  tx: TenantQuery,
  ask: { readonly sendId: string; readonly digest: string },
  covering: Covering,
  by: ShepherdApprover,
): Promise<ShepherdApproveOutcome> {
  if (!isUuid(ask.sendId)) return { ok: false, code: 'NOT_FOUND' };
  const approved = await approveShepherdSend(tx, ask.sendId, ask.digest, covering, by);
  if ('code' in approved) return { ok: false, code: approved.code };
  await writeAuditEvent(tx, {
    actorId: by.actorId,
    command: 'review.shepherd_approve',
    outcome: 'applied',
    payloadDigest: sha256(JSON.stringify({ sendId: approved.id, digest: approved.digest })),
  });
  return { ok: true, ...approved };
}
