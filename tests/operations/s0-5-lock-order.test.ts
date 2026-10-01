// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: a command that writes before taking the task's row lock fails the
// build (the ticket's content marker and lock order, its write-before-lock leg).
//
// Scope: the commands whose task row lock the command envelope takes
// (`targetsExistingRecord` with `targetLock: 'command'`, read from the
// catalogue; `lockTask` in `prepare.ts`). Each one's positive fixture runs
// through the real API on a captured connection (`statement-capture-cases.ts`),
// and every statement its transaction sends before the `for update` on the
// task must be one of the envelope's own steps named below. A write, or any
// read not named, before the lock is a fault.
//
// Held (`s0-5-client-lock-held.test.ts`): the envelope still resolves the
// sign-in, reads the task spine and asks authority before the lock, where the
// ticket wants the client derived and authority asked under it; and the
// runtime's own lock order. Both are the runtime half.
//
// The detector's teeth: a copy of the envelope with one write planted before
// the lock (`tests/support/source-mutant.ts`) is caught on every command; and
// the same shape raced against `task.set_party` in a separate session shows
// why: a content write made before the lock is not seen by the client change,
// which lands, while the same write made under the lock is seen and refused.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { RecordedStatement } from '../../packages/core-records/src/tenancy/statements.ts';
import { COMMAND_SURFACE, type CommandDeclaration } from '../../packages/core-wire/src/surface.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { serverUrl } from '../acceptance/world.ts';
import { createSourceMutant } from '../support/source-mutant.ts';
import { observe, type Observed } from '../tenancy/statement-capture-cases.ts';
import { newClient, setPartyBody, useHarness } from './s0-5-client-lock-world.ts';

if (serverUrl === undefined) {
  console.warn('operations/s0-5-lock-order: DATABASE_URL is unset, so nothing below ran.');
}

/** The commands whose task row lock the envelope takes, from the catalogue. */
const LOCKED: readonly CommandDeclaration[] = COMMAND_SURFACE.filter(
  (one) => one.targetsExistingRecord && one.targetLock === 'command',
);

/** `lockTask`'s own statement, the task row taken `for update`. */
const TASK_LOCK =
  /^select id, revision::text as revision, data, deleted_at, trash_batch_id from records where business_id = \$1 and record_type_id = \$2 and id = \$3 for update$/u;

/** The envelope's steps before the lock, each with why it may come first. */
const BEFORE_LOCK: readonly (readonly [RegExp, string])[] = [
  [/^(begin|savepoint command_(attempt|work))$/u, "the transaction and the envelope's savepoints"],
  [/^select set_config\('app\.business_id', \$1, true\)$/u, 'the business, set locally'],
  [/^select l\.id as login_id, pl\.person_id, /u, 'the sign-in resolved (held: runtime half)'],
  [/^insert into public\.authentication_attempts /u, 'sign-in bookkeeping, never task content'],
  [/^select command, payload_digest, outcome, result from operations /u, 'the idempotency read'],
  [/^select distinct key from public\.field_defs /u, 'system-owned fields refused'],
  [/^select key, id from record_types /u, 'the task spine (held: runtime half)'],
  [/^select id, data ->> 'key' as key, data ->> 'machine_category' /u, 'the spine (held)'],
  [/^with recursive effective as \( select g\.\*/u, 'authority asked (held: runtime half)'],
  [/^select pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)$/u, "a declared subtree's lock"],
];

const flat = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim().toLowerCase();

/** What one command's transaction sent before its task lock that the envelope does not name. */
function lockOrderFaults(name: string, sent: readonly RecordedStatement[]): string[] {
  const texts = sent.map((one) => flat(one.text));
  const at = texts.findIndex((text) => TASK_LOCK.test(text));
  if (at < 0) return [`${name}: no task row lock`];
  return texts
    .slice(0, at)
    .filter((text) => !BEFORE_LOCK.some(([step]) => step.test(text)))
    .map((text) => `${name}: before the lock: ${text.slice(0, 80)}`);
}

let harness: Harness;

/** Every envelope-locked command's positive fixture, captured through `execute`; the faults. */
async function faultsThrough(execute?: typeof executeCommand): Promise<string[]> {
  const observed: Observed = observe(harness.world, execute);
  try {
    await observed.send({ name: 'session.capabilities', prefix: 'person', body: {} });
    const found: string[] = [];
    for (const declaration of LOCKED) {
      // eslint-disable-next-line no-await-in-loop -- fixtures share one world
      const prepared = await harness.positiveBody(declaration);
      if (!('body' in prepared)) throw new Error(`${declaration.name}: ${prepared.exception}`);
      // eslint-disable-next-line no-await-in-loop
      const { answer, sent } = await observed.send({
        name: declaration.name,
        prefix: 'person',
        body: prepared.body,
      });
      if (answer.code !== 'ok') found.push(`${declaration.name}: answered ${answer.code}`);
      found.push(...lockOrderFaults(declaration.name, sent));
    }
    return found;
  } finally {
    await observed.close();
  }
}

