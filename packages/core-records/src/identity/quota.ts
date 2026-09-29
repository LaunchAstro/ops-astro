// SPDX-License-Identifier: AGPL-3.0-only
//
// Quotas (API-3, TR-SEC-4): not built yet. The table and its shape only, so
// `tests/cli/api-3-quota.test.ts` fails on what the quota does rather than on
// a missing import.

export interface QuotaLimits {
  readonly requests: {
    readonly windowMs: number;
    readonly credential: number;
    readonly person: number;
    readonly business: number;
  };
  readonly concurrent: {
    readonly credential: number;
    readonly person: number;
    readonly business: number;
  };
  readonly pageSize: { readonly standard: number; readonly most: number };
}

export const QUOTAS: QuotaLimits = {
  requests: { windowMs: 60_000, credential: 1_200, person: 1_200, business: 12_000 },
  concurrent: { credential: 16, person: 16, business: 128 },
  pageSize: { standard: 20, most: 100 },
};

export interface QuotaOptions {
  readonly limits?: QuotaLimits;
  readonly now?: () => number;
}
