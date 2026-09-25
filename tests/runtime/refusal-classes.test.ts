// SPDX-License-Identifier: AGPL-3.0-only
//
// Which side of `AnyRefusal` a code is on.
//
// `isRuntimeRefusal` answers by elimination: a code is the runtime's own unless
// it is one of L2's delegation codes. So a delegation code missing from that
// set is silently classed as a runtime one. `DELEGATION_ALREADY_LIVE` was, from
// the commit that made `task.pickup` produce it until this case was written.

import { describe, expect, it } from 'vitest';
import type { DelegationRefusalCode } from '../../packages/core-records/src/authority/delegations.ts';
import { isRuntimeRefusal, SUGGESTED_STATUS } from '../../packages/core-runtime/src/refusals.ts';

// Every member of the union, spelled out so a new one is a type error here.
const DELEGATION: Readonly<Record<DelegationRefusalCode, true>> = {
  DELEGATION_EXCLUDES_DECISION: true,
  DELEGATION_OUT_OF_PURPOSE: true,
  DELEGATION_NARROWED: true,
  DELEGATION_NOT_LIVE: true,
  DELEGATION_WIDENS: true,
  DELEGATION_ALREADY_LIVE: true,
};

const refusalOf = <C extends string>(code: C) => ({ code, reason: 'r', fix: 'f' });

describe('isRuntimeRefusal', () => {
  it('classes every delegation code as a delegation refusal, the one a pickup mints included', () => {
    for (const code of Object.keys(DELEGATION) as DelegationRefusalCode[]) {
      expect(isRuntimeRefusal(refusalOf(code)), code).toBe(false);
    }
  });

  it('classes every code the runtime suggests a status for as its own', () => {
    for (const code of Object.keys(SUGGESTED_STATUS) as (keyof typeof SUGGESTED_STATUS)[]) {
      expect(isRuntimeRefusal(refusalOf(code)), code).toBe(true);
    }
  });
});
