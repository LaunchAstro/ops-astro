// SPDX-License-Identifier: AGPL-3.0-only
//
// The successor a handback may ask for, read from the caller's body. Split out
// unchanged when the one task-runtime module was divided (thermo review
// b282216, H2).

import { type SuccessorRequest } from '../../../core-runtime/src/index.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type Refused } from './outcome.ts';
import { EXPIRY_FIX, expiryFrom } from './expiry.ts';

/**
 * The fields of a successor the server writes rather than the caller.
 *
 * One list and both spellings, for the same reason `SYSTEM_OWNED_FIELDS` keeps
 * both: a boundary that refused the camel case and accepted the snake case
 * would be a boundary a caller gets past by changing an underscore.
 */
const SUCCESSOR_SERVER_OWNED: readonly string[] = ['proposedByActorId', 'proposed_by_actor_id'];

const SUCCESSOR_ACTOR_FIXES: readonly string[] = [
  'The successor is recorded as proposed by the actor of your session, and that is not a field a body may send: remove it and send the request again.',
  'A body that could name the proposing actor could record a proposal as somebody else’s, which is the claim this boundary exists to refuse.',
];

/** A read successor, or the refusal that says why the body is not one. */
type ReadSuccessor = { readonly successor: SuccessorRequest } | Refused;

function invalidSuccessor(name: string, fix: string, attempted: unknown): Refused {
  return refused(refuseCommand('FIELD_VALUE_INVALID', [name], [fix]), { [name]: attempted });
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The caller's half of a successor, checked key by key.
 *
 * The half a caller sends is `purpose`, `maximumMinor`, `currency`, `payload`,
 * `step` and `expiresInSeconds`. The actor is the session's and is added here, after
 * a body carrying one of its spellings has been refused: `FIELD_NOT_WRITABLE`
 * naming the key, which is the answer `prepare.ts` gives for every other field
 * the server owns. Overwriting it quietly would leave a caller believing it
 * had chosen the proposing actor, and D06 is the rule against exactly that.
 *
 * What is *not* checked here is whether the successor fits: the ceiling, the
 * currency and the lineage's rounds are bounds L4 reads under the handback's
 * own locks and answers with `SUCCESSOR_OUT_OF_BOUNDS`. A second copy of those
 * three here would be a second answer to one question.
 */
export function readSuccessor(raw: unknown, proposer: string): ReadSuccessor {
  if (!isObject(raw)) {
    return invalidSuccessor(
      'successor',
      'A successor is an object with a purpose, a maximum, a currency, a payload and a step.',
      raw,
    );
  }

  const claimed = SUCCESSOR_SERVER_OWNED.find((field) => field in raw);
  if (claimed !== undefined) {
    return refused(
      refuseCommand('FIELD_NOT_WRITABLE', [`successor.${claimed}`], SUCCESSOR_ACTOR_FIXES),
      { [`successor.${claimed}`]: raw[claimed] },
    );
  }

  const purpose = raw['purpose'];
  if (typeof purpose !== 'string' || purpose === '') {
    return invalidSuccessor(
      'successor.purpose',
      'Name the purpose the successor works to.',
      purpose,
    );
  }
  const maximumMinor = raw['maximumMinor'];
  if (typeof maximumMinor !== 'number' || !Number.isSafeInteger(maximumMinor)) {
    return invalidSuccessor(
      'successor.maximumMinor',
      'Name the ceiling as a whole number of minor units.',
      maximumMinor,
    );
  }
  const currency = raw['currency'];
  if (typeof currency !== 'string' || currency === '') {
    return invalidSuccessor(
      'successor.currency',
      'Name the currency the envelope holds, as a three-letter code.',
      currency,
    );
  }
  const payload = raw['payload'];
  if (!isObject(payload)) {
    return invalidSuccessor('successor.payload', 'The payload is an object.', payload);
  }
  const step = raw['step'];
  if (!isObject(step) || typeof step['kind'] !== 'string' || !isObject(step['payload'])) {
    return invalidSuccessor(
      'successor.step',
      'A step is an object with a kind and a payload object.',
      step,
    );
  }

  // A duration, turned into an instant here exactly as `proposeOnTask` turns
  // its own, so the caller never names the instant. The absolute spelling this
  // field used to take is refused by name rather than ignored: a caller still
  // sending it would otherwise get the default week while believing it had
  // chosen a date. L4's `SuccessorRequest` still takes the instant.
  if ('expiresAt' in raw) {
    return invalidSuccessor(
      'successor.expiresAt',
      'A successor names its expiry as expiresInSeconds, a duration the server adds to its own clock.',
      raw['expiresAt'],
    );
  }
  const expiresAt = expiryFrom(raw['expiresInSeconds']);
  if (expiresAt === undefined) {
    return invalidSuccessor('successor.expiresInSeconds', EXPIRY_FIX, raw['expiresInSeconds']);
  }

  return {
    successor: {
      proposedByActorId: proposer,
      purpose,
      maximumMinor,
      currency,
      payload: { ...payload },
      step: { kind: step['kind'], payload: { ...(step['payload'] as Record<string, unknown>) } },
      expiresAt,
    },
  };
}
