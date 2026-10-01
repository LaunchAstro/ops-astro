// SPDX-License-Identifier: AGPL-3.0-only
//
// The gate codes' production constructors (T2g, build plan section 5), so each
// producer raises its code one way and a test can name the constructor. Split
// from the refusal register (`register.ts`), whose table and rules they build
// on, to keep that file under the product file limit.

import { refuseCommand, type CommandRefusal } from './register.ts';

/** Completing a task while a gate on it is open (contract 4.3, `task.complete`). */
export function gatePending(): CommandRefusal<'GATE_PENDING'> {
  return refuseCommand(
    'GATE_PENDING',
    [],
    [
      'An approval gate on this task is still open, so the task is not complete.',
      'Decide the gate, or let it expire, then complete the task.',
    ],
  );
}

/** A second decision on a gate that carries one (G03). */
export function gateAlreadyDecided(
  gateId: string,
  state: string,
): CommandRefusal<'GATE_ALREADY_DECIDED'> {
  return refuseCommand(
    'GATE_ALREADY_DECIDED',
    [],
    [
      `gate ${gateId} is ${state}`,
      'Read the decision that was recorded. A second decision on one version is never taken.',
    ],
  );
}

/** A comment in an audience this caller may not write in. */
export function audienceNotPermitted(fix: string): CommandRefusal<'AUDIENCE_NOT_PERMITTED'> {
  return refuseCommand('AUDIENCE_NOT_PERMITTED', ['audience'], [fix]);
}

/** The task's assignee asked to decide its own gate: another person decides. */
export function fourEyesRequired(): CommandRefusal<'FOUR_EYES_REQUIRED'> {
  return refuseCommand(
    'FOUR_EYES_REQUIRED',
    [],
    [
      'The task is assigned to you, so its gate is decided by someone else.',
      'Ask another person who holds the decision grant on this task.',
    ],
  );
}
