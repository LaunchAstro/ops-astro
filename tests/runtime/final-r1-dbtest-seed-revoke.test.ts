// SPDX-License-Identifier: AGPL-3.0-only
//
// FR1-DBTEST #60: a seed rerun never strands a live lease.
//
// The seed takes back a business grant its file no longer names. It does so
// with the raw `revokeGrant`, which only stamps revoked_at: it does not release
// a lease that the grant was the work authority for, nor classify its hold
// `authority_revoked` the way `grant.revoke` does (AUTHORITY.md, authority
// loss). So a rerun that took noah's task:write while he held a live lease
// left that lease live, with its hold, until it expired. The seed now refuses
// that revocation and says what to do instead; the grant and the lease are
// left as they were.
//
// The seed runs its whole body on import, so it runs here as its own process:
// a copy of scripts/local-seed.mjs under a temporary root, with packages/ and
// node_modules linked, so every `.local/` file it writes lands in that root.
// No SUPABASE_JWT_SECRET is passed, so it never calls an auth service, and
// GOTRUE_URL names a dead local port in case it tried.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { propose } from '../../packages/core-runtime/src/propose.ts';
import { decide } from '../../packages/core-runtime/src/decide.ts';
import { pickup } from '../../packages/core-runtime/src/pickup.ts';
import { TASK_COLLECTION } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'final-r1-dbtest-seed-revoke: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const repo = resolve(import.meta.dirname, '../..');

interface SeededUser {
  readonly email: string;
  readonly subject: string;
  grants?: unknown;
}

interface Identity {
  readonly personId: string;
  readonly actorId: string;
}

