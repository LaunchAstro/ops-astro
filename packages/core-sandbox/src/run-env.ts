// SPDX-License-Identifier: AGPL-3.0-only
//
// B3 (docs/plan/sandbox-contract.md, section 4). Stub.

import type { SiteRecord } from './site-record.ts';

export function s1Env(base: readonly string[], record: SiteRecord): string[] {
  return [...base, ...record.buildEnv.map(([name, value]) => `${name}=${value}`)];
}

export function s2Env(base: readonly string[]): string[] {
  return [...base];
}
