// SPDX-License-Identifier: AGPL-3.0-only
//
// Frontier rows D02 to D04: a protected field is protected on every surface a
// caller has, and a refusal leaves the record exactly where it was.
//
// Minimum contract 5.1 says the classification lives on the field definition so
// that no surface can be more permissive than another. That sentence is only
// worth what a proof of it is worth, so this file asks the same question three
// times through three different front doors — the API's person prefix, the
// command line in `apps/cli/client.ts`, and the mounted app's own submission
// path in `apps/web/src/records/submit.ts` — and then asks the database.
//
// **The list is read, never copied.** Every case below is generated from
// `PROTECTED_TASK_FIELDS`, and the code each field earns is derived from that
// field's own `writeMode` on `TASK_SPINE` rather than written out. A twelfth
// protected field added to the spine grows its own nine cases here with no edit
// to this file, which is the only arrangement under which "the set is closed"
// is a fact rather than a habit.
//
// **Three codes, not one, and the difference is the point.** A field an
// operation owns is `TRANSITION_PROTECTED` and names the operation to call
// instead. A field the server derives is `FIELD_NOT_WRITABLE`, because no
// operation takes it as an input on any surface. `source` and `intake_state`
// are `SOURCE_SPOOFED`: claiming a provenance is a different mistake from
// writing a derived field, and `commands/tasks-write.ts` refuses them before
// the engine ever classifies them.
//
// **The database read is the assertion this file exists for.** A refusal that
// still wrote is worse than no refusal at all: the caller is told no and the
// record moves anyway, and every surface above it reports the lie faithfully.
// So each refusal is followed by a read of `public.records` on the
// administrative connection — the stored `data`, the projected slot column and
// the revision — compared against the snapshot taken before the attempt.
//
// **A refusal test with no success beside it proves only that the endpoint is
// broken.** `task.assign`, `task.start`, `task.complete`, `task.reopen` and
// `task.set_stage` each write the field a refusal above named, and the ordinary
// generic edit still moves `title`, `due` and `priority`. A server that refused
// everything would pass the first half of this file and fail the second.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PROTECTED_TASK_FIELDS,
  TASK_SPINE,
  slotOf,
  type SpineField,
} from '../../packages/core-records/src/tasks/spine.ts';
import { statusFor } from '../../apps/api/status.ts';
import { createCli } from '../../apps/cli/client.ts';
import { isRefusal, OperationsClient } from '../../apps/web/src/operations/client.ts';
import { submitEdit } from '../../apps/web/src/records/submit.ts';
import type { RefusalCode } from '../../packages/core-records/src/commands/register.ts';
import { bearer, call, createWorld, personPath, serverUrl } from './world.ts';
import type { Answer, World } from './world.ts';

if (serverUrl === undefined) {
  console.warn('acceptance/protected-fields: DATABASE_URL is unset, so nothing below ran.');
}

/**
 * The two fields a body can use to claim a provenance it does not have.
 *
 * `commands/tasks-write.ts:38` holds this list as `SPOOFABLE` and does not
 * export it, so it is restated here rather than read. That is the one hand-kept
 * fact in this file and it is named as such: if that module's list changes, the
 * cases for those keys fail on the code rather than passing quietly.
 */
const PROVENANCE_FIELDS: ReadonlySet<string> = new Set(['source', 'intake_state']);

const spineField = (key: string): SpineField => {
  const found = TASK_SPINE.find((field) => field.key === key);
  if (found === undefined) throw new Error(`protected-fields: ${key} is not on the task spine`);
  return found;
};

/** The refusal a field earns, derived from its own classification. */
function expectedCode(field: SpineField): RefusalCode {
  if (PROVENANCE_FIELDS.has(field.key)) return 'SOURCE_SPOOFED';
  return field.writeMode === 'system' ? 'FIELD_NOT_WRITABLE' : 'TRANSITION_PROTECTED';
}