describe.skipIf(serverUrl === undefined)('the seed and a live lease', () => {
  let database: FreshDatabase;
  let root: string;
  let adminUrl: string;
  let businessId: string;
  let noahGrantId: string;
  let leaseId: string;

  const usersFile = (): string => join(root, '.local/synthetic-users.json');
  const users = (): SeededUser[] => JSON.parse(readFileSync(usersFile(), 'utf8')) as SeededUser[];

  function seed(): { readonly status: number | null; readonly output: string } {
    const run = spawnSync(process.execPath, [join(root, 'scripts/local-seed.mjs')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        PATH: process.env['PATH'] ?? '',
        DATABASE_URL: database.appUrl,
        DATABASE_ADMIN_URL: adminUrl,
        GOTRUE_URL: 'http://127.0.0.1:9',
      },
    });
    return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
  }

  async function identity(email: string): Promise<Identity> {
    const subject = users().find((user) => user.email === email)?.subject;
    const rows = await database.admin.execute<{ person_id: string; actor_id: string }>(
      `select pl.person_id, a.id as actor_id
         from public.logins l
         join public.person_logins pl on pl.login_id = l.id and pl.active
         join public.actors a on a.person_id = pl.person_id and a.kind = 'person'
        where l.provider = 'supabase' and l.subject = $1 and pl.business_id = $2`,
      [subject, businessId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`no seeded person for ${email}`);
    return { personId: row.person_id, actorId: row.actor_id };
  }

  async function noahWrite(): Promise<readonly { id: string; revoked: boolean }[]> {
    const noah = await identity('noah@alpha.local');
    return await database.admin.execute(
      `select id, revoked_at is not null as revoked from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'task' and action = 'write' and scope_kind = 'business'`,
      [businessId, noah.personId],
    );
  }

  beforeAll(async () => {
    database = await createFreshDatabase({ part: 'fr1seedrevoke' });
    const admin = new URL(serverUrl ?? '');
    admin.pathname = `/${database.name}`;
    adminUrl = admin.toString();

    root = mkdtempSync(join(tmpdir(), 'fr1-seed-'));
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, '.local'));
    copyFileSync(join(repo, 'scripts/local-seed.mjs'), join(root, 'scripts/local-seed.mjs'));
    symlinkSync(join(repo, 'packages'), join(root, 'packages'));
    symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'));

    // First run: the cast as the file gives it, noah with no grant.
    const first = seed();
    expect(first.status, first.output).toBe(0);
    // Second run: the earlier history, noah defaulted from his role.
    const earlier = users().map((user) => {
      if (user.email === 'noah@alpha.local') delete user.grants;
      return user;
    });
    writeFileSync(usersFile(), `${JSON.stringify(earlier, undefined, 2)}\n`);
    const second = seed();
    expect(second.status, second.output).toBe(0);

    const businesses = await database.admin.execute<{ id: string }>(
      `select id from public.businesses where key = 'alpha'`,
    );
    businessId = businesses[0]?.id ?? '';
    const held = await noahWrite();
    expect(held.map((grant) => grant.revoked)).toStrictEqual([false]);
    noahGrantId = held[0]?.id ?? '';

    // Ada creates, proposes and approves; noah picks the work up himself.
    const ada = await identity('ada@alpha.local');
    const noah = await identity('noah@alpha.local');
    const adaSubject = users().find((user) => user.email === 'ada@alpha.local')?.subject ?? '';
    const created = await executeCommand(
      database.app,
      businessId,
      { provider: 'supabase', subject: adaSubject },
      'api',
      {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: 'seed revoke' },
      } as never,
    );
    if (isCommandRefusal(created) || created.recordId === null) {
      throw new Error(`task.create refused: ${JSON.stringify(created)}`);
    }
    const taskId = created.recordId;
    const gate = readFileSync(join(root, '.local/gate.env'), 'utf8');
    const signingKey = {
      id: /^GATE_SIGNING_KEY_ID=(.+)$/mu.exec(gate)?.[1] ?? '',
      secret: /^GATE_SIGNING_SECRET=(.+)$/mu.exec(gate)?.[1] ?? '',
    };
    const caps = await database.admin.execute<{ id: string }>(
      'select id from public.budget_caps where business_id = $1',
      [businessId],
    );
    leaseId = await database.app.withBusiness(businessId, async (tx) => {
      const subjects = [{ kind: 'person' as const, id: ada.personId }];
      const proposed = await propose(tx, {
        taskId,
        collection: TASK_COLLECTION,
        proposedByActorId: ada.actorId,
        subjects,
        purpose: 'draft_the_brief',
        maximumMinor: 1_000,
        currency: 'AUD',
        payload: { instruction: 'draft it' },
        step: { kind: 'local.draft', payload: {} },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!proposed.ok) throw new Error(`propose refused ${proposed.refusal.code}`);
      const decided = await decide(tx, {
        gateId: proposed.value.gateId,
        versionId: proposed.value.versionId,
        decidedByPersonId: ada.personId,
        decidedByActorId: ada.actorId,
        subjects,
        collection: TASK_COLLECTION,
        decision: 'approve',
        note: 'go',
        signingKey,
        capId: caps[0]?.id ?? '',
      });
      if (!decided.ok || decided.value.decision !== 'approve') throw new Error('no approval');
      const picked = await pickup(tx, {
        claimant: 'person',
        personId: noah.personId,
        actorId: noah.actorId,
        authorisedByPersonId: noah.personId,
        reservationId: decided.value.reservationId,
        collection: TASK_COLLECTION,
        leaseSeconds: 600,
      });
      if (!picked.ok) throw new Error(`pickup refused ${picked.refusal.code}`);
      return picked.value.leaseId;
    });
  }, 300_000);

  afterAll(async () => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    await database?.drop();
  });

  it('refuses to revoke a grant a live lease depends on, and leaves both as they were', async () => {
    // Third run: the file as it stands, noah with no grant again.
    const current = users();
    for (const user of current) if (user.email === 'noah@alpha.local') user.grants = [];
    writeFileSync(usersFile(), `${JSON.stringify(current, undefined, 2)}\n`);
    const third = seed();

    expect(third.status, third.output).not.toBe(0);
    expect(third.output).toContain(
      `local-seed: noah@alpha.local's task:write grant ${noahGrantId} is the work authority for 1 live lease`,
    );
    expect(await noahWrite()).toEqual([{ id: noahGrantId, revoked: false }]);
    const leases = await database.admin.execute<{ state: string }>(
      'select state from public.leases where id = $1',
      [leaseId],
    );
    expect(leases).toEqual([{ state: 'live' }]);
  });
});
