// SPDX-License-Identifier: AGPL-3.0-only
//
// The staging reset (S0-1): not built yet.

export interface CastMember {
  readonly email: string;
  readonly business: 'A' | 'B';
  readonly person: string;
  readonly role: string;
  readonly grants?: readonly (readonly [string, string])[];
}

export const STAGING_CAST: readonly CastMember[] = [];

export const notInvented = (_cast: readonly CastMember[]): string[] => [];
