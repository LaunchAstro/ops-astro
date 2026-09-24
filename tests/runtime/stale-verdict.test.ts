// SPDX-License-Identifier: AGPL-3.0-only
//
// The handback's fence ladder, read without a database.
//
// `staleVerdict` is the five causes a stale holder's report is retained for,
// asked in the order `handback` asks them. Every code, reason and next step
// is spelled out here as the literal the hand-written ladder returned, so a
// word changed in the extraction is a failure here rather than a caller told
// something new. The lifecycle tests prove the same paths write the retained
// row; this file proves which answer each row carries.

import { describe, expect, it } from 'vitest';
import { staleVerdict } from '../../packages/core-runtime/src/handback.ts';

const LEASE_ID = '00000000-0000-4000-8000-000000000001';
const VERSION_ID = '00000000-0000-4000-8000-000000000002';

const live = { state: 'live', fence: '3', expired: false, current_fence: '3' };
const bound = { version_id: VERSION_ID, superseded: false, lineage_state: 'live' };
const presented = { leaseId: LEASE_ID, fence: 3 };

describe('staleVerdict', () => {
  it('refuses a fence other than the one the lease holds as not owned', () => {
    expect(staleVerdict(live, bound, { leaseId: LEASE_ID, fence: 2 })).toStrictEqual({
      code: 'LEASE_NOT_OWNED',
      reason: `lease ${LEASE_ID} holds fence 3, and fence 2 was presented`,
      fix: 'Read the fence from the pickup that issued the lease. The report is retained, not settled.',
    });
  });

  it('refuses a fence a later lease on the task has superseded as not owned', () => {
    expect(staleVerdict({ ...live, current_fence: '4' }, bound, presented)).toStrictEqual({
      code: 'LEASE_NOT_OWNED',
      reason: 'fence 3 has been superseded by 4 on this task',
      fix: 'The replacement owns the work. This report is retained, not settled.',
    });
  });

  it('refuses a lease that is no longer live as expired', () => {
    expect(staleVerdict({ ...live, state: 'released' }, bound, presented)).toStrictEqual({
      code: 'LEASE_EXPIRED',
      reason: `lease ${LEASE_ID} is released`,
      fix: 'A settled or expired lease cannot settle work. The report is retained; pick the work up again.',
    });
  });

  it('refuses a live lease past its expiry as expired', () => {
    expect(staleVerdict({ ...live, expired: true }, bound, presented)).toStrictEqual({
      code: 'LEASE_EXPIRED',
      reason: `lease ${LEASE_ID} expired before this handback`,
      fix: 'Pick the work up again under a new lease and a new fence. The report is retained.',
    });
  });

  it('refuses work on a superseded version as not owned', () => {
    expect(staleVerdict(live, { ...bound, superseded: true }, presented)).toStrictEqual({
      code: 'LEASE_NOT_OWNED',
      reason: `the version ${VERSION_ID} this lease worked has been superseded, so its work cannot settle`,
      fix: 'The report is retained, not accepted. Work the current version under a new pickup.',
    });
  });

  it('refuses work on a lineage that is no longer live as not owned', () => {
    expect(staleVerdict(live, { ...bound, lineage_state: 'rejected' }, presented)).toStrictEqual({
      code: 'LEASE_NOT_OWNED',
      reason: 'the lineage this lease worked is rejected, so its work cannot settle',
      fix: 'The report is retained, not accepted. Work the current version under a new pickup.',
    });
  });

  it('gives no verdict for the current holder of a live lease on live work', () => {
    expect(staleVerdict(live, bound, presented)).toBeNull();
    expect(staleVerdict(live, null, presented)).toBeNull();
  });

  it('answers with the first cause in the ladder when several hold', () => {
    const everything = { state: 'expired', fence: '3', expired: true, current_fence: '5' };
    const stale = { ...bound, superseded: true };
    expect(staleVerdict(everything, stale, { leaseId: LEASE_ID, fence: 1 })?.reason).toBe(
      `lease ${LEASE_ID} holds fence 3, and fence 1 was presented`,
    );
    expect(staleVerdict(everything, stale, presented)?.reason).toBe(
      'fence 3 has been superseded by 5 on this task',
    );
    expect(staleVerdict({ ...everything, current_fence: '3' }, stale, presented)?.reason).toBe(
      `lease ${LEASE_ID} is expired`,
    );
    expect(staleVerdict({ ...live, expired: true }, stale, presented)?.reason).toBe(
      `lease ${LEASE_ID} expired before this handback`,
    );
  });

  it('leaves the binding unasked until it has been read', () => {
    expect(staleVerdict(live, null, presented)).toBeNull();
    expect(staleVerdict({ ...live, expired: true }, null, presented)?.code).toBe('LEASE_EXPIRED');
  });
});
