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
} from '../support/fresh-database.ts';
import { installSpine } from './fixture.ts';
import { readFieldDefinitions } from '../../packages/core-records/src/records/field-store.ts';
import {
  COMMAND_SURFACE,
  CONTRACT_NINE,
  READS,
  declarationOf,
  pathOf,
  type CommandName,
} from '../../packages/core-wire/src/surface.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('command surface: DATABASE_URL is unset, so nothing below ran, nothing is proved.');
}

/** The surface's reads, sorted: every other declaration is a write. */
const DECLARED_READS = [
  'conversation.list',
  'conversation.read',
  'gate.pending',
  'person.list',
  'preset.plan',
  'session.capabilities',
  'settings.read',
  'task.board',
  'task.execution',
  'task.queue',
  'task.read',
  'task.receipt',
];

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
    // Every row is built, so no row carries a "declared but not built" flag
    // and there is no list of such rows to keep empty.
    for (const command of COMMAND_SURFACE) {
      expect(Object.keys(command), command.name).not.toContain('landed');
      expect(Object.keys(command), command.name).not.toContain('waitingOn');
      expect(Object.keys(command), command.name).not.toContain('contractNine');
    }
  });

  it('gives every command a path nothing else has', () => {
    const paths = COMMAND_SURFACE.map((command) => pathOf(command.name));
    expect(new Set(paths).size).toBe(paths.length);
    // Every path is a collection and an operation. `person.list` was the first
    // row whose collection is not `task` and there are now five prefixes, so
    // the shape is what is asserted rather than the one prefix that happened
    // to be true of the writes. `session` is the fifth and the odd one: it is
    // the only collection nothing is stored in, because the read under it is
    // about the caller rather than about the business's records. `grant` and
    // `delegation` are the revocation controls': the path names the row a
    // revocation writes, and the authority it asks is still on tasks. `gate`
    // is the awaiting-review read's (MP-6-1): the gates waiting on a decision,
    // asked with `decide` on tasks. `conversation` is a person's conversation
    // with the agent (AW-03), its writes and its read at its address. `model`
    // is AW-01's call through the broker, asked of the lease's task. `run` is
    // AW-05's two answers at the budget stop; `live_correction` is C80's.
    expect(
      paths.every((path) =>
        /^\/(?:task|person|preset|settings|session|grant|delegation|budget|gate|conversation|model|run|live_correction)\/[a-z_]+$/u.test(
          path,
        ),
      ),
    ).toBe(true);
  });
});

describe('the surface as a table', () => {
  it('declares the twelve reads as reads, and everything else as a write', () => {
    expect([...READS].toSorted()).toStrictEqual(DECLARED_READS);
    for (const command of COMMAND_SURFACE) {
      expect(command.kind === 'read', command.name).toBe(READS.includes(command.name));
      // A read has nothing to be stale against. It does not always take the
      // `read` action: `preset.plan` writes nothing and still asks for
      // `manage` on presets, which is why the action is on the declaration
      // rather than assumed from the kind.
      if (command.kind === 'read') {
        expect(command.targetsExistingRecord, command.name).toBe(false);
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
    // `settings.read` is on the same collection as the two writes and takes a
    // different action, which is the whole of the asymmetry: every member may
    // see a setting, and changing one is `manage`.
    expect(collections.get('settings.read')).toBe('settings');
    expect(declarationOf('settings.read').action).toBe('read');
    expect(declarationOf('settings.set_four_eyes_threshold').action).toBe('manage');
    expect(collections.get('session.capabilities')).toBe('session');
    for (const command of COMMAND_SURFACE) {
      expect(command.collection, command.name).toMatch(/^[a-z][a-z_]*$/u);
    }
  });
});

describe("AW-05's answers at the budget stop", () => {
  it('asks decide on billing for a top-up and on gate for the end', () => {
    // A top-up is money, the end is a gate, and both decide.
    expect(declarationOf('run.top_up').collection).toBe('billing');
    expect(declarationOf('run.end_at_budget_stop').collection).toBe('gate');
    expect(declarationOf('run.top_up').action).toBe('decide');
    expect(declarationOf('run.end_at_budget_stop').action).toBe('decide');
  });
});

describe("MP-6-2's state revised", () => {
  it('asks write on run of the named task, and an agent reaches it only under its delegation', () => {
    // run:write alone (ORCH33): no read, decide, share or manage on run.
    const row = declarationOf('run.revise_state');
    expect([row.collection, row.action, row.authorisedOn, row.agent]).toStrictEqual([
      'run',
      'write',
      'record',
      'delegated',
    ]);
    expect(row.targetsExistingRecord).toBe(false);
  });
});

describe('the surface as a table', () => {
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
    const declared = new Set<string>(COMMAND_SURFACE.map((command) => command.name));
    const missing = named.filter((name) => !declared.has(name));
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
    expect(declarationOf('task.rank').name).toBe('task.rank');
  });

  it('gives every named operation a write with a handler, not a declaration', () => {
    // `HANDLERS` (`handlers.ts`) is a mapped type over every write, so a write
    // row is a handler by construction.
    for (const name of named) {
      expect(declarationOf(name as CommandName).kind, name).toBe('write');
    }
  });
});
