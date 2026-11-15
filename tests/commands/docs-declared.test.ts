// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs, the thin slice (#2493 piece 1, the folder rename and move of piece 4a #2514): how its
// commands are declared and which docs keys a grant may carry. Database-free; the commands
// themselves are in `docs-commands.test.ts` and `docs-folder-moves.test.ts`.

import { describe, expect, it } from 'vitest';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { isGrantableKey } from '../../packages/core-wire/src/permission-keys.ts';

const row = (name: string) => {
  const found = COMMAND_SURFACE.find((each) => each.name === name);
  return [found?.kind, found?.collection, found?.action, found?.authorisedOn, found?.agent];
};

describe('docs commands are declared', () => {
  it('each docs write is docs:write on the business, and no agent reaches one until the agent path is served', () => {
    for (const name of [
      'docs.create_folder',
      'docs.create_page',
      'docs.update_page',
      'docs.rename_folder',
      'docs.move_folder',
    ]) {
      expect(row(name), name).toStrictEqual(['write', 'docs', 'write', 'business', 'never']);
    }
  });

  it('docs:read, docs:write and docs:decide are keys a grant may carry', () => {
    expect(['read', 'write', 'decide'].map((action) => isGrantableKey('docs', action))).toEqual([
      true,
      true,
      true,
    ]);
    expect(isGrantableKey('docs', 'manage')).toBe(false);
  });
});
