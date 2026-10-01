// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5, the catalogue's data effects and the class derived from them: the
// closed-world half of `S0-5 gate coverage` (the build fails on a command with
// no effect metadata) and the class rule, table-driven. Whether each command
// writes only what it declares is proved against a database in
// `s0-5-effect-metadata.test.ts`; the gate forced open over every class is
// held in `s0-5-first-client-gate.test.ts` until the readiness check exists.

import { describe, expect, it } from 'vitest';
import {
  COMMAND_EFFECTS,
  COMMAND_SURFACE,
  buildCatalogue,
  classOf,
  type DataEffects,
} from '../../packages/core-wire/src/index.ts';

const NONE: DataEffects = { writes: [], intake: [], outside: [], access: false };

const BUSINESS = { kind: 'business_settings', scope: 'business' } as const;
const CLIENT = { kind: 'records', scope: 'client' } as const;
/** What a command does, and the class that follows. */
const CASES: ReadonlyArray<readonly [string, DataEffects, string]> = [
  ['nothing at all', NONE, 'made-up-safe'],
  ['business-internal writes only', { ...NONE, writes: [BUSINESS] }, 'made-up-safe'],
  ['one client-scoped write', { ...NONE, writes: [BUSINESS, CLIENT] }, 'client-data'],
  ['an intake, no write', { ...NONE, intake: ['upload'] }, 'client-data'],
  [
    'an outside effect for a client',
    { ...NONE, outside: [{ provider: 'drive', forClient: true }] },
    'client-data',
  ],
  [
    'an outside effect for the business only',
    { ...NONE, writes: [BUSINESS], outside: [{ provider: 'identity', forClient: false }] },
    'made-up-safe',
  ],
  ['admits an outside person', { ...NONE, access: true }, 'invitation'],
  [
    'admits an outside person and writes client rows',
    { ...NONE, writes: [CLIENT], access: true },
    'invitation',
  ],
];

describe('S0-5 gate coverage: every command declares its data effects, and its class follows from them', () => {
  it('S0-5 gate coverage (metadata): the catalogue has no command without effect metadata, and none that is not a command', () => {
    const declared = Object.keys(COMMAND_EFFECTS).toSorted();
    const commands = COMMAND_SURFACE.map((one) => one.name).toSorted();
    expect(declared).toStrictEqual(commands);
    for (const row of buildCatalogue([])) {
      expect(row.dataEffects, row.command).not.toBeNull();
      expect(row.dataEffects?.class, row.command).toBe(classOf(COMMAND_EFFECTS[row.command]));
    }
  });

  it('S0-5 gate coverage (class): invitation if it admits an outside person, client-data if it touches a client, else made-up-safe', () => {
    for (const [what, effects, expected] of CASES) expect(classOf(effects), what).toBe(expected);
  });

  it('S0-5 gate coverage (not by name): a command is classed by what it does, whatever it is called', () => {
    // Every class the catalogue holds is the rule applied to that command's
    // metadata; a name that says "client" or "settings" changes nothing.
    const rows = buildCatalogue([]);
    const byName = new Map(rows.map((row) => [row.command, row.dataEffects?.class]));
    expect(byName.get('client.list'), 'a read, whatever its name').toBe('made-up-safe');
    expect(byName.get('client.create'), 'writes a client record').toBe('client-data');
    expect(byName.get('task.comment'), 'writes a row holding a task').toBe('client-data');
    expect(byName.get('settings.set_money_step_up'), 'business settings').toBe('made-up-safe');
  });

  it('S0-5 gate coverage (reads): a read writes nothing but its audit, so it is never client-data by its writes', () => {
    for (const declaration of COMMAND_SURFACE.filter((one) => one.kind === 'read')) {
      expect(COMMAND_EFFECTS[declaration.name].writes, declaration.name).toStrictEqual([]);
    }
  });
});
