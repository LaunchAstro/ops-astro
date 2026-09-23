// SPDX-License-Identifier: AGPL-3.0-only
//
// D01, D02, D04 and D05: the model's negatives, one per member rather than one
// per rule.
//
// The files beside this one each broke a rule once (`task_comment.body` lost
// its classification, `assignee` was relaxed to generic), and a rule shown to
// fire for one member has not been shown to fire for the others. So every case
// here is generated from the list the product itself holds (`TASK_SPINE`,
// `TASK_STATE_FIELDS`, `PROTECTED_TASK_FIELDS`), and a field added to one of
// them grows its own case with no edit to this file.
//
// Every breakage runs inside an administrative transaction that is rolled
// back, and the case then reads `field_defs` again and requires it to be the
// snapshot taken before. A negative that left the model broken would make every
// case after it pass for the wrong reason.
//
// D04 is the other direction: an owning operation that exists but has never
// been seen to write its field is a declaration, not an owner. Each owner runs
// through `executeCommand`, the envelope every surface calls, and the stored row
// is read back on the administrative connection.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import type { Finding } from '../../packages/core-records/src/tenancy/conformance.ts';
import { domainModelConformance } from '../../packages/core-records/src/records/conformance.ts';
import { taskSpineConformance } from '../../packages/core-records/src/tasks/conformance.ts';
import type { InstalledTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import {
  PROTECTED_TASK_FIELDS,
  TASK_SPINE,
  TASK_TYPE_KEY,
  type SpineField,
} from '../../packages/core-records/src/tasks/spine.ts';
import {
  TASK_STATE_FIELDS,
  TASK_STATE_TYPE_KEY,
} from '../../packages/core-records/src/tasks/states.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import type { CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { createCli } from '../../apps/cli/client.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { BUSINESS_KEY, createApiFixture, tokenFor, type ApiFixture } from '../api/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'model negatives: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

class Rollback extends Error {}

type Execute = AdminConnection['execute'];

/** Both halves of the conformance set, as the model has them. */
async function conformance(execute: Execute): Promise<readonly Finding[]> {
  return [...(await domainModelConformance(execute)), ...(await taskSpineConformance(execute))];
}

/** Break the model, ask the set, and roll back whatever the answer was. */
async function whenTheModelIs(
  db: FreshDatabase,
  breakage: (execute: Execute) => Promise<void>,
): Promise<readonly Finding[]> {
  let seen: readonly Finding[] = [];
  try {
    await db.admin.transaction(async (execute) => {
      await breakage(execute);
      seen = await conformance(execute);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return seen;
}

/** The whole field table, in one comparable string. */
async function fieldDefs(db: FreshDatabase): Promise<string> {
  const rows = await db.admin.execute(
    `select business_id, record_type_id, key, write_mode, owning_operation,
            escalating_operation, slot, visibility_class
       from public.field_defs order by business_id, record_type_id, key`,
  );
  return JSON.stringify(rows);
}

/**
 * Does a finding name this field?
 *
 * The domain set names `type.key` and the task set `business:type.key`, and
 * either counts. What does not count is `field_defs.write_mode`, the finding a
 * nullable column earns: that says the column is open, not which field went
 * through it.
 */
function named(findings: readonly Finding[], type: string, key: string): boolean {
  return findings.some(
    (finding) => finding.object === `${type}.${key}` || finding.object.endsWith(`:${type}.${key}`),
  );
}

describe.skipIf(serverUrl === undefined)('the model negatives, one per member', () => {
  let db: FreshDatabase;
  let business: string;
  let spine: InstalledTaskSpine;
  let snapshot: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'mg' });
    business = await insertBusiness(db.app, 'model-negatives');
    spine = await installSpine(db.app, business);
    snapshot = await fieldDefs(db);
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('starts from a green model', async () => {
    expect(await conformance(db.admin.execute)).toStrictEqual([]);
  });

  describe('D01: a task or task-state field losing its classification is named', () => {
    const CASES = [
      ...TASK_SPINE.map((field) => ({ type: TASK_TYPE_KEY, field })),
      ...TASK_STATE_FIELDS.map((field) => ({ type: TASK_STATE_TYPE_KEY, field })),
    ].map(({ type, field }) => ({ type, key: field.key }));

    it('covers every field of both shipped types', () => {
      expect(CASES.length).toBe(TASK_SPINE.length + TASK_STATE_FIELDS.length);
    });

    it.each([TASK_TYPE_KEY, TASK_STATE_TYPE_KEY])(
      'refuses a null write mode on %s in the schema, and writes nothing',
      async (type) => {
        const typeId = type === TASK_TYPE_KEY ? spine.taskTypeId : spine.taskStateTypeId;
        await expect(
          db.admin.execute(
            `update public.field_defs set write_mode = null
              where record_type_id = $1 and key = 'key'`,
            [typeId],
          ),
        ).rejects.toMatchObject({ code: '23502', column_name: 'write_mode' });
        expect(await fieldDefs(db)).toBe(snapshot);
      },
    );

    it.each(CASES)(
      'names $type field $key when its write mode is nulled with the not-null lifted',
      async ({ type, key }) => {
        const typeId = type === TASK_TYPE_KEY ? spine.taskTypeId : spine.taskStateTypeId;
        const findings = await whenTheModelIs(db, async (execute) => {
          // The schema is the first barrier and the case above is it. This is
          // the second, so the first comes down inside the transaction.
          await execute(`alter table public.field_defs alter column write_mode drop not null`);
          const changed = await execute(
            `update public.field_defs set write_mode = null
              where record_type_id = $1 and key = $2 returning key`,
            [typeId, key],
          );
          expect(changed.length).toBe(1);
        });
        expect(named(findings, type, key), JSON.stringify(findings)).toBe(true);
        expect(await fieldDefs(db)).toBe(snapshot);
      },
    );
  });

  describe('D02: each protected field relaxed to generic is named by the task set', () => {
    const PROTECTED_RULE = 'no field in the protected set is generic';

    it('is eleven, read from the spine', () => {
      expect(PROTECTED_TASK_FIELDS.length).toBe(11);
    });

    it.each([...PROTECTED_TASK_FIELDS])('catches %s relaxed to generic', async (key) => {
      const findings = await whenTheModelIs(db, async (execute) => {
        const changed = await execute(
          `update public.field_defs set write_mode = 'generic', owning_operation = null
            where record_type_id = $1 and key = $2 returning key`,
          [spine.taskTypeId, key],
        );
        expect(changed.length).toBe(1);
      });
      // The protected-set rule itself, naming this field and no other. The
      // declaration-mismatch rule fires too, and is not what this case is for.
      const caught = findings
        .filter((finding) => finding.rule === PROTECTED_RULE)
        .map((finding) => finding.object);
      expect(caught).toStrictEqual([`${business}:task.${key}`]);
      expect(await fieldDefs(db)).toBe(snapshot);
      expect(await taskSpineConformance(db.admin.execute)).toStrictEqual([]);
    });
  });
});

type Payload = Readonly<Record<string, unknown>>;

interface OwnerWorld {
  readonly other: Member;
  readonly freshTask: (title: string) => Promise<{ id: string; revision: number }>;
}

/** The success an owner must be seen to produce. */
interface OwnerCase {
  readonly command: CommandName;
  readonly payload: (world: OwnerWorld) => Payload | Promise<Payload>;
  /** What the stored field holds afterwards. Null means "read the category". */
  readonly stored: (payload: Payload) => unknown;
}

const fieldOf = (payload: Payload, key: string): unknown =>
  (payload['fields'] as Payload | undefined)?.[key];

const spineField = (key: string): SpineField | undefined =>
  TASK_SPINE.find((field) => field.key === key);

/**
 * One case per operation-owned task field.
 *
 * `delegate`, `intake_state`, `client`, `client_visible` and `parent` are the
 * five the frontier found with no stored-state success. `assignee`, `stage` and
 * `state` are here as well, because the map is closed: its keys are compared to
 * the set the spine derives, and a key missing from it would be a hole the
 * comparison exists to show.
 */
const OWNER_CASES: Readonly<Record<string, OwnerCase>> = {
  assignee: {
    command: 'task.assign',
    payload: (world) => ({ fields: { assignee: world.other.personId } }),
    stored: (payload) => fieldOf(payload, 'assignee'),
  },
  delegate: {
    command: 'task.assign',
    payload: (world) => ({ fields: { delegate: world.other.personId } }),
    stored: (payload) => fieldOf(payload, 'delegate'),
  },
  intake_state: {
    command: 'task.triage',
    payload: () => ({ fields: { intake_state: 'accepted' } }),
    stored: () => 'accepted',
  },
  client: {
    // A well-formed identifier and nothing more: the party model is not
    // installed, so no party is proved to exist (role-case-bodies.ts says so).
    command: 'task.set_party',
    payload: () => ({ fields: { client: randomUUID() } }),
    stored: (payload) => fieldOf(payload, 'client'),
  },
  client_visible: {
    command: 'task.set_audience',
    payload: () => ({ fields: { client_visible: true } }),
    stored: () => true,
  },
  parent: {
    command: 'task.reparent',
    payload: async (world) => ({ parentId: (await world.freshTask('the new parent')).id }),
    stored: (payload) => payload['parentId'],
  },
  stage: {
    command: 'task.set_stage',
    payload: () => ({ fields: { stage: 'drafting' } }),
    stored: () => 'drafting',
  },
  state: {
    command: 'task.start',
    payload: () => ({}),
    stored: () => null,
  },
};

describe.skipIf(serverUrl === undefined)('D04: every owner writes the field it owns', () => {
  let db: FreshDatabase;
  let business: string;
  let worker: Member;
  let world: OwnerWorld;

  const OWNED = TASK_SPINE.filter((field) => field.writeMode === 'operation');

  const run = async (command: Parameters<typeof executeCommand>[4]) =>
    await executeCommand(db.app, business, worker.presented, 'api', command);

  /** The stored row, read as the superuser so row security is not what answers. */
  const stored = async (recordId: string, key: string) => {
    const slot = spineField(key)?.slot ?? 'null';
    const rows = await db.admin.execute<Record<string, unknown>>(
      `select r.revision::text as revision, r.data ->> $2 as value, r.${slot} as slot,
              s.data ->> 'machine_category' as category
         from public.records r
         left join public.records s on s.business_id = r.business_id and s.id = r.uuid_1
        where r.id = $1`,
      [recordId, key],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`model negatives: no record ${recordId}`);
    return row;
  };

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'mg' });
    business = await insertBusiness(db.app, 'owners');
    await installSpine(db.app, business);
    worker = await enrol(db.app, business, 'owner');
    const other = await enrol(db.app, business, 'other');
    await db.app.withBusiness(business, async (tx) => {
      for (const action of ['write', 'assign', 'share'] as const) {
        // Sequential: `issueGrant` reads the granter's own rows.
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, worker, action);
      }
    });
    world = {
      other,
      freshTask: async (title) => {
        const made = await run({
          command: 'task.create',
          operationId: randomUUID(),
          fields: { title },
        });
        if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
        return { id: made.recordId ?? '', revision: made.revision ?? 0 };
      },
    };
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('has a case for exactly the operation-owned fields the spine declares', () => {
    expect(Object.keys(OWNER_CASES).toSorted()).toStrictEqual(
      OWNED.map((field) => field.key).toSorted(),
    );
    // The task-state type owns nothing, so it adds nothing to the map.
    expect(TASK_STATE_FIELDS.filter((field) => field.writeMode === 'operation')).toStrictEqual([]);
  });

  it.each(Object.keys(OWNER_CASES).toSorted())('uses a declared owner of %s', (key) => {
    expect(spineField(key)?.owningOperations).toContain(OWNER_CASES[key]?.command);
  });

  it.each(Object.keys(OWNER_CASES).toSorted())(
    'writes %s through its owner, and the database holds it',
    async (key) => {
      const test = OWNER_CASES[key];
      if (test === undefined) throw new Error(`model negatives: no case for ${key}`);
      const task = await world.freshTask(`owned ${key}`);
      const before = await stored(task.id, key);
      const payload = await test.payload(world);
      const answer = await run({
        command: test.command,
        operationId: randomUUID(),
        recordId: task.id,
        expectedRevision: task.revision,
        ...payload,
      } as Parameters<typeof executeCommand>[4]);
      expect(isCommandRefusal(answer) ? answer.code : 'applied').toBe('applied');
      if (isCommandRefusal(answer)) return;

      const after = await stored(task.id, key);
      expect(Number(after['revision'])).toBe(Number(before['revision']) + 1);
      expect(Number(after['revision'])).toBe(answer.revision);
      const expected = test.stored(payload);
      if (expected === null) {
        // `state` holds a state record's identifier, so the category is what
        // says the lifecycle moved.
        expect([before['category'], after['category']]).toStrictEqual(['unstarted', 'started']);
      } else {
        expect(after['value']).toBe(String(expected));
        expect(before['value']).not.toBe(String(expected));
        // The slot is the projection a view filters on. A write that reached
        // `data` and not the slot is half a write.
        expect(after['slot']).toStrictEqual(expected);
      }
    },
  );
});

