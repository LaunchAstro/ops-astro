// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent entry's operand readers for pickup, handback and the lease
// renewals, apart from the operation table (`agent-operations.ts`) so each
// file stays within its length. Each reads the request before any authority.

import { refuseCommand } from './refusal.ts';
import { isFieldMap } from './operands.ts';
import { refuseUnstorable, unstorableOperands } from './values.ts';
import { refuseActualMinor, refuseFence, refuseOutcome, refuseReport } from './tasks-handback.ts';
import { MAXIMUM_LEASE_SECONDS, refuseReservationBody } from './tasks-pickup.ts';
import { leaseSecondsFixes } from './tasks-lease.ts';
import { refused, type Refused } from './outcome.ts';
import type {
  AgentRequest,
  HandbackOperands,
  LeaseOperands,
  PickupOperands,
} from './agent-call.ts';

/**
 * The operands' shape rules. A present operand of the wrong shape is refused
 * by name. It is never the default in disguise, and a report is never dropped
 * or turned into an object with numeric keys: a caller that sent something
 * and got the default back would believe the server had read what it sent.
 * Absent keeps the default. Range belongs to the handler
 * (`pickupReservation`, `heartbeatLease`), which already refuses an
 * out-of-range lease in the same code.
 */
export function leaseSecondsOperand(
  maximum: number,
): (request: AgentRequest) => LeaseOperands | Refused {
  return (request) => {
    if (!('leaseSeconds' in request)) return {};
    const seconds = request['leaseSeconds'];
    if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0) {
      // The person entry's words for the same route (`readLeaseSeconds`), so
      // the two entries tell a caller one thing.
      return refused(
        refuseCommand('FIELD_VALUE_INVALID', ['leaseSeconds'], leaseSecondsFixes(maximum)),
        {
          leaseSeconds: seconds,
        },
      );
    }
    return { leaseSeconds: seconds };
  };
}

/**
 * The reservation a pickup names, as the string it was sent as. Anything else
 * is the person entry's refusal in its words (`pickupAsPerson`): `String(...)`
 * would turn `[id]` into the id and claim it.
 * Whether the string names a claimable reservation is the handler's.
 */
export function pickupOperands(request: AgentRequest): PickupOperands | Refused {
  const reservationId = request['reservationId'];
  if (typeof reservationId !== 'string') return refuseReservationBody();
  const lease = leaseSecondsOperand(MAXIMUM_LEASE_SECONDS)(request);
  if ('refusal' in lease) return lease;
  return { ...lease, reservationId };
}

export function handbackOperands(request: AgentRequest): HandbackOperands | Refused {
  // The outcome and the fence by their JSON type, in the order and words the
  // person handler asks them (`tasks-handback.ts`), and passed on as sent:
  // `String(["completed"])` is `"completed"` and `Number("1")` is `1`, which
  // would settle a lease and, past a lapsed grant, keep a report the restricted
  // intake keeps only when otherwise valid. Whether the
  // string is an outcome and the number a fence is the handler's.
  const outcome = request['outcome'];
  if (typeof outcome !== 'string') return refuseOutcome(outcome);
  const fence = request['fence'];
  if (typeof fence !== 'number') return refuseFence(fence);
  // A lease id that is not a string names no lease, and the handler answers
  // it as one that does not exist.
  const leaseId = typeof request['leaseId'] === 'string' ? request['leaseId'] : '';
  let operands: HandbackOperands = { leaseId, outcome, fence };
  if ('report' in request) {
    const report = request['report'];
    if (!isFieldMap(report)) return refuseReport(report);
    operands = { ...operands, report };
  }
  // A report or successor the stores cannot hold, by name and before any
  // authority is read, so a refusal that would retain the report never
  // reaches the insert that raised on it: the person path's rule, at its door
  // (`prepare.ts`, `values.ts`).
  const unstorable = unstorableOperands(request, ['report', 'successor']);
  if (unstorable.length > 0) return refused(refuseUnstorable(unstorable));
  // Any non-null actual is refused here, before authority is read, and not
  // only by the runtime past it. A handback refused on authority reaches the
  // restricted report intake (`retainLateHandback`), which keeps an otherwise
  // valid report; one claiming spend nothing in this head can have made is
  // not one, and is kept by no path (API.md). `null` and
  // absent are the same request.
  if ('actualMinor' in request) {
    const actualMinor = request['actualMinor'];
    if (actualMinor !== null && actualMinor !== undefined) return refuseActualMinor(actualMinor);
    operands = { ...operands, actualMinor: null };
  }
  return operands;
}
