// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- the three generated lists and the probe they share read as one table */
//
// Ledger row D06, generated: every exported operation, by every system-owned
// field, by every surface a caller has.
//
// The row says every operation payload on the production app, command line and
// API attempts a system-field injection and observes a typed refusal and an
// unchanged database, and it names "ignore hostile field silently" as the
// failure. The named cases before this file covered the payloads lanes added
// and a few fields the screens send. This file builds the whole product of the
// three lists instead, and each of the three is read from where the product
// keeps it rather than written out here:
//
// - the operations are `COMMAND_SURFACE`, which is the table the routes, the
//   command line and the read dispatch are all generated from;
// - the top-level fields are `SYSTEM_OWNED_FIELDS`, the classifier
//   `commands/prepare.ts` and `reads/dispatch.ts` both apply, and every
//   installed `write_mode = 'system'` field key, which both read from
//   `field_defs` (root ruling 1);
// - the field-payload fields are the spine's `writeMode: 'system'` fields, and
//   the proofs check that the installed `field_defs` rows say the same thing,
//   so a field classified differently in the database fails there.
//
// **What a cell is.** A valid request succeeds first. Then a second request,
// prepared the same way and so otherwise just as valid, carries the injected
// field: it must be refused with the typed code naming the field, must not echo
// the value, must leave every other public table exactly as it was, and must
// add exactly one row to each log a refusal writes (`REFUSAL_LOGS`), the audit
// row holding the attempted value. Then that same second request without the
// field must succeed, which is what shows the refusal was about the field and
// nothing else. It goes under a new operation identity, because the refused
// one is registered and replays its refusal, as it should. An operation with no valid request for the caller says why, and its
// injection is still sent and still has to be refused.
//
// **Counted when executed.** The tally below is incremented by a cell that
// reached its last assertion, never by the generation, so the printed counts
// are the cells that ran rather than the cells that were registered.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { SYSTEM_OWNED_FIELDS } from '../../packages/core-records/src/commands/prepare.ts';
import {
  COMMAND_SURFACE,
  type CommandDeclaration,
  type CommandName,
} from '../../packages/core-records/src/commands/surface.ts';
import { TASK_SPINE } from '../../packages/core-records/src/tasks/spine.ts';
import { COMMENT_SPINE } from '../../packages/core-records/src/tasks/comments.ts';
import { TASK_STATE_FIELDS } from '../../packages/core-records/src/tasks/states.ts';
import { createCli } from '../../apps/cli/client.ts';
import { OperationsClient, type ReadName } from '../../apps/web/src/operations/client.ts';
import type { Harness } from './role-case-harness.ts';

export type Surface = 'api' | 'cli' | 'web';
export const SURFACES: readonly Surface[] = ['api', 'cli', 'web'];

/** The spine's derived fields: the ones a `fields` payload can name and nobody may write. */
export const SYSTEM_PAYLOAD_FIELDS: readonly string[] = TASK_SPINE.filter(
  (field) => field.writeMode === 'system',
)
  .map((field) => field.key)
  .toSorted();

/**
 * Every installed `write_mode = 'system'` field key, across the three record
 * types the spine installs: the task's, the comment's and the state's.
 *
 * The server refuses these at the top level from the installed `field_defs`
 * rows (root ruling 1); the list here is what the installer writes those rows
 * from, and `boundary-system-fields.test.ts` checks it against them.
 */
export const INSTALLED_SYSTEM_FIELDS: readonly string[] = [
  ...new Set(
    [...TASK_SPINE, ...COMMENT_SPINE, ...TASK_STATE_FIELDS]
      .filter((field) => field.writeMode === 'system')
      .map((field) => field.key),
  ),
].toSorted();

/** The keys a top-level cell injects: the envelope's own list and the installed ones. */
export const TOP_LEVEL_FIELDS: readonly string[] = [
  ...new Set([...SYSTEM_OWNED_FIELDS, ...INSTALLED_SYSTEM_FIELDS]),
].toSorted();

/**
 * The operations whose body carries a record's `fields`.
 *
 * Written out, and checked against the positive recipes by a case in the
 * generated file, so an operation that starts taking `fields` fails there
 * instead of quietly missing its field-payload cells. `preset.plan` also has a
 * `fields` key and it is not in this list: it is a plan's array of field
 * definitions, not a record's values.
 */
export const FIELDS_PAYLOAD_OPERATIONS: readonly CommandName[] = [
  'task.assign',
  'task.create',
  'task.set_audience',
  'task.set_party',
  'task.set_stage',
  'task.triage',
  'task.update',
];

/**
 * The operations a person may call and never succeeds at, with the reason.
 *
 * The injection is still sent for each of these. The system-field check runs
 * before anything that would refuse them for being a person, so the typed
 * refusal is still the answer; what is missing is only the positive control,
 * and that is said here rather than left as a gap in a count.
 */
export const PERSON_NOT_APPLICABLE: Readonly<Partial<Record<CommandName, string>>> = {
  'task.pickup': 'person path refuses by design (handlers.ts); an agent picks up (d06-agent)',
  'task.handback': 'person path refuses by design (handlers.ts); an agent hands back (d06-agent)',
  'task.heartbeat': 'person path refuses by design (handlers.ts); an agent renews (d06-agent)',
};

