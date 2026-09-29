// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-02: skill instruction files pinned by digest. The stores, their grants,
// the pin slot and the refusal of every activation that is not a person's.
// Every case that needs an activated run (the plan accept activating a file,
// a moved file refused at the read, the recovery cases) is AW-04's, run there
// against the real accept. Pins here are seeded by the test's admin
// connection on runs a real pickup made: a grant and isolation test, not an
// activation.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';
import {
  admitActivation,
  captureManifest,
  identityOf,
  readPinned,
  setDigest,
  type InstructionSource,
  type ReadAuditNote,
  type ReadRequest,
} from '../../packages/core-runtime/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import {
  createTask,
  liveWork,
  openSchedules,
  seedSchedules,
  type Schedules,
  type Work,
} from './schedules-harness.ts';

const noDatabase = process.env['DATABASE_URL'] === undefined;
/** Every database case needs the database; without one it is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const ENTRY = 'skills/brief/SKILL.md';
const FRAGMENT = 'skills/shared/preamble.md';
const FILES = new Map([
  [ENTRY, encode('# Brief\nWrite the brief.\n')],
  [FRAGMENT, encode('Plain words.\n')],
]);

/** An in-memory source that counts what it was asked for. */
function sourceOf(files: ReadonlyMap<string, Uint8Array>): InstructionSource & {
  readonly asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    read: async (path) => {
      asked.push(path);
      return await Promise.resolve(files.get(path));
    },
  };
}

describe('AW-02 file identity (no database)', () => {
  vitestIt('identity is digest and size; the path is provenance only', () => {
    const bytes = encode('same bytes');
    const here = identityOf('a/one.md', bytes);
    const there = identityOf('b/two.md', bytes);
    expect([here.digest, here.size]).toStrictEqual([there.digest, there.size]);
    const changed = identityOf('a/one.md', encode('same bytes!'));
    expect(changed.digest).not.toBe(here.digest);
  });

  vitestIt('the set digest is path-sorted, de-duplicated and blind to read order', () => {
    const a = identityOf('a.md', encode('a'));
    const b = identityOf('b.md', encode('b'));
    const once = setDigest([b, a]);
    expect(setDigest([a, b, a, b])).toStrictEqual(once);
    expect(once.count).toBe(2);
    expect(setDigest([a]).digest).not.toBe(once.digest);
  });

  vitestIt(
    'the manifest is captured sorted by path, and an unreadable or odd path refuses',
    async () => {
      const captured = await captureManifest(sourceOf(FILES), [FRAGMENT, ENTRY, ENTRY]);
      if (!captured.ok) throw new Error('manifest refused');
      expect(captured.value.entries.map((entry) => entry.path)).toStrictEqual([ENTRY, FRAGMENT]);
      for (const bad of ['skills/missing.md', '../etc/passwd', '/abs.md', 'a//b.md', 'a/./b.md']) {
        // eslint-disable-next-line no-await-in-loop
        const refused = await captureManifest(sourceOf(FILES), [bad]);
        expect(refused.ok ? 'ok' : refused.refusal.code, bad).toBe('DEFINITION_UNAVAILABLE');
      }
    },
  );
});

