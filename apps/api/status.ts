// SPDX-License-Identifier: AGPL-3.0-only
//
// Which HTTP status a refusal is carried under.
//
// This is transport and it lives in the transport. The code is the domain's
// and is the thing a client branches on; the status is what an HTTP client,
// a proxy and a log reader see. Neither is derived from the other.
//
// The table is a complete record over the register, so a code added there
// without a status decided here is a type error rather than a silent 500.
// That matters more than it sounds: an unmapped refusal defaulting to 500
// would turn a refusal into a fault, and case T1-N5 requires two different
// refusals to be indistinguishable in **status** as well as in body.

import type { RefusalCode } from '../../packages/core-records/src/commands/register.ts';

const STATUS: Readonly<Record<RefusalCode, number>> = {
  // Not signed in, or signed in as nobody this business knows.
  AUTH_UNKNOWN_LOGIN: 401,
  AUTH_NO_MEMBERSHIP: 403,
  ACTOR_INACTIVE: 403,

  // Signed in, and not allowed.
  SCOPE_NOT_GRANTED: 403,
  GRANT_WIDENS: 403,
  GRANT_DEEPENS: 403,
  DELEGATION_EXCLUDES_OPERATION: 403,
  DELEGATION_EXCLUDES_DECISION: 403,
  DELEGATION_EXCLUDES_INTAKE: 403,
  DELEGATION_NARROWED: 403,
  DELEGATION_EXPIRED: 403,
  DELEGATION_REVOKED: 403,
  RETENTION_CLASS_PROTECTED: 403,
  LEASE_NOT_OWNED: 403,
  SOURCE_SPOOFED: 403,

  // It is not there, or it is not yours to know about.
  NOT_FOUND: 404,
  // `WRONG_BUSINESS` never reaches a caller; the envelope translates it. The
  // status is here so the table stays complete and reads the same as the one
  // the caller would get if it ever did.
  WRONG_BUSINESS: 404,

  // The request is understood, and something else has moved.
  VERSION_STALE: 409,
  OPERATION_ID_REUSED: 409,
  ALREADY_TRASHED: 409,
  PARENT_TRASHED: 409,
  UNIQUE_VALUE_TAKEN: 409,
  TRANSITION_NOT_PERMITTED: 409,
  LEASE_HELD: 409,
  LEASE_EXPIRED: 409,
  GATE_PENDING: 409,
  GATE_ALREADY_DECIDED: 409,
  GATE_NOT_APPROVED: 409,
  PROPOSAL_SUPERSEDED: 409,
  FOUR_EYES_REQUIRED: 409,
  BUDGET_UNAVAILABLE: 409,
  BUDGET_EXHAUSTED: 409,
  TASK_NOT_PICKABLE: 409,

  // The request itself is wrong, and repeating it will not help.
  OPERATION_ID_REQUIRED: 422,
  EXPECTED_REVISION_REQUIRED: 422,
  TRANSITION_PROTECTED: 422,
  FIELD_NOT_WRITABLE: 422,
  FIELD_NOT_SLOTTED: 422,
  FIELD_NOT_GROUPABLE: 422,
  FIELD_UNKNOWN: 422,
  VIEW_HOP_LIMIT: 422,
  SLOT_RESERVED: 422,
  SLOT_TYPE_EXHAUSTED: 422,
  SLOT_INDEX_ABSENT: 422,
  SLOT_UNKNOWN: 422,
  PLACEMENT_IS_DERIVED: 422,
  FIELD_VALUE_INVALID: 422,
  COMMAND_BODY_INVALID: 400,
  PROPOSAL_SCOPE_EXCEEDED: 422,
  AUDIENCE_NOT_PERMITTED: 422,

  // The operation is declared and what it rests on has not been built. Not a
  // permission problem and not a bad request, and saying so is the honest
  // answer rather than a 404 that reads as "no such endpoint".
  DEPENDENCY_NOT_LANDED: 501,
};

export function statusFor(code: RefusalCode): 400 | 401 | 403 | 404 | 409 | 422 | 501 {
  return STATUS[code] as 400 | 401 | 403 | 404 | 409 | 422 | 501;
}
