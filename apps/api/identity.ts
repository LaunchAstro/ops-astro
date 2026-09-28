// SPDX-License-Identifier: AGPL-3.0-only
// Red-first stub: the signatures T2b's tests name, not yet built.

export interface ServedIdentity {
  readonly commit: string;
  readonly tree: string;
  readonly dirty: readonly string[];
  readonly pid: number;
  readonly checkout: string;
}

export interface IdentityEvidence {
  readonly api: ServedIdentity & { readonly migrationHead: string };
  readonly apiViaWeb: ServedIdentity & { readonly migrationHead: string };
  readonly web: ServedIdentity;
  readonly evidenceTree: string;
  readonly migrationFiles: string;
}

const unbuilt = (): never => {
  throw new Error('T2b: not built');
};

export const readIdentity = (_checkout: string): ServedIdentity => unbuilt();
export const migrationHead = (
  _pairs: readonly { readonly version: string; readonly checksum: string }[],
): string => unbuilt();
export const isLoopback = (_address: string | undefined): boolean => unbuilt();
export const identityDefects = (_evidence: IdentityEvidence): readonly string[] => unbuilt();
