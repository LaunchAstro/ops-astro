// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2018, D17-14): `operations.record_capture_pool_review` records one closed
// other-company adversarial review of the capture pool (migration
// 20261020032000), a person's act under `operations:manage` in the business that
// operates the installation, never an agent's, audited by the envelope. The
// site runner reads the recorded identities into its fence's pool; three
// distinct reviews of the pool version the fence runs now open a client's bound
// page to capture (`capture/fence.ts`).
//
// Every field is checked here, before the table's own constraint could refuse
// it as a driver error carrying the statement's parameters. The installation's
// row lock is taken next and the operator checked under it, so a refusal
// writes nothing. A review already recorded is refused, its evidence kept as
// first recorded: two at once meet on the primary key, and one is told.

import { CAPTURE_POOL_VERSION } from '../../../core-connectors/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { lockedForOperator } from './gate-write.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';
import type { CommandRequest } from './requests.ts';

type RecordRequest = CommandRequest & {
  readonly command: 'operations.record_capture_pool_review';
};

/** As the table's `capture_pool_reviews_review_named` reads it: lower case, no space. */
const REVIEW = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
/** One https link with no user, password, port or fragment, and no space. */
const EVIDENCE = /^https:\/\/[^\s@#]+$/u;
const COMPANY = /^[^\p{Cc}]{1,200}$/u;

const FIXES: Readonly<Record<string, readonly string[]>> = {
  review: [
    "Send the review's identity as the reviewer's report names it: lower-case letters, digits, '.', '_' or '-', at most 64, with no spaces.",
  ],
  poolVersion: [
    `Send the pool version the review was of. Only reviews of the pool the fence runs now (${CAPTURE_POOL_VERSION}) are recorded.`,
  ],
  evidence: [
    'Send the evidence as one https link of at most 2000 characters, with no spaces, no sign-in details and no fragment.',
  ],
  company: [
    "Send the reviewing company's name, at most 200 characters, with no surrounding spaces.",
  ],
};

const invalid = (field: string): HandlerOutcome =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [field], FIXES[field] ?? []));

/** The first field that is not as recorded, or none. */
function invalidField(request: RecordRequest): string | undefined {
  const { review, poolVersion, evidence, company } = request;
  if (typeof review !== 'string' || !REVIEW.test(review)) return 'review';
  if (poolVersion !== CAPTURE_POOL_VERSION) return 'poolVersion';
  const linked =
    typeof evidence === 'string' &&
    evidence.length <= 2000 &&
    EVIDENCE.test(evidence) &&
    URL.canParse(evidence) &&
    new URL(evidence).port === '';
  if (!linked) return 'evidence';
  if (typeof company !== 'string' || company !== company.trim() || !COMPANY.test(company)) {
    return 'company';
  }
  return undefined;
}

export async function recordCapturePoolReview(
  tx: TenantQuery,
  context: CommandContext,
  request: RecordRequest,
): Promise<HandlerOutcome> {
  const wrong = invalidField(request);
  if (wrong !== undefined) return invalid(wrong);
  const operator = await lockedForOperator(tx, context, 'records the capture pool’s reviews');
  if (!('operator_business_id' in operator)) return operator;
  const { session } = context;
  const inserted = await tx.query<{ readonly review: string }>(
    `insert into ops.capture_pool_reviews
       (review, pool_version, evidence, company, operator_business_id, recorded_by_person_id,
        recorded_by_actor_id, operation_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (review) do nothing returning review`,
    [
      request.review,
      request.poolVersion,
      request.evidence,
      request.company,
      session.businessId,
      session.personId,
      session.actorId,
      request.operationId,
    ],
  );
  if (inserted.length === 0) {
    return refused(
      refuseCommand(
        'POOL_REVIEW_ALREADY_RECORDED',
        ['review'],
        ['This review is already recorded; its evidence stays as first recorded.'],
      ),
    );
  }
  return applied(null, null, { review: request.review, poolVersion: request.poolVersion });
}
