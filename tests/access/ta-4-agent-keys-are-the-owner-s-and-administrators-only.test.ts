// SPDX-License-Identifier: AGPL-3.0-only
//
// TA-4 presets (ops-astro-roadmap #869): an agent key is for the owner and administrators only
// (owner decision, 1 October 2026, P4-3). Role presets are not built yet (ARCHITECTURE.md), so the
// real role grants are the production owner's (scripts/ops/production-bootstrap.ts). No grant can
// carry `credential:write`: the catalogue has no `credential` key and access.write refuses a
// self-scoped collection, so a member, a client-portal person or an outside party never gets one.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

/** The leading comment of a source file, its `//` lines joined into one line of text. */
function headerComment(file: string): string {
  const lines = readFileSync(resolve(import.meta.dirname, '../..', file), 'utf8').split('\n');
  const end = lines.findIndex((line) => !line.startsWith('//'));
  return lines
    .slice(0, end)
    .map((line) => line.replace(/^\/\/ ?/u, ''))
    .join(' ')
    .replaceAll(/\s+/gu, ' ');
}

it('TA-4 comment: the permission keys say agent keys are the owner’s and administrators’ only', () => {
  const header = headerComment('packages/core-wire/src/permission-keys.ts');
  const sentences = header.split(/(?<=\.)\s+/u);
  // No sentence gives `credential:write` to every signed-in person (the stale claim, #869).
  for (const sentence of sentences.filter((s) => /every signed-in person/iu.test(s)))
    expect(sentence, sentence).not.toContain('credential:write');
  // And one says whose it is.
  expect(
    sentences.some(
      (s) => s.includes('`credential:write`') && /owner.{0,20}administrators.{0,10}only/iu.test(s),
    ),
    header,
  ).toBe(true);
});
