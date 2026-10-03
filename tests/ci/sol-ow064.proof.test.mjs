// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sealArchive } from '../../scripts/ops/archive-seal.mjs';
import { docker, must } from '../../scripts/ops/drill-docker.mjs';
import { restoreDrill } from '../../scripts/ops/drill-restore.mjs';

const compose = JSON.parse(readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url)));
const image = compose.services.backups.image;
const scope = { business: randomUUID(), person: randomUUID(), client: randomUUID() };
const otherBusiness = randomUUID();
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function barrier(table) {
  return `alter table public.${table} enable row level security;
    alter table public.${table} force row level security;
    create policy tenancy on public.${table} as restrictive for all
      using (business_id = public.app_business_id());
    create policy authority on public.${table} as permissive for all using (true);`;
}

async function archive(extra = '') {
  const source = `sol-ow064-source-${randomUUID().slice(0, 8)}`;
  await must(docker(['run', '-d', '--rm', '--network', 'none', '--name', source,
    '--tmpfs', '/var/lib/postgresql/data', '--log-driver=none',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image]));
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120 && !ready; attempt++) {
      ready = (await docker(['exec', source, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'])).code === 0;
      if (!ready) await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(ready, 'source Postgres became ready');
    const sql = `create function public.app_business_id() returns uuid language sql stable
      as $$ select nullif(current_setting('app.business_id', true), '')::uuid $$;
      create table public.businesses (business_id uuid, id uuid);
      insert into public.businesses values ('${scope.business}', '${scope.business}'),
        ('${otherBusiness}', '${otherBusiness}');
      create table public.people (business_id uuid, id uuid);
      insert into public.people values ('${scope.business}', '${scope.person}'),
        ('${scope.business}', '${scope.client}');
      create table public.memberships (business_id uuid, person_id uuid, active boolean);
      insert into public.memberships values ('${scope.business}', '${scope.person}', true);
      create table public.grants (business_id uuid, id uuid, subject_kind text, subject_id uuid,
        collection text, action text, scope_kind text, scope_id uuid, parent_grant_id uuid,
        revoked_at timestamptz, expires_at timestamptz, can_delegate boolean,
        may_permit_delegation boolean);
      insert into public.grants values ('${scope.business}', gen_random_uuid(), 'person',
        '${scope.person}', 'person', 'read', 'party', '${scope.client}', null, null, null, false, false);
      create table public.tasks (business_id uuid, title text);
      insert into public.tasks values ('${scope.business}', 'my made-up task'),
        ('${otherBusiness}', 'other business private task');
      ${['businesses', 'people', 'memberships', 'grants', 'tasks'].map(barrier).join('\n')}
      ${extra}`;
    await must(docker(['exec', '-i', source, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], sql));
    // Docker's text-returning helper cannot carry the binary dump.
    const { spawnSync } = await import('node:child_process');
    const binary = spawnSync('docker', ['exec', source, 'pg_dump', '-U', 'postgres', '--format=custom', '--schema=public'],
      { maxBuffer: 16 * 1024 * 1024 });
    assert.equal(binary.status, 0);
    return sealArchive(binary.stdout, keys.publicKey);
  } finally {
    await must(docker(['rm', '-f', '-v', source]));
  }
}

async function drill(body, run = docker) {
  return restoreDrill({
    fetchArchive: async () => ({ takenAt: '2026-10-03T00:00:00.000Z', body }),
    privateKey: keys.privateKey,
    scope,
    docker: run,
  });
}

test('Sol proof, criterion 2: business-to-business separation rejects a restore with only the tasks barrier missing', async () => {
  assert.equal((await drill(await archive())).outcome, 'passed', 'the fully barred control passes');
  const body = await archive('alter table public.tasks disable row level security');
  let crossed = false;
  // Inspect before removing the real target.
  const inspectBeforeRemove = async (args, input) => {
    if (args[0] === 'rm') {
      const visible = await must(docker(['exec', args.at(-1), 'psql', '-U', 'postgres', '-Atq', '-d', 'drill',
        '-c', `set role ops_astro_app; set app.business_id = '${scope.business}';
          select count(*) from public.tasks where business_id = '${otherBusiness}'`]));
      crossed = visible.trim() === '1';
    }
    return docker(args, input);
  };
  const result = await drill(body, inspectBeforeRemove);
  assert.ok(crossed, 'the target app role actually reads the other business task');
  assert.equal(result.outcome, 'failed', 'a target with a broken business barrier must not earn a passed receipt');
});

test('Sol proof, criterion 3: a restore error cannot put a private value into Docker daemon logs', async () => {
  const canary = 'SOL_OW064_PRIVATE_CREDENTIAL_CANARY';
  const body = await archive(`
    create function public.check_payload(v text) returns boolean language sql immutable as 'select true';
    create table public.private_payloads (business_id uuid, payload text check (public.check_payload(payload)));
    insert into public.private_payloads (business_id, payload) values ('${scope.business}', '${canary}');
    create or replace function public.check_payload(v text) returns boolean language sql immutable as 'select false';
    ${barrier('private_payloads')}`);
  let leaked = false;
  const run = async (args, input) => {
    if (args[0] === 'rm') {
      const driver = await must(docker(['inspect', '-f', '{{.HostConfig.LogConfig.Type}}', args.at(-1)]));
      if (driver.trim() === 'none') return docker(args, input);
      // docker() discards stderr, where PostgreSQL writes, so collect both streams here.
      const { spawnSync } = await import('node:child_process');
      const logged = spawnSync('docker', ['logs', args.at(-1)], { encoding: 'utf8' });
      assert.equal(logged.status, 0);
      leaked = `${logged.stdout}${logged.stderr}`.includes(canary);
    }
    return docker(args, input);
  };
  const result = await drill(body, run);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.stage, 'restore');
  assert.ok(!JSON.stringify(result).includes(canary), 'the returned receipt is sanitised');
  assert.equal(leaked, false, 'the private restore error was persisted by the Docker log driver');
});
