// SPDX-License-Identifier: AGPL-3.0-only
//
// FR1-DBTEST #62: the seeded roles against the command surface, and the
// acceptance cast against the seeded roles.
//
// Twice a surface action the seeded roles lacked (settings:manage, then
// task:decide) passed the in-process matrix and was found only over HTTP
// against the live stack (scripts/local-seed.mjs, the comments on those two
// lines). The matrix grants from tests/acceptance/cast.ts, not from the seed,
// so nothing in the suite read the seed's table. This reads it.
//
// The seed runs on import, so its table is read from the source text, and the
// case below fails loudly if that text stops parsing as one object literal.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_SURFACE } from '../../packages/core-records/src/commands/surface.ts';
import { ADMIN_ACTIONS, ADMIN_COLLECTIONS, MEMBER_ACTIONS } from './cast.ts';

type Pair = readonly [collection: string, action: string];

function seededRoles(): Readonly<Record<string, readonly Pair[]>> {
  const source = readFileSync(resolve(import.meta.dirname, '../../scripts/local-seed.mjs'), 'utf8');
  const start = source.indexOf('const GRANTS_BY_ROLE = {');
  const end = source.indexOf('\n};\n', start);
  if (start === -1 || end === -1)
    throw new Error('GRANTS_BY_ROLE is not in scripts/local-seed.mjs');
  const literal = source.slice(start + 'const GRANTS_BY_ROLE = '.length, end + 2);
  // The literal is data: arrays of string pairs and comments, nothing else.
  // oxlint-disable-next-line no-new-func
  return new Function(`return (${literal});`)() as Record<string, readonly Pair[]>;
}

const roles = seededRoles();
const held = (role: string): readonly string[] =>
  (roles[role] ?? []).map(([collection, action]) => `${collection}:${action}`).toSorted();

/**
 * What each declaration asks the grant model about. `preset.plan` takes
 * `manage` on the family the request names (surface.ts), and the seeded
 * family is `task`. `session.capabilities` asks about nothing: it reports
 * what the caller holds.
 */
const asked = COMMAND_SURFACE.filter((each) => each.name !== 'session.capabilities')
  .map((each) =>
    each.name === 'preset.plan' ? 'task:manage' : `${each.collection}:${each.action}`,
  )
  .filter((pair, index, all) => all.indexOf(pair) === index)
  .toSorted();

describe('the seeded roles', () => {
  it('reads the seed table', () => {
    expect(Object.keys(roles).toSorted()).toStrictEqual(['admin', 'external', 'member', 'none']);
  });

  it('gives the seeded admin every grant a declaration on the surface asks for', () => {
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.filter((pair) => !held('admin').includes(pair))).toStrictEqual([]);
  });

  it('gives the seeded member exactly what docs/local/PROOFS.md says it holds', () => {
    expect(held('member')).toStrictEqual([
      'person:read',
      'settings:read',
      'task:assign',
      'task:read',
      'task:write',
    ]);
  });

  it('gives no grant to the none and external roles', () => {
    expect(held('none')).toStrictEqual([]);
    expect(held('external')).toStrictEqual([]);
  });
});

describe('the acceptance cast against the seed', () => {
  // cast.ts names the difference and PROOFS.md records it; this pins it, so
  // the next difference is a red case rather than a sentence nobody reread.
  it('differs from the seeded member only by task:comment added and the two reads left out', () => {
    const cast = MEMBER_ACTIONS.map((action) => `task:${action}`).toSorted();
    expect(cast.filter((pair) => !held('member').includes(pair))).toStrictEqual(['task:comment']);
    expect(held('member').filter((pair) => !cast.includes(pair))).toStrictEqual([
      'person:read',
      'settings:read',
    ]);
  });

  it('gives the fixture admin every grant the seeded admin holds', () => {
    const cast = new Set(
      ADMIN_COLLECTIONS.flatMap((collection) =>
        ADMIN_ACTIONS.map((action) => `${collection}:${action}`),
      ),
    );
    expect(held('admin').filter((pair) => !cast.has(pair))).toStrictEqual([]);
  });
});
