// SPDX-License-Identifier: AGPL-3.0-only
//
// The surface, checked against the model rather than against itself.
//
// Minimum contract 5.3's fourth assertion is the one this file exists for:
// "for each protected field, the owning operation named in `owning_operation`
// exists and is reachable through an endpoint. A protected field whose owning
// operation does not exist is a field nobody can change." The names are in
// `field_defs`, written per business at install time, so the check reads the
// installed model and not a list in a module — which is the whole reason T1e
// put the classification in the data.
//
// It is also what settles the count. The contract names nine commands and the
// split is titled after them; the seeded task type names ten owning
// operations. Nine is not enough for the model that landed, and this is where
// that stops being an argument and becomes a failing test.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { installSpine } from './fixture.ts';
import { readFieldDefinitions } from '../../packages/core-records/src/records/field-store.ts';
import {
  COMMAND_SURFACE,
  CONTRACT_NINE,
  NOT_LANDED,
  READS,
  declarationOf,
  pathOf,
  type CommandName,
} from '../../packages/core-records/src/commands/surface.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('command surface: DATABASE_URL is unset, so nothing below ran, nothing is proved.');
}

describe('the surface as a table', () => {
  it('carries the contract’s nine, named', () => {
    expect([...CONTRACT_NINE].toSorted()).toStrictEqual([
      'task.comment',
      'task.complete',
      'task.create',
      'task.decide',
      'task.handback',
      'task.pickup',
      'task.propose',
      'task.reopen',
      'task.update',
    ]);
  });

  it('has nothing left that is declared and not built', () => {
    // Empty, and that is the visible diff this list exists to produce. It held
    // five, then four when L2 installed the comment record type, and now none:
    // `task.propose`, `task.decide`, `task.pickup` and `task.handback` became
    // real commands against L4's runtime, so each one's `waitingOn` text went
    // in the same commit as its test.
    expect([...NOT_LANDED].toSorted()).toStrictEqual([]);
    for (const command of COMMAND_SURFACE) {
      expect(command.waitingOn, command.name).toBe('');
      expect(command.landed, command.name).toBe(true);
    }
  });

  it('gives every command a path nothing else has', () => {
    const paths = COMMAND_SURFACE.map((command) => pathOf(command.name));
    expect(new Set(paths).size).toBe(paths.length);
    // Every path is a collection and an operation. `person.list` was the first
    // row whose collection is not `task` and there are now four prefixes, so
    // the shape is what is asserted rather than the one prefix that happened
    // to be true of the writes.
    expect(paths.every((path) => /^\/(?:task|person|preset|settings)\/[a-z_]+$/u.test(path))).toBe(
      true,
    );
  });

  it('declares the five reads as reads, and everything else as a write', () => {
    expect([...READS].toSorted()).toStrictEqual([
      'person.list',
      'preset.plan',
      'task.board',
      'task.queue',
      'task.read',
    ]);
    for (const command of COMMAND_SURFACE) {
      expect(command.kind === 'read', command.name).toBe(READS.includes(command.name));
      // A read has nothing to be stale against. It does not always take the
      // `read` action: `preset.plan` writes nothing and still asks for
      // `manage` on presets, which is why the action is on the declaration
      // rather than assumed from the kind.
      if (command.kind === 'read') {
        expect(command.targetsExistingRecord, command.name).toBe(false);
        expect(command.landed, command.name).toBe(true);
      }
    }
  });

  it('gives every declaration the collection its authority is checked against', () => {
    // The collection used to be written into `prepareCommand` as `'task'`,
    // which was true while every operation was a task operation. A caller
    // holding `manage` on tasks would have been handed the preset planner and
    // both settings commands for free the moment one was not.
    const collections = new Map(
      COMMAND_SURFACE.map((command) => [command.name, command.collection]),
    );
    expect(collections.get('task.create')).toBe('task');
    expect(collections.get('person.list')).toBe('person');
    expect(collections.get('preset.plan')).toBe('preset');
    expect(collections.get('settings.set_four_eyes_threshold')).toBe('settings');
    expect(collections.get('settings.set_client_sign_off')).toBe('settings');
    for (const command of COMMAND_SURFACE) {
      expect(command.collection, command.name).toMatch(/^[a-z][a-z_]*$/u);
    }
  });

  // A case asserting that every action is one of the seven a grant can carry
  // was removed: `action` is typed `Action`, so an eighth is a type error and
  // the case could not fail. What is worth checking is that the actions are
  // not all the same one, which is what would happen if a declaration were
  // copied rather than decided.
  it('does not give every command the same action', () => {
    const actions = new Set(COMMAND_SURFACE.map((command) => command.action));
    expect([...actions].toSorted()).toStrictEqual([
      'assign',
      'comment',
      'decide',
      'manage',
      'read',
      'share',
      'write',
    ]);
  });
});

describe.skipIf(serverUrl === undefined)('the surface against the installed model', () => {
  let db: FreshDatabase;
  let business: string;
  let named: readonly string[];

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'f' });
    business = await insertBusiness(db.app, 'surface');
    const spine = await installSpine(db.app, business);
    const fields = await db.app.withBusiness(
      business,
      async (tx) => await readFieldDefinitions(tx, spine.taskTypeId),
    );
    // Both columns: the operation that owns a field always, and the one that
    // owns it when the write crosses a containment boundary.
    const operations = new Set<string>();
    for (const field of fields) {
      for (const name of field.owningOperation?.split(' ') ?? []) operations.add(name);
      if (field.escalatingOperation !== null) operations.add(field.escalatingOperation);
    }
    named = [...operations].toSorted();
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('finds every operation the model names in the surface', () => {
    const missing = named.filter((name) => declarationOf(name as CommandName) === undefined);
    expect(missing).toStrictEqual([]);
  });

  it('finds ten of them, which is what makes nine commands too few', () => {
    expect(named).toStrictEqual([
      'task.assign',
      'task.complete',
      'task.move',
      'task.reopen',
      'task.reparent',
      'task.set_audience',
      'task.set_party',
      'task.set_stage',
      'task.start',
      'task.triage',
    ]);
    // Ten names, and only two of them — complete and reopen — are among the
    // contract's nine commands. The other eight are why this part declares
    // more than nine, and `task.rank` is an eleventh operation the mechanics
    // need that neither list carries.
    expect(named.filter((name) => CONTRACT_NINE.includes(name as CommandName))).toStrictEqual([
      'task.complete',
      'task.reopen',
    ]);
    expect(declarationOf('task.rank')).toBeDefined();
  });

  it('gives every named operation a landed implementation, not a declaration', () => {
    for (const name of named) {
      expect(declarationOf(name as CommandName)?.landed, name).toBe(true);
    }
  });
});
