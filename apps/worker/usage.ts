// SPDX-License-Identifier: AGPL-3.0-only
// Red-first stub: the reporter port T2b's tests name, not yet built.

export interface UsageReporter {
  readonly estimate: (step: { readonly kind: string }) => number;
  readonly observe: (step: { readonly kind: string }) => number | null;
}