vitestIt(
  'AW-02 no scheduled activation: a schedule, event or timer naming a file is refused before any run exists',
  () => {
    const person = { kind: 'person', actorId: randomUUID() } as const;
    const system = { kind: 'system', actorId: null } as const;
    const agent = { kind: 'agent', actorId: randomUUID() } as const;
    const cases: readonly (readonly [
      string,
      typeof person | typeof system | typeof agent,
      string,
    ])[] = [
      ['schedule', system, 'ACTIVATION_MODE_NOT_PERMITTED'],
      ['event', system, 'ACTIVATION_MODE_NOT_PERMITTED'],
      ['timer', system, 'ACTIVATION_MODE_NOT_PERMITTED'],
      // A person naming an unattended mode is refused as firmly as the system.
      ['schedule', person, 'ACTIVATION_MODE_NOT_PERMITTED'],
      ['event', person, 'ACTIVATION_MODE_NOT_PERMITTED'],
      ['timer', person, 'ACTIVATION_MODE_NOT_PERMITTED'],
      // Manual is a person's act: the system cannot claim it.
      ['manual', system, 'ACTIVATION_MODE_NOT_PERMITTED'],
      // Hostile spellings of manual are not manual.
      ['Manual', person, 'ACTIVATION_MODE_NOT_PERMITTED'],
      [' manual', person, 'ACTIVATION_MODE_NOT_PERMITTED'],
      ['manual\t', person, 'ACTIVATION_MODE_NOT_PERMITTED'],
      ['MANUAL', person, 'ACTIVATION_MODE_NOT_PERMITTED'],
      ['', person, 'ACTIVATION_MODE_NOT_PERMITTED'],
      // An agent is refused whatever mode it names.
      ['manual', agent, 'DELEGATION_EXCLUDES_ACTIVATION'],
      ['schedule', agent, 'DELEGATION_EXCLUDES_ACTIVATION'],
    ];
    for (const [mode, activator, code] of cases) {
      const answer = admitActivation({ mode, activator });
      expect(
        answer.ok ? 'admitted' : answer.refusal.code,
        `${activator.kind} ${JSON.stringify(mode)}`,
      ).toBe(code);
    }
    // A person with no actor is nobody.
    const nobody = admitActivation({
      mode: 'manual',
      activator: { kind: 'person', actorId: null },
    });
    expect(nobody.ok ? 'admitted' : nobody.refusal.code).toBe('ACTIVATION_MODE_NOT_PERMITTED');
    // The one admitted shape, which is what `pinBootstrapFile` requires.
    const admitted = admitActivation({ mode: 'manual', activator: person });
    expect(admitted.ok && admitted.value.actorId).toBe(person.actorId);
  },
);

// ---------------------------------------------------------------------------
// The database cases.
// ---------------------------------------------------------------------------

let alpha: Schedules;
let bravo: Schedules;
let alphaWork: Work;
let bravoWork: Work;

interface LeaseRow {
  readonly run_id: string;
  readonly holder_actor_id: string;
}

async function leaseOf(owner: Schedules, work: Work): Promise<LeaseRow> {
  const rows = await owner.db.admin.execute<LeaseRow>(
    'select run_id, holder_actor_id from public.leases where id = $1',
    [work.picked['leaseId']],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no lease');
  return row;
}

/** A pin seeded by the admin connection on a real run: the grant test's seed, never an activation. */
async function seedPin(owner: Schedules, runId: string): Promise<void> {
  const captured = await captureManifest(sourceOf(FILES), [ENTRY, FRAGMENT]);
  if (!captured.ok) throw new Error('manifest refused');
  const entry = identityOf(ENTRY, FILES.get(ENTRY) ?? new Uint8Array());
  await owner.db.admin.execute(
    `insert into public.run_definition_pins
       (business_id, run_id, ref_kind, path, content_digest, content_size, read_at,
        manifest, manifest_digest, pinned_by_actor_id)
     values ($1, $2, 'bootstrap_file', $3, $4, $5, now(), $6::text::jsonb, $7, $8)`,
    [
      owner.business,
      runId,
      entry.path,
      entry.digest,
      entry.size,
      JSON.stringify(captured.value.entries),
      captured.value.digest,
      owner.decider.actorId,
    ],
  );
}

async function seedRead(owner: Schedules, runId: string): Promise<void> {
  const bytes = FILES.get(ENTRY) ?? new Uint8Array();
  const entry = identityOf(ENTRY, bytes);
  await owner.db.admin.execute(
    `insert into public.bootstrap_reads
       (business_id, id, run_id, sequence, path, content_digest, content_size, is_entry)
     values ($1, $2, $3, 1, $4, $5, $6, true)`,
    [owner.business, randomUUID(), runId, entry.path, entry.digest, entry.size],
  );
  await owner.db.admin.execute(
    `insert into public.bootstrap_bytes (business_id, content_digest, content_size, bytes)
     values ($1, $2, $3, $4)`,
    [owner.business, entry.digest, entry.size, Buffer.from(bytes)],
  );
}

beforeAll(async () => {
  if (noDatabase) return;
  alpha = await openSchedules('aw02', 1_000_000);
  bravo = await seedSchedules(alpha.db, 'aw02-bravo', 1_000_000);
  alphaWork = await liveWork(alpha, 'aw02 alpha run', 1_000);
  bravoWork = await liveWork(bravo, 'aw02 bravo run', 1_000);
  await seedPin(alpha, (await leaseOf(alpha, alphaWork)).run_id);
  await seedRead(alpha, (await leaseOf(alpha, alphaWork)).run_id);
  await seedPin(bravo, (await leaseOf(bravo, bravoWork)).run_id);
  await seedRead(bravo, (await leaseOf(bravo, bravoWork)).run_id);
}, 180_000);

afterAll(async () => {
  if (noDatabase) return;
  await alpha.db.drop();
});

const STORES = [
  'public.run_definition_pins',
  'public.bootstrap_reads',
  'public.bootstrap_bytes',
] as const;

/** The server's answer to one statement: `ok`, or the SQLSTATE it refused with. */
async function sqlstate(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return String((error as { code?: string }).code ?? error);
  }
}

