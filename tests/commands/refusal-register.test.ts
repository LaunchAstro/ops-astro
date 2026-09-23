// SPDX-License-Identifier: AGPL-3.0-only
//
// The register is the part of T1f that two earlier lanes wrote into their own
// files and then handed on: identity's refusals say "the register itself is
// T1f's", and the records engine's say a cross-business record "belongs to
// T1f's register, not here". So the first thing these cases check is that the
// codes those parts can already produce are in it.
//
// The second thing is the row of the contract's table that is worth arguing
// with (minimum contract, 4.4): `WRONG_BUSINESS` is recorded in the audit and
// the caller sees `NOT_FOUND`. That is a mechanism, not a note, and it is
// checked here in both directions.

import { describe, expect, it } from 'vitest';
import {
  CALLER_VISIBLE,
  REFUSAL_REGISTER,
  UNPRODUCED_CODES,
  registeredRefusal,
  type RefusalCode,
} from '../../packages/core-records/src/commands/register.ts';
import {
  asCallerVisible,
  fromAuthority,
  fromIdentity,
  fromRecords,
  refuseCommand,
  refuseNotFound,
} from '../../packages/core-records/src/commands/refusal.ts';
import { refuse as refuseRecords } from '../../packages/core-records/src/records/refusals.ts';
import { refuse as refuseIdentity } from '../../packages/core-records/src/identity/refusals.ts';

const IDENTITY_CODES = ['AUTH_UNKNOWN_LOGIN', 'AUTH_NO_MEMBERSHIP', 'ACTOR_INACTIVE'] as const;

const RECORDS_CODES = [
  'FIELD_NOT_SLOTTED',
  'FIELD_NOT_GROUPABLE',
  'FIELD_UNKNOWN',
  'VIEW_HOP_LIMIT',
  'SLOT_RESERVED',
  'SLOT_TYPE_EXHAUSTED',
  'SLOT_INDEX_ABSENT',
  'SLOT_UNKNOWN',
  'TRANSITION_PROTECTED',
  'FIELD_NOT_WRITABLE',
  'NOT_FOUND',
  'PLACEMENT_IS_DERIVED',
  'PARENT_TRASHED',
  'ALREADY_TRASHED',
  'UNIQUE_VALUE_TAKEN',
  'RETENTION_CLASS_PROTECTED',
] as const;

const AUTHORITY_CODES = ['SCOPE_NOT_GRANTED', 'GRANT_WIDENS', 'GRANT_DEEPENS'] as const;