const ENVELOPE = 'packages/core-commands/src/commands/envelope.ts';

/** The envelope with one write planted in front of `lockTask`, and nothing else changed. */
async function plantedFaults(): Promise<string[]> {
  const mutant = createSourceMutant({
    file: 'packages/core-commands/src/commands/prepare.ts',
    from: "    target = await lockTask(tx, spine.taskTypeId, recordId ?? '', {",
    to: [
      "    await tx.query('update records set data = data where business_id = $1 and id = $2', [",
      '      tx.businessId,',
      '      recordId,',
      '    ]);',
      "    target = await lockTask(tx, spine.taskTypeId, recordId ?? '', {",
    ].join('\n'),
  });
  try {
    const copy = await mutant.load<{ executeCommand: typeof executeCommand }>(ENVELOPE);
    return await faultsThrough(copy.executeCommand);
  } finally {
    mutant.dispose();
  }
}

const CONTAINER = process.env['FIXTURE_PG_CONTAINER'] ?? '';

/**
 * A content write (an applied history event on the task) in a separate
 * session, before the task's row lock or under it, held open until the client
 * change is queued behind it; the change is sent meanwhile. Its answer, and
 * whether the task then holds that content under the client the change set.
 */
async function raced(order: 'before the lock' | 'under the lock'): Promise<[string, boolean]> {
  const task = await harness.freshTask(`s0-5 lock order, ${order}`);
  const to = await newClient();
  const body = await setPartyBody(task.id, to);
  const [{ db }] = (await harness.world.db.admin.execute<{ db: string }>(
    'select current_database() as db',
  )) as [{ db: string }];
  const writer = spawn(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-q'],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let said = '';
  writer.stderr.on('data', (chunk: Buffer) => {
    said += chunk.toString();
  });
  const done = new Promise<number>((resolve) => {
    writer.on('close', (code) => resolve(code ?? 1));
  });
  writer.stdin.end(`set statement_timeout = '10s';
begin;
${order === 'under the lock' ? `select id from records where id = '${task.id}' for update;` : ''}
insert into audit_events (business_id, id, actor_id, command, outcome, subject_record_id,
                          payload_digest, hash)
  select business_id, '${randomUUID()}', actor_id, 'task.comment', 'applied', '${task.id}',
         repeat('0', 64), repeat('0', 64)
    from audit_events where subject_record_id = '${task.id}' limit 1;
do $$ begin
  loop
    exit when exists (select 1 from pg_locks where not granted);
    perform pg_sleep(0.02);
  end loop;
end $$;
commit;
`);
  await new Promise((resolve) => {
    setTimeout(resolve, 400);
  });
  const answer = await harness.asPerson('task.set_party', body);
  expect(await done, said).toBe(0);
  // Moved, with the planted content on it: a client change the lock should have refused.
  const [row] = await harness.world.db.admin.execute<{ moved: boolean }>(
    `select uuid_7::text = $2 and exists (select 1 from audit_events a where
       a.subject_record_id = $1 and a.payload_digest = repeat('0', 64)) as moved
       from records where id = $1`,
    [task.id, to],
  );
  return [answer.code, row?.moved === true];
}

describe.skipIf(serverUrl === undefined)('S0-5 lock order, the envelope-locked commands', () => {
  beforeAll(async () => {
    harness = await createHarness('s05_lockorder');
    useHarness(harness);
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('S0-5 content marker and lock order: no envelope-locked command reads or writes anything before its task row lock but the envelope steps named here', async () => {
    expect(LOCKED.length).toBeGreaterThan(0);
    expect(await faultsThrough()).toStrictEqual([]);
  }, 300_000);

  it('S0-5 content marker and lock order: a write planted before the lock fails the detector, on every envelope-locked command', async () => {
    // The planted write bumps the revision too, so each fixture is also refused
    // VERSION_STALE; the detector's own line is what is asserted.
    const found = (await plantedFaults()).filter((line) => line.includes('before the lock'));
    expect(found).toStrictEqual(
      LOCKED.map(
        ({ name }) =>
          `${name}: before the lock: update records set data = data where business_id = $1 and id = $2`,
      ),
    );
  }, 300_000);

  it('S0-5 content marker and lock order: a content write before the lock is not seen by task.set_party, which moves the client; under the lock it is seen and refused', async () => {
    expect(await raced('before the lock')).toStrictEqual(['ok', true]);
    expect(await raced('under the lock')).toStrictEqual(['CLIENT_LOCKED', false]);
  }, 120_000);
});