async function fingerprint(owner: Schedules): Promise<string> {
  const parts: string[] = [];
  for (const table of STORES) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await owner.db.admin.execute<{ h: string }>(
      `select count(*)::text || ':' || md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h
         from ${table} t`,
    );
    parts.push(rows[0]?.h ?? '');
  }
  return parts.join(' ');
}

it('AW-02 pin slot: one reference slot per run, a bootstrap-file kind now and a definition version later', async () => {
  const { run_id: runId } = await leaseOf(alpha, alphaWork);
  const digest = 'a'.repeat(64);
  const pin = async (columns: Record<string, unknown>): Promise<string> =>
    await sqlstate(async () => {
      const row = {
        business_id: alpha.business,
        run_id: runId,
        ref_kind: 'bootstrap_file',
        path: 'x.md',
        content_digest: digest,
        content_size: 1,
        read_at: new Date(),
        definition_version_id: null,
        manifest: '[]',
        manifest_digest: digest,
        pinned_by_actor_id: alpha.decider.actorId,
        ...columns,
      };
      const names = Object.keys(row);
      await alpha.db.admin.transaction(async (execute) => {
        await execute(
          `insert into public.run_definition_pins (${names.join(', ')})
           values (${names.map((name, i) => `$${String(i + 1)}${name === 'manifest' ? '::text::jsonb' : ''}`).join(', ')})`,
          Object.values(row),
        );
        throw Object.assign(new Error('roll back'), { code: 'ok' });
      });
    });

  // The slot is the run's: a second pin on the same run is refused.
  expect(await pin({})).toBe('23505');
  // Each shape is checked by the server, not by the writer.
  const other = (await leaseOf(bravo, bravoWork)).run_id;
  const fresh = {
    business_id: bravo.business,
    run_id: other,
    pinned_by_actor_id: bravo.decider.actorId,
  };
  const hostile: readonly (readonly [string, Record<string, unknown>])[] = [
    ['kind unknown', { ref_kind: 'file' }],
    ['kind in capitals', { ref_kind: 'Bootstrap_file' }],
    ['bootstrap with no path', { path: null }],
    ['bootstrap with no read time', { read_at: null }],
    ['bootstrap naming a version', { definition_version_id: randomUUID() }],
    [
      'version with a path',
      { ref_kind: 'definition_version', definition_version_id: randomUUID() },
    ],
    ['version with no version', { ref_kind: 'definition_version', path: null, read_at: null }],
    ['digest in capitals', { content_digest: 'A'.repeat(64) }],
    ['digest short', { content_digest: 'a'.repeat(63) }],
    ['size negative', { content_size: -1 }],
    ['path up a level', { path: '../x.md' }],
    ['path absolute', { path: '/x.md' }],
    ['path doubled slash', { path: 'a//x.md' }],
    ['path dot segment', { path: 'a/./x.md' }],
    ['path with a tab', { path: 'a/\tx.md' }],
    ['manifest not a list', { manifest: '{}' }],
  ];
  // On a run with no pin, so every refusal below is the shape's own check.
  await alpha.db.admin.execute('delete from public.bootstrap_reads where business_id = $1', [
    bravo.business,
  ]);
  await alpha.db.admin.execute('delete from public.run_definition_pins where business_id = $1', [
    bravo.business,
  ]);
  for (const [label, columns] of hostile) {
    // eslint-disable-next-line no-await-in-loop
    expect(await pin({ ...fresh, ...columns }), label).toBe('23514');
  }
  // The two shapes the slot takes (each rolled back).
  expect(await pin({ ...fresh })).toBe('ok');
  expect(
    await pin({
      ...fresh,
      ref_kind: 'definition_version',
      path: null,
      read_at: null,
      definition_version_id: randomUUID(),
    }),
  ).toBe('ok');
  await seedPin(bravo, other);
  await seedRead(bravo, other).catch(() => undefined);

  // No ledger row without a pin: the ledger hangs off the pin.
  const unpinned = await liveWork(alpha, 'aw02 unpinned run', 1_000);
  const unpinnedLease = await leaseOf(alpha, unpinned);
  expect(
    await sqlstate(
      async () =>
        await alpha.db.admin.execute(
          `insert into public.bootstrap_reads
             (business_id, id, run_id, sequence, path, content_digest, content_size, is_entry)
           values ($1, $2, $3, 1, 'x.md', $4, 1, true)`,
          [alpha.business, randomUUID(), unpinnedLease.run_id, digest],
        ),
    ),
  ).toBe('23503');
  // An audit copy that is not the file it claims to be cannot be stored.
  for (const [label, claim] of [
    ['wrong digest', { digest, size: 3 }],
    ['wrong size', { digest: identityOf('x', encode('abc')).digest, size: 4 }],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await sqlstate(
      async () =>
        await alpha.db.admin.execute(
          `insert into public.bootstrap_bytes (business_id, content_digest, content_size, bytes)
           values ($1, $2, $3, $4)`,
          [alpha.business, claim.digest, claim.size, Buffer.from('abc')],
        ),
    );
    expect(answer, label).toBe('23514');
  }

  // Nothing is resolved by name or path when the pin is missing: the file is
  // there, the lease is live, and the read refuses without asking for it.
  const source = sourceOf(FILES);
  const notes: ReadAuditNote[] = [];
  const answer = await alpha.db.app.withBusiness(
    alpha.business,
    async (tx) =>
      await readPinned(
        tx,
        {
          leaseId: String(unpinned.picked['leaseId']),
          holderActorId: unpinnedLease.holder_actor_id,
          runId: unpinnedLease.run_id,
          stepId: null,
          path: ENTRY,
        },
        source,
        async (_tx: TenantQuery, note) => {
          notes.push(note);
          await Promise.resolve();
        },
      ),
  );
  expect(answer.ok ? 'read' : answer.refusal.code).toBe('DEFINITION_UNAVAILABLE');
  expect(source.asked).toStrictEqual([]);
  expect(notes).toStrictEqual([]);
}, 120_000);

it('AW-02 immutable: no run role rewrites a pin or a ledger row, or reads the audit copy', async () => {
  const before = await fingerprint(alpha);
  const own = alpha.business;
  const app = async (statement: string): Promise<string> =>
    await sqlstate(
      async () =>
        await alpha.db.app.withBusiness(own, async (tx) => await tx.query(statement, [own])),
    );
  const statements: readonly (readonly [string, string])[] = [
    [
      'update pin',
      `update public.run_definition_pins set content_size = content_size where business_id = $1`,
    ],
    ['delete pin', 'delete from public.run_definition_pins where business_id = $1'],
    [
      'update ledger',
      'update public.bootstrap_reads set sequence = sequence where business_id = $1',
    ],
    ['delete ledger', 'delete from public.bootstrap_reads where business_id = $1'],
    ['read copy', 'select bytes from public.bootstrap_bytes where business_id = $1'],
    ['update copy', 'update public.bootstrap_bytes set bytes = bytes where business_id = $1'],
    ['delete copy', 'delete from public.bootstrap_bytes where business_id = $1'],
    ['delete a historical run', 'delete from public.planned_runs where business_id = $1'],
  ];
  for (const [label, statement] of statements) {
    // eslint-disable-next-line no-await-in-loop
    expect(await app(statement), `application: ${label}`).toBe('42501');
  }
  // The other run roles and the restricted login hold nothing on the stores.
  for (const role of ['ops_astro_worker', 'ops_astro_broker', alpha.db.restrictedRole]) {
    for (const [label, statement] of [
      ...statements,
      ['read pin', 'select 1 from public.run_definition_pins where business_id = $1'],
      ['read ledger', 'select 1 from public.bootstrap_reads where business_id = $1'],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await sqlstate(
        async () =>
          await alpha.db.admin.transaction(async (execute) => {
            await execute(`set local role ${role}`);
            await execute(statement, [own]);
          }),
      );
      expect(answer, `${role}: ${label}`).toBe('42501');
    }
  }
  // The application may read what it may insert, and keeps the copy blind.
  const visible = await alpha.db.app.withBusiness(own, async (tx) => [
    (await tx.query('select 1 from public.run_definition_pins')).length,
    (await tx.query('select 1 from public.bootstrap_reads')).length,
  ]);
  expect(visible.every((count) => count >= 1)).toBe(true);
  // The evidence reads back unchanged.
  expect(await fingerprint(alpha)).toBe(before);
}, 120_000);

it('AW-02 isolation: another business, another client, another person under a live delegation', async () => {
  const alphaLease = await leaseOf(alpha, alphaWork);
  const bravoLease = await leaseOf(bravo, bravoWork);
  const notes: ReadAuditNote[] = [];
  const audit = async (_tx: TenantQuery, note: ReadAuditNote): Promise<void> => {
    notes.push(note);
    await Promise.resolve();
  };
  const read = async (owner: Schedules, request: ReadRequest): Promise<string> => {
    const answer = await owner.db.app.withBusiness(
      owner.business,
      async (tx) => await readPinned(tx, request, sourceOf(FILES), audit),
    );
    return answer.ok ? 'read' : JSON.stringify(answer.refusal);
  };
  const mine: ReadRequest = {
    leaseId: String(alphaWork.picked['leaseId']),
    holderActorId: alphaLease.holder_actor_id,
    runId: alphaLease.run_id,
    stepId: null,
    path: FRAGMENT,
  };
  const madeUp = await read(alpha, { ...mine, leaseId: randomUUID(), runId: randomUUID() });
  expect(JSON.parse(madeUp)).toMatchObject({ code: 'LEASE_NOT_OWNED' });
  const before = await fingerprint(alpha);

  // 1. Another business: bravo presents alpha's lease and run, both ways.
  expect(await read(bravo, mine)).toBe(madeUp);
  expect(
    await read(alpha, {
      ...mine,
      leaseId: String(bravoWork.picked['leaseId']),
      holderActorId: bravoLease.holder_actor_id,
      runId: bravoLease.run_id,
    }),
  ).toBe(madeUp);
  // Bravo sees, counts and changes none of alpha's rows.
  const seen = await bravo.db.app.withBusiness(bravo.business, async (tx) => [
    (
      await tx.query('select 1 from public.run_definition_pins where business_id = $1', [
        alpha.business,
      ])
    ).length,
    (
      await tx.query('select 1 from public.bootstrap_reads where business_id = $1', [
        alpha.business,
      ])
    ).length,
    (
      await tx.query('select 1 from public.run_definition_pins where run_id = $1', [
        alphaLease.run_id,
      ])
    ).length,
  ]);
  expect(seen).toStrictEqual([0, 0, 0]);
  const planted = await sqlstate(
    async () =>
      await bravo.db.app.withBusiness(
        bravo.business,
        async (tx) =>
          await tx.query(
            `insert into public.bootstrap_reads
             (business_id, id, run_id, sequence, path, content_digest, content_size, is_entry)
           values ($1, $2, $3, 9, 'x.md', $4, 1, false)`,
            [alpha.business, randomUUID(), alphaLease.run_id, 'a'.repeat(64)],
          ),
      ),
  );
  expect(planted).toBe('42501');

  // 2. Another client in the same business: client X, holding a grant on its
  // own task only, presents alpha's lease as its own holder.
  const taskX = await createTask(alpha, 'aw02 client X task');
  const clientX = await enrol(alpha.db.app, alpha.business, 'aw02-client-x');
  await alpha.db.app.withBusiness(alpha.business, async (tx) => {
    await grantTo(tx, clientX, 'read', { kind: 'record', id: taskX });
  });
  expect(await read(alpha, { ...mine, holderActorId: clientX.actorId })).toBe(madeUp);

  // 3. Another person's agent under its own live delegation: its own lease,
  // presented on alpha's run.
  const theirs = await liveWork(alpha, 'aw02 another agent run', 1_000);
  const theirLease = await leaseOf(alpha, theirs);
  expect(
    await read(alpha, {
      ...mine,
      leaseId: String(theirs.picked['leaseId']),
      holderActorId: theirLease.holder_actor_id,
    }),
  ).toBe(madeUp);
  expect(await fingerprint(alpha)).toBe(before);
  expect(notes).toStrictEqual([]);

  // The owner's own read goes through, writes its ledger row and one audit event.
  expect(await read(alpha, mine)).toBe('read');
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ runId: alphaLease.run_id, path: FRAGMENT, sequence: 2 });
}, 180_000);
