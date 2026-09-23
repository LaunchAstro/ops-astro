// SPDX-License-Identifier: AGPL-3.0-only
//
// L4's fifteen refusal codes, as L3 registers them.
//
// `RuntimeRefusalCode` is exported from `core-runtime` and deliberately not
// added to `commands/register.ts` by that package: the register is this unit's
// file, and a module reaching into the command surface to add its own codes is
// the coupling the register exists to prevent (RUNTIME.md, "Refusal codes L3
// must register"). So the wiring is here, and these are the cases that fail
// when it is missing.
//
// Two assertions, and the second is the one with teeth. Registering a code is
// a line; giving it the status the runtime asked for is a decision, and a code
// registered with a status the runtime did not suggest is a caller told the
// wrong thing about whether to retry, re-read or raise a ceiling.

import { describe, expect, it } from 'vitest';
import {
  SUGGESTED_STATUS,
  type RuntimeRefusalCode,
} from '../../packages/core-runtime/src/refusals.ts';
import {
  CALLER_VISIBLE,
  UNPRODUCED_CODES,
  registeredRefusal,
  type RefusalCode,
} from '../../packages/core-records/src/commands/register.ts';
import { statusFor } from '../../apps/api/status.ts';

const RUNTIME_CODES = Object.keys(SUGGESTED_STATUS) as readonly RuntimeRefusalCode[];

describe('the runtime refusal codes L3 registers', () => {
  it('registers all fifteen', () => {
    expect(RUNTIME_CODES).toHaveLength(15);
    for (const code of RUNTIME_CODES) {
      expect(registeredRefusal(code as RefusalCode), code).toBeDefined();
    }
  });

  it('gives each of them the status the runtime suggested', () => {
    for (const code of RUNTIME_CODES) {
      expect(statusFor(code as RefusalCode), code).toBe(SUGGESTED_STATUS[code]);
    }
  });

  it('shows every one of them to the caller, because all fifteen are caller-visible', () => {
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
    ] as const) {
      expect(UNPRODUCED_CODES.has(code), code).toBe(false);
    }
  });
});