/** The body an inapplicable operation's injection rides in, well formed and otherwise inert. */
export function inertBody(name: CommandName): Record<string, unknown> {
  if (name === 'task.pickup') return { reservationId: randomUUID() };
  if (name === 'task.heartbeat') return { leaseId: randomUUID(), fence: 1 };
  return { leaseId: randomUUID(), fence: 1, outcome: 'completed' };
}

/** A value of the key's own kind, distinctive enough to look for in an answer. */
export function probeValue(key: string): unknown {
  if (key === 'revision') return 7;
  // Not `person:cli` and `cli`: a value that short is a substring of ordinary
  // refusal prose, and the no-echo check would be measuring the prose.
  if (key === 'source') return `person:probe-${randomUUID()}`;
  if (key === 'entryPoint' || key === 'entry_point') return `probe-${randomUUID()}`;
  if (/At$|_at$/u.test(key)) return '1970-01-01T00:00:00.000Z';
  return randomUUID();
}

export interface TopCell {
  readonly operation: CommandName;
  readonly key: string;
  readonly surface: Surface;
}

/** Every declared operation, by every classified key, by every surface. */
export const TOP_LEVEL_CELLS: readonly TopCell[] = COMMAND_SURFACE.flatMap((declaration) =>
  TOP_LEVEL_FIELDS.flatMap((key) =>
    SURFACES.map((surface) => ({ operation: declaration.name, key, surface })),
  ),
);

/** Every `fields` operation, by every derived field, by every surface. */
export const PAYLOAD_CELLS: readonly TopCell[] = FIELDS_PAYLOAD_OPERATIONS.flatMap((operation) =>
  SYSTEM_PAYLOAD_FIELDS.flatMap((key) => SURFACES.map((surface) => ({ operation, key, surface }))),
);

export const declarationFor = (name: CommandName): CommandDeclaration => {
  const found = COMMAND_SURFACE.find((one) => one.name === name);
  if (found === undefined) throw new Error(`d06: ${name} is not declared`);
  return found;
};

/** One answer, the same shape whichever surface gave it. */
export interface Said {
  readonly ok: boolean;
  readonly code: string;
  readonly names: readonly string[];
  readonly body: unknown;
}

/** A wire answer, refusal or success, read the same way whichever client carried it. */
function said(answer: unknown): Said {
  const named = (answer ?? {}) as Record<string, unknown>;
  const refused = named['refused'] === true;
  return {
    ok: !refused,
    code: refused ? String(named['code']) : 'ok',
    names: refused ? (named['names'] as readonly string[]) : [],
    body: answer,
  };
}

/**
 * The three front doors, built around the one real application.
 *
 * The API is the person prefix over `app.fetch`. The command line is
 * `apps/cli/client.ts` with its transport pointed at the same app. The web is
 * the mounted app's own `OperationsClient`, reads through `read` and commands
 * through `mutate`, which is the path every screen's submission takes.
 */