describe.skipIf(serverUrl === undefined)(
  'D05: the command line is refused an unclassified plan',
  () => {
    let fixture: ApiFixture;
    let cli: ReturnType<typeof createCli>;

    const countFieldDefs = async (): Promise<number> => {
      const rows = await fixture.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.field_defs where business_id = $1`,
        [fixture.business],
      );
      return Number(rows[0]?.n ?? '-1');
    };

    beforeAll(async () => {
      fixture = await createApiFixture('mg');
      await fixture.db.app.withBusiness(fixture.business, async (tx) => {
        await grantTo(tx, fixture.member, 'manage');
      });
      const api = fixture.compose();
      // The shipped client, with the in-process app as its transport.
      cli = createCli({
        businessKey: BUSINESS_KEY,
        credential: await tokenFor(fixture.member.presented.subject),
        transport: async (path, body, credential) =>
          await api.fetch(
            new Request(`http://api.test${path}`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${credential}`,
              },
              body,
            }),
          ),
      });
    }, 120_000);

    afterAll(async () => {
      await fixture?.drop();
    });

    it('answers a classified plan, so the refusal below is not every answer', async () => {
      const before = await countFieldDefs();
      const answer = await cli.run('preset.plan', {
        recordTypeKey: 'task',
        presetKey: 'cli',
        fields: [{ key: 'cli_note', label: 'Note', valueType: 'text', writeMode: 'generic' }],
      });
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ ok: true, plan: { presetKey: 'cli' } });
      expect(await countFieldDefs()).toBe(before);
    });

    it('refuses an unclassified field by name, writing no field_defs row', async () => {
      const before = await countFieldDefs();
      const answer = await cli.run('preset.plan', {
        recordTypeKey: 'task',
        presetKey: 'cli',
        fields: [
          { key: 'valid_beside_it', label: 'Valid', valueType: 'text', writeMode: 'generic' },
          { key: 'unclassified_note', label: 'Note', valueType: 'text' },
        ],
      });
      expect(answer.status).toBe(422);
      expect(answer.body).toMatchObject({
        code: 'PRESET_FIELD_UNCLASSIFIED',
        names: ['unclassified_note'],
      });
      expect(await countFieldDefs()).toBe(before);
    });
  },
);
