// SPDX-License-Identifier: AGPL-3.0-only
//
// The `task.handback` operand shape a pickup hands its claimant. Moved out of
// `tasks-runtime.ts` unchanged (thermo review b282216, H2).

import { type PickedUp, type PickedUpByPerson } from '../../../core-runtime/src/pickup.ts';
import { type HandbackFields, OUTCOMES } from './tasks-handback.ts';
import { DELEGATION_HEADER } from './surface.ts';

/**
 * Whether an operand of the owning `task.handback` contract must be sent,
 * read off `HandbackFields` itself: a key the interface marks optional is
 * `optional`, every other is `required`.
 */
type Presence<K extends keyof HandbackFields> =
  Partial<Pick<HandbackFields, K>> extends Pick<HandbackFields, K> ? 'optional' : 'required';

interface OperandShape<K extends keyof HandbackFields> {
  readonly presence: Presence<K>;
  readonly accepts: string;
}

/**
 * The handback's own operands, keyed by `HandbackFields` (W02, root ruling 6).
 *
 * Not a second list beside the command: the mapped type makes every key of the
 * owning contract appear here exactly once, with the presence the interface
 * gives it, so an operand added to, removed from or made optional on
 * `task.handback` fails to compile until this says so. There is no
 * `expectedVersions` or `expectedRevision` key because `task.handback`
 * consumes neither; the version it is bound to is the lease's (below).
 */
const HANDBACK_OPERANDS: { readonly [K in keyof HandbackFields]-?: OperandShape<K> } = {
  leaseId: { presence: 'required', accepts: 'the leaseId this pickup returned' },
  fence: {
    presence: 'required',
    accepts:
      'the fence this pickup returned, a non-negative integer compared under the handback locks',
  },
  outcome: { presence: 'required', accepts: 'completed or failed' },
  report: {
    presence: 'optional',
    accepts: 'an object of named values; absent is an empty report',
  },
  actualMinor: {
    presence: 'optional',
    accepts: 'absent or null only: nothing in this head dispatches, so any number is refused',
  },
  successor: {
    presence: 'optional',
    accepts:
      "absent, or { purpose, maximumMinor, currency, payload, step: { kind, payload }, expiresInSeconds? } proposing the next version on this lineage with a pending gate; proposedByActorId is the server's",
  },
};

/**
 * How to hand this lease back: the declarative handback shape TRANSACTION-
 * CONTRACT line 64 asks pickup to return, derived from `HANDBACK_OPERANDS`.
 *
 * It describes and grants nothing. It names where the claimant's credential
 * travels, never the credential; the operands are the ones `task.handback`
 * reads; and the version binding is the check that exists
 * (`core-runtime/src/handback.ts`, F3): the lease is bound to one approved
 * version, and a version superseded or a lineage no longer live since pickup
 * is refused `LEASE_NOT_OWNED` with the report retained. `expectedVersions`
 * in this answer is what the work was read at, not an operand of the handback.
 */
export function handbackShapeFor(picked: PickedUp | PickedUpByPerson): Record<string, unknown> {
  const names = Object.keys(HANDBACK_OPERANDS) as (keyof HandbackFields)[];
  return {
    operation: 'task.handback',
    operationIdentity: {
      operand: 'operationId',
      presence: 'required',
      accepts: '8 to 200 letters, digits, dot, colon, dash or underscore',
      replay:
        'the same operationId with the same body replays its answer; with another body it is refused OPERATION_ID_REUSED; each new report takes a new operationId',
    },
    required: names.filter((name) => HANDBACK_OPERANDS[name].presence === 'required'),
    optional: names.filter((name) => HANDBACK_OPERANDS[name].presence === 'optional'),
    operands: HANDBACK_OPERANDS,
    lease: {
      leaseId: picked.leaseId,
      fence: picked.fence,
      binding:
        "send both exactly as returned here; a lease that has expired answers LEASE_EXPIRED, and another holder's live lease or a stale fence answers LEASE_NOT_OWNED",
    },
    outcomes: [...OUTCOMES],
    report: 'kept with the settlement as one handback report; it is not read back',
    successor:
      'optional; written in the same transaction as the settlement, never approved by it and opening no hold',
    credential:
      picked.claimant === 'agent'
        ? {
            transport: 'header',
            header: DELEGATION_HEADER,
            value: 'the credential this pickup returned, beside the agent login bearer',
          }
        : {
            transport: 'bearer',
            value: 'your own person session; a person holds no delegation credential',
          },
    versionBinding: {
      operand: null,
      versionId: picked.versionId,
      checks:
        'the lease is bound to this approved version; under its locks the handback refuses LEASE_NOT_OWNED, keeping the report, when the version was superseded or its lineage is no longer live',
      recordRevision:
        'task.handback takes no record revision; expectedVersions.taskRevision is the task as read at pickup, not a handback operand',
    },
  };
}
