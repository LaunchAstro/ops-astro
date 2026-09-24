// SPDX-License-Identifier: AGPL-3.0-only
//
// L4's twenty refusal codes, as L3 registers them. The twentieth is
// `TRANSITION_NOT_PERMITTED`, which `task.restart` added for a lineage that is
// live, completed or already restarted (`core-runtime/src/propose.ts`).
//
// `RuntimeRefusalCode` is read off the register's rows marked `runtime`, and
// each row carries its status, so a runtime code cannot be unregistered or
// carry a second status the way it could when `core-runtime` spelled its own
// union and `SUGGESTED_STATUS` beside `apps/api/status.ts` (architecture review
// bbdf2b2, candidate 2). What was a four-way parity check is now a derivation
// check: `SUGGESTED_STATUS` and `statusOf` are two views of one column and
// the cases below hold them to it. The statuses themselves are pinned by
// value in `tests/commands/refusal-catalogue.test.ts`.

import { describe, expect, it } from 'vitest';
import {
  SUGGESTED_STATUS,
  type RuntimeRefusalCode,
} from '../../packages/core-runtime/src/refusals.ts';
import {
  CALLER_VISIBLE,
  UNPRODUCED_CODES,
  registeredRefusal,
  statusOf,
  type RefusalCode,
} from '../../packages/core-records/src/commands/register.ts';

const RUNTIME_CODES = Object.keys(SUGGESTED_STATUS) as readonly RuntimeRefusalCode[];

describe('the runtime refusal codes L3 registers', () => {
  it('registers all twenty', () => {
    expect(RUNTIME_CODES).toHaveLength(20);
    for (const code of RUNTIME_CODES) {
      expect(registeredRefusal(code as RefusalCode), code).toBeDefined();
    }
  });

  it('gives each of them the status the runtime suggested', () => {
    for (const code of RUNTIME_CODES) {
      expect(statusOf(code as RefusalCode), code).toBe(SUGGESTED_STATUS[code]);
    }
  });

  it('shows every one of them to the caller, because all twenty are caller-visible', () => {
    for (const code of RUNTIME_CODES) {
      expect(CALLER_VISIBLE.has(code as RefusalCode), code).toBe(true);
    }
  });

  it('leaves the ones an operation now produces off the unproduced list', () => {
    // The codes the four real commands and the agent path can answer with.
    // Each comes off `UNPRODUCED_CODES` in the commit that makes it reachable,
    // which is the diff that list exists to produce.
    for (const code of [
      'GATE_ALREADY_DECIDED',
      'VERSION_SUPERSEDED',
      'LEASE_NOT_OWNED',
      'RESERVATION_NOT_CLAIMABLE',
      'GATE_NOT_FOUND',
      'LINEAGE_TERMINAL',
      'PROPOSAL_OUT_OF_SCOPE',
      'AUTH_NO_AGENT_IDENTITY',
      'AUTH_SESSION_EXPIRED',
      'DELEGATION_OUT_OF_PURPOSE',
      'DELEGATION_EXCLUDES_DECISION',
      'DELEGATION_NOT_LIVE',
      // L4's three review-fix codes. Each is reachable from a field the caller
      // fills in: `task.propose` takes the lineage and the currency, and
      // `task.handback` takes the actual. `register.ts` says of each which
      // path reaches it.
      'LINEAGE_NOT_ON_TASK',
      'CAP_BINDING_MISMATCH',
      'ACTUAL_EXPENDITURE_UNSUPPORTED',
      // L4-RUNTIME-FIX-2's successor code. `task.handback` takes the successor
      // the caller asks for, so a successor outside the purpose the work was
      // held under is an ordinary request the runtime refuses.
      'SUCCESSOR_OUT_OF_BOUNDS',
      // Reached through the command envelope in
      // `tests/commands/unproduced-reach.test.ts`: a person approving a gate
      // proposed with a one-second window, and a third request for changes on
      // one lineage.
      'GATE_EXPIRED',
      'CHANGE_ROUNDS_EXHAUSTED',
    ] as const) {
      expect(UNPRODUCED_CODES.has(code), code).toBe(false);
    }
  });
});

// `DELEGATION_ALREADY_LIVE` is not a runtime code -- it is an authority
// refusal, and it is not one of the twenty above. `mintDelegation` in
// `authority/delegations.ts` raises it for a second live delegation under a
// purpose the agent already holds; `task.pickup` in `core-runtime` mints
// through that function and hands the refusal back as an `AnyRefusal`, and
// `fromRuntime` (`commands/refusal.ts`) registers it like any runtime
// code. That is the same road `DELEGATION_NOT_LIVE` and
// `DELEGATION_OUT_OF_PURPOSE` already travel, and neither is counted in the
// twenty either: the census above is `SUGGESTED_STATUS`, the runtime's own
// codes and the statuses it asked for, and a code the runtime passes through
// without owning is not the runtime's to suggest a status for. So it is not
// counted there, and the case below holds it to the list that matters to a
// caller -- produced or not. The HTTP proof is the pickup case in
// `tests/api/task-runtime-routes.test.ts` ("refuses a second live delegation
// for one purpose instead of faulting"), which asserts the 409 and the audit
// row.
describe('the delegation code a pickup now produces', () => {
  it('registers it, gives it 409, and shows it to the caller', () => {
    expect(registeredRefusal('DELEGATION_ALREADY_LIVE')).toBeDefined();
    expect(statusOf('DELEGATION_ALREADY_LIVE')).toBe(409);
    expect(CALLER_VISIBLE.has('DELEGATION_ALREADY_LIVE')).toBe(true);
  });

  it('is not one of the runtime codes, so the twenty do not count it', () => {
    expect(RUNTIME_CODES).not.toContain('DELEGATION_ALREADY_LIVE');
  });

  it('has come off the unproduced list, because a pickup reaches it', () => {
    expect(UNPRODUCED_CODES.has('DELEGATION_ALREADY_LIVE')).toBe(false);
  });
});
