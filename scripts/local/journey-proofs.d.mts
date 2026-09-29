// SPDX-License-Identifier: AGPL-3.0-only
// Types for journey-proofs.mjs, which tests import.

export interface CaseLine {
  readonly case: string;
  readonly status: 'pass' | 'fail' | 'unrun';
  readonly detail: string;
}

export const PROTECTED: readonly (readonly [string, readonly string[]])[];

export function protectedVerdicts(
  output: string,
  manifest: { readonly invariant?: readonly string[]; readonly conformance?: readonly string[] },
): readonly CaseLine[];

export function builtCases(): readonly CaseLine[];