/**
 * What the refusal names.
 *
 * `TRANSITION_PROTECTED` names `key=operations`, joined the way the field store
 * joins the `text[]` column, because a caller told only "this is protected" has
 * been told nothing they can act on. The other two name the key alone.
 */
function expectedNames(field: SpineField): readonly string[] {
  return expectedCode(field) === 'TRANSITION_PROTECTED'
    ? [`${field.key}=${field.owningOperations.join(' ')}`]
    : [field.key];
}

/** A value of the field's own type, distinctive enough to find in a response body. */
function probeValue(field: SpineField): unknown {
  if (field.valueType === 'uuid') return randomUUID();
  if (field.valueType === 'timestamptz') return new Date(0).toISOString();
  if (field.valueType === 'boolean') return true;
  if (field.valueType === 'numeric') return 99;
  return `probe-${field.key}`;
}

/** Every slot the spine reserves, so a read back sees the projection too. */
const SLOT_COLUMNS: readonly string[] = TASK_SPINE.map((field) => field.slot).filter(
  (slot): slot is string => slot !== null,
);

interface Stored {
  readonly revision: number;
  readonly data: Readonly<Record<string, unknown>>;
  readonly slots: Readonly<Record<string, unknown>>;
}

describe.skipIf(serverUrl === undefined)('a protected field is protected on every surface', () => {
  let world: World;
  let cli: ReturnType<typeof createCli>;
  let web: OperationsClient;

  /** The record every refusal case is aimed at. Nothing below may move it. */
  let subjectId: string;
  let baseline: Stored;

  /** The administrative read. Superuser, so row security is not what answers. */
  async function stored(recordId: string): Promise<Stored> {
    const rows = await world.db.admin.execute<Record<string, unknown>>(
      `select revision::text as revision, data, ${SLOT_COLUMNS.join(', ')}
         from public.records where id = $1`,
      [recordId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`protected-fields: no record ${recordId}`);
    return {
      revision: Number(row['revision']),
      data: row['data'] as Readonly<Record<string, unknown>>,
      slots: Object.fromEntries(SLOT_COLUMNS.map((column) => [column, row[column] ?? null])),
    };
  }

  /** A task, through the real endpoint, so even the fixture is product code. */
  async function createTask(title: string): Promise<{ id: string; revision: number }> {
    const made = await call(
      world.api,
      personPath('alpha', '/task/create'),
      { operationId: randomUUID(), fields: { title } },
      bearer(world.ada.token),
    );
    expect(made.code, `creating ${title}`).toBe('ok');
    return { id: String(made.body['recordId']), revision: Number(made.body['revision']) };
  }

  /** One command through the API's person prefix, which is surface A. */
  async function command(
    name: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<Answer> {
    return await call(
      world.api,
      personPath('alpha', `/${name.replace('.', '/')}`),
      { operationId: randomUUID(), ...payload },
      bearer(world.ada.token),
    );
  }

  beforeAll(async () => {
    world = await createWorld('prot');
    cli = createCli({
      businessKey: 'alpha',
      credential: world.ada.token,
      // The real client, driven against the real app. No network, and nothing
      // below the boundary substituted: the CLI composes the path and the app
      // routes it exactly as it would in a deployment.
      transport: async (path, body, credential) =>
        await world.api.fetch(
          new Request(`http://api.test${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
            body,
          }),
        ),
    });
    web = new OperationsClient({
      base: 'http://api.test/api',
      businessKey: 'alpha',
      token: world.ada.token,
      fetch: async (url, init) => await world.api.fetch(new Request(url as string, init)),
    });
    const made = await createTask('the record no refusal may move');
    subjectId = made.id;
    baseline = await stored(subjectId);
  }, 120_000);

  afterAll(async () => {
    await world?.close();
  });

  /**
   * The matrix: every protected field against every surface.
   *
   * Generated rather than listed, and one `it` per cell rather than a loop
   * inside one `it`, so a field that is not refused on one surface is named in
   * the failure output instead of stopping the sweep at the first bad cell.
   */
  const SURFACES: readonly string[] = ['api', 'cli', 'web'];
  const CASES = PROTECTED_TASK_FIELDS.flatMap((key) =>
    SURFACES.map((surface) => ({ key, surface })),
  );

  it.each(CASES)('refuses $key through the $surface surface, and writes nothing', async (test) => {
    const field = spineField(test.key);
    const value = probeValue(field);
    const fields = { [test.key]: value };
    const before = await stored(subjectId);

    let code: string;
    let names: readonly string[];
    let body: unknown;
    if (test.surface === 'api') {
      const answer = await command('task.update', {
        recordId: subjectId,
        expectedRevision: before.revision,
        fields,
      });
      // Only the API surface carries the status, and it must be the register's
      // own rather than a number this boundary chose: `statusFor` is the table
      // `apps/api/status.ts` keeps, and asking it here proves the boundary used
      // it instead of proving that a constant equals itself.
      expect(answer.status).toBe(statusFor(expectedCode(field)));
      code = answer.code;
      names = answer.body['names'] as readonly string[];
      body = answer.body;
    } else if (test.surface === 'cli') {
      const answer = await cli.run('task.update', {
        operationId: randomUUID(),
        recordId: subjectId,
        expectedRevision: before.revision,
        fields,
      });
      const refusal = answer.body as Record<string, unknown>;
      expect(answer.status).toBe(statusFor(expectedCode(field)));
      code = String(refusal['code']);
      names = refusal['names'] as readonly string[];
      body = refusal;
    } else {
      // The mounted app's own path, unfiltered on purpose: `submit.ts` sends
      // every field it is handed precisely so this refusal stays reachable from
      // the application a person uses.
      const result = await submitEdit(web, {
        command: 'task.update',
        recordId: subjectId,
        expectedRevision: before.revision,
        fields,
      });
      expect(isRefusal(result), `web surface answered ${JSON.stringify(result)}`).toBe(true);
      const refusal = result as { readonly code: string; readonly names: readonly string[] };
      code = refusal.code;
      names = refusal.names;
      body = refusal;
    }

    expect(code).toBe(expectedCode(field));
    expect(names).toStrictEqual(expectedNames(field));
    // The attempted value goes to the audit, never to the response. A refusal
    // that echoes the value back has handed the caller a receipt for a write
    // that did not happen. The general form of that is the shape: the wire
    // refusal is four keys and there is no fifth for a value to ride out in.
    expect(Object.keys(body as object).toSorted()).toStrictEqual([
      'code',
      'fixes',
      'names',
      'refused',
    ]);
    // And the specific form, for the values a refusal could plausibly repeat.
    // A boolean is excluded rather than asserted loosely: `client_visible`'s
    // only two values are `true` and `false`, and the envelope's own
    // `refused: true` makes "does the body contain it" unfalsifiable for that
    // field. A check that cannot fail is not evidence, so it is not claimed.
    if (typeof value === 'string') expect(JSON.stringify(body)).not.toContain(value);

    // And now the only question that matters. The stored `data`, the projected
    // slot and the revision are all read from the row itself, because a server
    // that refuses in the response and writes in the transaction is exactly the
    // failure this proof exists to catch.
    const after = await stored(subjectId);
    expect(after.data).toStrictEqual(baseline.data);
    expect(after.slots).toStrictEqual(baseline.slots);
    expect(after.revision).toBe(baseline.revision);
  });

  /**
   * The surrounding positive control for the refusals above.
   *
   * Every generic field on the spine, edited through the same command on the
   * same surface, must land. Without this the whole matrix above is satisfied
   * by a `task.update` that refuses its own arguments.
   */
  it('still performs the ordinary generic edit it was refusing a transition on', async () => {
    const made = await createTask('an ordinary edit');
    const due = new Date('2026-09-23T00:00:00.000Z').toISOString();
    const answer = await command('task.update', {
      recordId: made.id,
      expectedRevision: made.revision,
      fields: { title: 'renamed', due, priority: 3 },
    });
    expect(answer.code).toBe('ok');
    const after = await stored(made.id);
    expect(after.data['title']).toBe('renamed');
    expect(after.data['priority']).toBe(3);
    expect(after.slots[slotOf(TASK_SPINE, 'title')]).toBe('renamed');
    expect(after.revision).toBeGreaterThan(made.revision);
  });

  describe('the operation that owns the field writes it', () => {
    it('assigns through task.assign, and the database holds the person', async () => {
      const made = await createTask('assignable');
      const answer = await command('task.assign', {
        recordId: made.id,
        expectedRevision: made.revision,
        fields: { assignee: world.mia.personId },
      });
      expect(answer.code).toBe('ok');
      const after = await stored(made.id);
      expect(after.data['assignee']).toBe(world.mia.personId);
      expect(after.slots[slotOf(TASK_SPINE, 'assignee')]).toBe(world.mia.personId);
    });

    it('sets the stage through task.set_stage', async () => {
      const made = await createTask('stageable');
      const answer = await command('task.set_stage', {
        recordId: made.id,
        expectedRevision: made.revision,
        fields: { stage: 'build' },
      });
      expect(answer.code).toBe('ok');
      const after = await stored(made.id);
      expect(after.data['stage']).toBe('build');
      expect(after.slots[slotOf(TASK_SPINE, 'stage')]).toBe('build');
    });

    /**
     * `state` has three owners and the refusal names all three, so all three
     * are exercised. The state is never a value in a payload on any surface —
     * the command means a machine category and the server picks the row — which
     * is why `completed_at` cannot be set apart from the transition that earns
     * it, and why the last two assertions here are the whole of row D04.
     */
    it('moves the lifecycle through start, complete and reopen', async () => {
      const made = await createTask('lifecycle');
      const started = await command('task.start', {
        recordId: made.id,
        expectedRevision: made.revision,
      });
      expect(started.code).toBe('ok');
      const afterStart = await stored(made.id);
      expect(afterStart.data['state']).not.toBe(baseline.data['state']);
      expect(afterStart.slots[slotOf(TASK_SPINE, 'state')]).toBe(afterStart.data['state']);

      const completed = await command('task.complete', {
        recordId: made.id,
        expectedRevision: afterStart.revision,
      });
      expect(completed.code).toBe('ok');
      // Derived, by the command, in the same transaction as the state write.
      const afterComplete = await stored(made.id);
      expect(afterComplete.data['completed_at']).toStrictEqual(expect.any(String));
      expect(afterComplete.slots[slotOf(TASK_SPINE, 'completed_at')]).not.toBeNull();

      const reopened = await command('task.reopen', {
        recordId: made.id,
        expectedRevision: afterComplete.revision,
        reason: 'the client asked for another pass',
      });
      expect(reopened.code).toBe('ok');
      // And cleared, by the command that undoes the transition that set it.
      const afterReopen = await stored(made.id);
      expect(afterReopen.data['completed_at']).toBeUndefined();
      expect(afterReopen.slots[slotOf(TASK_SPINE, 'completed_at')]).toBeNull();
    });
  });

  /**
   * The system-derived half of the protected set, named from the data.
   *
   * These are the fields with no owning operation at all: no command takes one
   * as an input, so there is no positive control to put beside the refusal and
   * saying so is the honest report. `key` and `source` are the server's own and
   * are asserted to be present and server-shaped; `completed_at` is covered by
   * the lifecycle case above, which is the only way it moves.
   */
  it('keeps the derived fields the server’s own, with no operation that takes them', () => {
    const derived = PROTECTED_TASK_FIELDS.filter(
      (key) => spineField(key).owningOperations.length === 0,
    );
    expect(derived.toSorted()).toStrictEqual(['completed_at', 'key', 'source']);
    expect(baseline.data['source']).toBe('person:api');
    expect(baseline.data['key']).toMatch(/^T-\d+$/u);
    expect(baseline.data['completed_at']).toBeUndefined();
  });
});
