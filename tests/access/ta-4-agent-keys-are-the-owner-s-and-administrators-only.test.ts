// SPDX-License-Identifier: AGPL-3.0-only
//
// TA-4 presets (ops-astro-roadmap #869): an agent key is for the owner and administrators only
// (owner decision, 1 October 2026, P4-3). Role presets are not built yet (ARCHITECTURE.md), so the
// real role grants are the production owner's (scripts/ops/production-bootstrap.ts). No grant can
// carry `credential:write`: the catalogue has no `credential` key and access.write refuses a
// self-scoped collection, so a member, a client-portal person or an outside party never gets one.

import { expect, it } from 'vitest';
import {
  GRANTABLE_KEYS,
  isGrantableKey,
  SELF_SCOPED_COLLECTIONS,
} from '../../packages/core-wire/src/index.ts';
import { OWNER_GRANTS } from '../../scripts/ops/production-bootstrap.ts';

/** Every real role's grants, by who holds them. Add a preset here when one is built. */
const ROLE_GRANTS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  owner: OWNER_GRANTS,
};
const MAY_ISSUE_AGENT_KEYS = new Set(['owner', 'administrator']);

it('TA-4 presets: every real role that grants credential:write is the owner or an administrator', () => {
  const holders = Object.entries(ROLE_GRANTS)
    .filter(([, grants]) => grants.some(([c, a]) => c === 'credential' && a === 'write'))
    .map(([role]) => role);
  expect(holders).toStrictEqual(['owner']);
  for (const role of holders) expect(MAY_ISSUE_AGENT_KEYS.has(role), role).toBe(true);
});

it('TA-4 presets: no grant carries credential:write, so no other person can be given an agent key', () => {
  expect(isGrantableKey('credential', 'write')).toBe(false);
  expect(GRANTABLE_KEYS.filter((key) => key.startsWith('credential:'))).toStrictEqual([]);
  // access.write refuses a grant on any of these collections (access-write.ts).
  expect(SELF_SCOPED_COLLECTIONS).toContain('credential');
});
