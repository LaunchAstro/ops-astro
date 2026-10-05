// SPDX-License-Identifier: AGPL-3.0-only
//
// Quotas (API-3): the table its named tests read. Nothing is charged yet.

type Holder = 'credential' | 'person' | 'business';

export interface QuotaLimits {
  readonly requests: { readonly windowMs: number } & Readonly<Record<Holder, number>>;
  readonly concurrent: Readonly<Record<Holder, number>>;
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