export function surfacesOf(
  harness: Harness,
): (surface: Surface, name: CommandName, body: Readonly<Record<string, unknown>>) => Promise<Said> {
  const { world } = harness;
  const cli = createCli({
    businessKey: 'alpha',
    credential: world.ada.token,
    transport: async (path, body, credential) =>
      await world.api.fetch(
        new Request(`http://api.test${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
          body,
        }),
      ),
  });
  const web = new OperationsClient({
    base: 'http://api.test/api',
    businessKey: 'alpha',
    token: world.ada.token,
    fetch: async (url, init) => await world.api.fetch(new Request(url as string, init)),
  });
  return async (surface, name, body) => {
    if (surface === 'api') {
      const answer = await harness.asPerson(name, body);
      return said(answer.body);
    }
    if (surface === 'cli') return said((await cli.run(name, body)).body);
    const result =
      declarationFor(name).kind === 'read'
        ? await web.read(name as ReadName, body)
        : await web.mutate(name, body, { operationId: String(body['operationId']) });
    if ('unavailable' in result) throw new Error(`d06: web unavailable ${result.because}`);
    return 'ok' in result && result.ok ? said(result.value) : said(result);
  };
}

/**
 * A spending cap wide enough for the run.
 *
 * `world.ts` writes the seed's cap, 500000 minor units, and every approval here
 * reserves `PROPOSAL.maximumMinor` against it. A few hundred cells approve a
 * proposal each, so the seed's cap runs out part-way and `task.decide` starts
 * refusing for a reason that has nothing to do with D06. Raised once, before
 * any cell, on the fixture's own row.
 */
export async function roomToApprove(harness: Harness): Promise<void> {
  await harness.world.db.admin.execute(
    `update public.budget_caps set limit_minor = 1000000000 where business_id = $1`,
    [harness.world.alpha],
  );
}

/** What a request may not move, and the three logs a refusal is meant to write one row each to. */
export interface Durable {
  readonly tables: Readonly<Record<string, string>>;
  readonly audit: number;
  readonly operations: number;
  readonly doorLog: number;
}

/**
 * The tables a refusal writes to on purpose, compared by count and not by version.
 *
 * `audit_events` holds the refusal (I13, T1-N4). `operations` holds the refused
 * attempt, because a refusal is a result that replays (`register-store.ts`,
 * T1-N2): a request carrying the same identity later gets the same answer.
 * `authentication_attempts` is the door log every authenticated request writes
 * one row to, refused or not (`identity/authentication-attempts.ts`).
 */
export const REFUSAL_LOGS: readonly string[] = [
  'audit_events',
  'authentication_attempts',
  'operations',
];

/**
 * Every public table's row count and newest row version, in one statement.
 *
 * `max(xmin)` moves on any insert or update, and the count moves on a delete,
 * so the pair changes when anything is written and costs a scan rather than a
 * hash of every row. `audit_events` is left out of the comparison and counted
 * on its own, because a refusal is supposed to write exactly one row there.
 */
export async function durableProbe(harness: Harness): Promise<() => Promise<Durable>> {
  const rows = await harness.world.db.admin.execute<{ readonly tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' order by 1`,
  );
  const tables = rows.map((row) => row.tablename).filter((name) => !REFUSAL_LOGS.includes(name));
  const sql = tables
    .map(
      (name) =>
        `select '${name}' as t, count(*)::text || ':' || coalesce(max(xmin::text::bigint), 0)::text as v from public.${name}`,
    )
    .join(' union all ');
  return async () => {
    const found = await harness.world.db.admin.execute<{ readonly t: string; readonly v: string }>(
      sql,
    );
    const logs = await harness.world.db.admin.execute<Record<string, string>>(
      `select (select count(*) from public.audit_events)::text as audit,
              (select count(*) from public.operations)::text as operations,
              (select count(*) from public.authentication_attempts)::text as door`,
    );
    return {
      tables: Object.fromEntries(found.map((row) => [row.t, row.v])),
      audit: Number(logs[0]?.['audit'] ?? '0'),
      operations: Number(logs[0]?.['operations'] ?? '0'),
      doorLog: Number(logs[0]?.['door'] ?? '0'),
    };
  };
}

/** The newest audit row, which a refusal must have just written. */
export async function lastAudit(harness: Harness): Promise<Record<string, unknown>> {
  const rows = await harness.world.db.admin.execute<Record<string, unknown>>(
    `select command, outcome, refusal_code, attempted from public.audit_events
      where business_id = $1 order by seq desc limit 1`,
    [harness.world.alpha],
  );
  return rows[0] ?? {};
}

/** The durable half of a refusal, asserted the same way by every cell. */
export function expectUnchanged(
  before: Durable,
  after: Durable,
  audit: Record<string, unknown>,
  expected: {
    readonly operation: string;
    readonly code: string;
    /**
     * Whether the refusal registers its attempt in `operations`. Undefined
     * allows either: the agent envelope decides that for itself, and D06 is
     * about the tables the operation would have written, not the register.
     */
    readonly attempt?: boolean;
    /** The door-log rows one request writes: one per login it presents. */
    readonly door?: number;
  },
): void {
  expect(after.tables).toStrictEqual(before.tables);
  expect(after.audit).toBe(before.audit + 1);
  // A command's refused attempt is registered; a read has no attempt identity to register.
  const registered = after.operations - before.operations;
  if (expected.attempt === undefined) expect([0, 1]).toContain(registered);
  else expect(registered).toBe(expected.attempt ? 1 : 0);
  expect(after.doorLog).toBe(before.doorLog + (expected.door ?? 1));
  expect(audit['command']).toBe(expected.operation);
  expect(audit['outcome']).toBe('refused');
  expect(audit['refusal_code']).toBe(expected.code);
}

/** Executed counts: operation, then surface, then what the cell observed. */
export class Tally {
  readonly #rows = new Map<string, { run: number; refused: number; na: string[] }>();

  count(operation: string, surface: string, refused: boolean, notApplicable?: string): void {
    const key = `${operation}\t${surface}`;
    const row = this.#rows.get(key) ?? { run: 0, refused: 0, na: [] };
    row.run += 1;
    if (refused) row.refused += 1;
    if (notApplicable !== undefined && !row.na.includes(notApplicable)) row.na.push(notApplicable);
    this.#rows.set(key, row);
  }

  print(title: string): void {
    const lines = [...this.#rows.entries()].map(
      ([key, row]) =>
        `${key}\trun=${String(row.run)}\trefused=${String(row.refused)}` +
        (row.na.length > 0 ? `\tpositive n/a: ${row.na.join('; ')}` : ''),
    );
    const bySurface = new Map<string, number>();
    for (const [key, row] of this.#rows) {
      const surface = key.split('\t')[1] ?? '';
      bySurface.set(surface, (bySurface.get(surface) ?? 0) + row.run);
    }
    const totals = [...bySurface].map(([surface, n]) => `${surface}=${String(n)}`).join(' ');
    console.log(`D06 ${title} executed: ${totals}\n${lines.join('\n')}`);
  }
}
