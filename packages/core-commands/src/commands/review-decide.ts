// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X's person commands (#2014, the version half): `review.decide`, `revision approved
// (exact version)`, and `review.record_astra_review`, Astra's review of a revision recorded by
// a person from Astra's saved review. Each is `gate:decide` at the review's holder, asked at
// the door and again after the last lock wait, and a person's alone: an agent credential is
// refused before any review is read. Each locks the review's row, the lock a new revision is
// numbered under, and names the latest revision's exact digest: an earlier one is stale.
//
// The decision's author is the revision's author person, read from the revision (for an
// agent's revision, the person it acted for), never from the body. The author approves only
// as R5 allows (#1689, director register 132): single-operator mode on with one operator,
// read under the mode's share lock, and Astra's latest review of this exact digest
// approving, for every self-approved revision. The table holds the same rule
// (20261019170000). An approval writes its record and nothing else: no publish, no send.

import {
  astraApproves,
  GATE_COLLECTION,
  insertApproval,
  insertAstraReview,
  isUuid,
  latestRevision,
  lockCoveredReview,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { Covering, DecidableRevision, TenantQuery } from '../../../core-records/src/index.ts';
import { isInternalReader } from '../reads/tasks.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome, type Refused } from './outcome.ts';
import { singleOperatorStands } from './live-correction-decide.ts';
import { endedRefusal, standsAfterWaits } from './live-correction-standing.ts';

type Of<K extends CommandRequest['command']> = CommandRequest & { readonly command: K };

const DIGEST_LIMIT = 200;
const REVIEW_LIMIT = 20_000;
const VERDICTS: ReadonlySet<string> = new Set(['approve', 'changes_requested']);

const NOT_VISIBLE = refuseCommand('NOT_FOUND', [], ['Name a review you can see.']);
const PERSON_ONLY = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  ['Only a person decides a review, signed in as themselves.'],
);
const STALE = refuseCommand(
  'VERSION_STALE',
  ['digest'],
  ['Read the review again and name the digest of the revision it shows.'],
);
const SELF = refuseCommand(
  'SELF_APPROVAL_REFUSED',
  [],
  [
    'A second person approves the revision; ask another holder of gate:decide.',
    'In single-operator mode, the one operator approves their own revision.',
  ],
);
const ASTRA_MISSING = refuseCommand(
  'ASTRA_REVIEW_MISSING',
  ['digest'],
  ["Record Astra's approving review of this revision with review.record_astra_review first."],
);
const DECIDED = refuseCommand(
  'REVIEW_ALREADY_DECIDED',
  [],
  ['This revision is approved already; a new revision needs its own approval.'],
);

const gateAt = (context: CommandContext): Covering => ({
  subjects: subjectsOf(context.session),
  collection: GATE_COLLECTION,
  action: 'decide',
});

const isText = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value !== '' && value.length <= limit;

/**
 * The review locked for a person's `gate:decide` at its holder, and its latest revision when
 * `digest` names it; otherwise the refusal.
 */
async function lockLatest(
  tx: TenantQuery,
  context: CommandContext,
  reviewId: string,
  digest: string,
): Promise<{ readonly partyId: string | null; readonly revision: DecidableRevision } | Refused> {
  const { session } = context;
  if (session.credentialScope !== undefined) return refused(PERSON_ONLY);
  // An external party, or a malformed id, names no review, as a fabricated one does.
  if (!isInternalReader(session.roleKey) || !isUuid(reviewId)) return refused(NOT_VISIBLE);
  const review = await lockCoveredReview(tx, reviewId.toLowerCase(), gateAt(context));
  if (review === undefined) return refused(NOT_VISIBLE);
  const revision = await latestRevision(tx, review.id);
  if (revision === undefined || revision.digest !== digest) return refused(STALE);
  return { partyId: review.partyId, revision };
}

/** After the last lock wait: the decider's `gate:decide` at the holder, read again. */
async function endedSince(
  tx: TenantQuery,
  context: CommandContext,
  partyId: string | null,
): Promise<HandlerOutcome | undefined> {
  const stood = await standsAfterWaits(tx, { covering: gateAt(context), partyId });
  return stood === 'stands' ? undefined : refused(endedRefusal(stood, false));
}

export async function decideReview(
  tx: TenantQuery,
  context: CommandContext,
  request: Of<'review.decide'>,
): Promise<HandlerOutcome> {
  const { digest } = request;
  if (request.response !== 'approve' || !isText(digest, DIGEST_LIMIT)) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        [
          ...(request.response === 'approve' ? [] : ['response']),
          ...(isText(digest, DIGEST_LIMIT) ? [] : ['digest']),
        ],
        ["Send response as approve, and digest as the revision's digest the review read shows."],
      ),
    );
  }
  const locked = await lockLatest(tx, context, String(request.reviewId), digest);
  if ('refusal' in locked) return locked;
  const { revision } = locked;
  const { session } = context;
  const self = revision.authorPersonId === session.personId;
  if (self && !(await singleOperatorStands(tx))) return refused(SELF);
  if (self && !(await astraApproves(tx, revision))) return refused(ASTRA_MISSING);
  const ended = await endedSince(tx, context, locked.partyId);
  if (ended !== undefined) return ended;
  const reviewId = String(request.reviewId).toLowerCase();
  const id = await insertApproval(tx, {
    reviewId,
    revision,
    writer: { actorId: session.actorId, personId: session.personId },
    selfApproval: self,
  });
  if (id === undefined) return refused(DECIDED);
  return applied(reviewId, null, {
    decisionId: id,
    reviewId,
    revisionId: revision.id,
    digest: revision.digest,
    response: 'approve',
    singleOperatorSelfApproval: self,
  });
}

export async function recordAstraReview(
  tx: TenantQuery,
  context: CommandContext,
  request: Of<'review.record_astra_review'>,
): Promise<HandlerOutcome> {
  const { verdict, digest, review } = request;
  const wellFormed = {
    verdict: typeof verdict === 'string' && VERDICTS.has(verdict),
    digest: isText(digest, DIGEST_LIMIT),
    review: isText(review, REVIEW_LIMIT),
  };
  if (!wellFormed.verdict || !isText(digest, DIGEST_LIMIT) || !isText(review, REVIEW_LIMIT)) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        Object.keys(wellFormed).filter((name) => !wellFormed[name as keyof typeof wellFormed]),
        [
          'Send verdict as approve or changes_requested, digest as the digest the review read,',
          "and review as Astra's saved review, 1 to 20,000 characters.",
        ],
      ),
    );
  }
  const locked = await lockLatest(tx, context, String(request.reviewId), digest);
  if ('refusal' in locked) return locked;
  const ended = await endedSince(tx, context, locked.partyId);
  if (ended !== undefined) return ended;
  const reviewId = String(request.reviewId).toLowerCase();
  const id = await insertAstraReview(tx, {
    reviewId,
    revision: locked.revision,
    verdict: verdict as 'approve' | 'changes_requested',
    review,
    writer: { actorId: context.session.actorId, personId: context.session.personId },
  });
  return applied(reviewId, null, {
    astraReviewId: id,
    reviewId,
    revisionId: locked.revision.id,
    verdict,
  });
}