describe('the refusal register', () => {
  it('holds one entry per code and no duplicates', () => {
    const codes = REFUSAL_REGISTER.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('registers every code the parts that came before this one can produce', () => {
    for (const code of [...IDENTITY_CODES, ...RECORDS_CODES, ...AUTHORITY_CODES]) {
      expect(registeredRefusal(code as RefusalCode), code).toBeDefined();
    }
  });

  it('gives every entry a meaning and the contract row that owns it', () => {
    for (const entry of REFUSAL_REGISTER) {
      expect(entry.meaning.length, entry.code).toBeGreaterThan(10);
      expect(entry.source.length, entry.code).toBeGreaterThan(4);
    }
  });

  it('names the codes nothing produces yet, so closing one is a visible diff', () => {
    // Registered because the contract registers them; unreachable because the
    // command or the table that would produce them lands in a later part.
    expect([...UNPRODUCED_CODES].toSorted()).toStrictEqual([
      'AUDIENCE_NOT_PERMITTED',
      // The agent codes came off this list when L3 part B built the agent's
      // own API path: `AUTH_NO_AGENT_IDENTITY`, `AUTH_SESSION_EXPIRED`,
      // `DELEGATION_NOT_LIVE`, `DELEGATION_OUT_OF_PURPOSE` and
      // `DELEGATION_EXCLUDES_DECISION` are all produced by an operation a
      // caller can reach now. The six `DELEGATION_*` codes below still are not,
      // and `register.ts` says of each what it waits for. The three `PRESET_*`
      // codes are deliberately absent too — `preset.plan` produces them. So
      // are L4's three review-fix codes: `LINEAGE_NOT_ON_TASK`,
      // `CAP_BINDING_MISMATCH` and `ACTUAL_EXPENDITURE_UNSUPPORTED` are each
      // reached from a field a caller fills in on `task.propose` or
      // `task.handback`, so none of them joins this list.
      // `DELEGATION_ALREADY_LIVE` came off this list with its emitter:
      // `authority/delegations.ts` refuses a second live mint under one
      // purpose, and `task.pickup` reaches it (`tests/api/task-runtime-routes.test.ts`).
      'CHANGE_ROUNDS_EXHAUSTED',
      'DELEGATION_EXCLUDES_INTAKE',
      'DELEGATION_EXCLUDES_OPERATION',
      'DELEGATION_EXPIRED',
      'DELEGATION_NARROWED',
      'DELEGATION_REVOKED',
      'DELEGATION_WIDENS',
      'EVIDENCE_MISMATCH',
      'GATE_EXPIRED',
      'GATE_PENDING',
      'LEASE_EXPIRED',
      'LEASE_HELD',
      'PROPOSAL_SCOPE_EXCEEDED',
      'PROPOSAL_SUPERSEDED',
      'TASK_NOT_PICKABLE',
      'WRONG_BUSINESS',
    ]);
  });

  it('keeps every unproduced code inside the register', () => {
    for (const code of UNPRODUCED_CODES) {
      expect(registeredRefusal(code), code).toBeDefined();
    }
  });

  it('registers the code for a value of the wrong type, which the trigger would raise on', () => {
    expect(registeredRefusal('FIELD_VALUE_INVALID')).toBeDefined();
  });

  it('marks exactly one code as the caller never seeing it', () => {
    const hidden = REFUSAL_REGISTER.filter((entry) => entry.visibility === 'audit');
    expect(hidden.map((entry) => entry.code)).toStrictEqual(['WRONG_BUSINESS']);
    expect(CALLER_VISIBLE.has('WRONG_BUSINESS')).toBe(false);
  });
});

describe('what the caller is shown', () => {
  it('turns a wrong-business refusal into one indistinguishable from a fabricated one', () => {
    const probe = asCallerVisible(refuseCommand('WRONG_BUSINESS', ['record'], ['nothing to fix']));
    const fabricated = asCallerVisible(refuseNotFound());
    expect(probe).toStrictEqual(fabricated);
    expect(probe.code).toBe('NOT_FOUND');
  });

  it('carries no name through the translation, because a name is the inference', () => {
    const probe = asCallerVisible(
      refuseCommand('WRONG_BUSINESS', ['9f1a-the-other-business-record'], ['ask the owner']),
    );
    expect(probe.names).toStrictEqual([]);
    expect(JSON.stringify(probe)).not.toContain('other-business');
  });

  it('leaves a caller-visible refusal exactly as it was', () => {
    const stale = refuseCommand('VERSION_STALE', ['revision 4'], ['read it again']);
    expect(asCallerVisible(stale)).toStrictEqual(stale);
  });
});

describe('the three shapes that came before it', () => {
  it('normalises a records refusal, keeping its names and fixes', () => {
    const refusal = fromRecords(refuseRecords('FIELD_NOT_SLOTTED', ['owner'], ['give it a slot']));
    expect(refusal).toStrictEqual({
      refused: true,
      code: 'FIELD_NOT_SLOTTED',
      names: ['owner'],
      fixes: ['give it a slot'],
    });
  });

  it('normalises an identity refusal, which carries no names at all', () => {
    const refusal = fromIdentity(refuseIdentity('AUTH_NO_MEMBERSHIP', ['ask an administrator']));
    expect(refusal.code).toBe('AUTH_NO_MEMBERSHIP');
    expect(refusal.names).toStrictEqual([]);
  });

  it('normalises an authority refusal, whose reason and fix are single strings', () => {
    const refusal = fromAuthority({
      code: 'SCOPE_NOT_GRANTED',
      reason: 'no live grant covers it',
      fix: 'ask a holder who may delegate',
    });
    expect(refusal.code).toBe('SCOPE_NOT_GRANTED');
    expect(refusal.fixes).toStrictEqual([
      'no live grant covers it',
      'ask a holder who may delegate',
    ]);
  });

  it('refuses to build a refusal on a code nobody registered', () => {
    expect(() => refuseCommand('MADE_UP_CODE' as RefusalCode, [], [])).toThrow(/register/u);
  });
});
