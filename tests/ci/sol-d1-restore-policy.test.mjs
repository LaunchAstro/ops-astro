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

test('Sol proof, criterion 2: a restore with an enabled but permissive tasks barrier is refused', async () => {
  assert.equal((await drill(await archive())).outcome, 'passed', 'the correctly scoped control passes');
  const body = await archive(`drop policy tenancy on public.tasks;
    create policy tenancy on public.tasks as restrictive for all using (true);`);
  let crossed = false;
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
  assert.ok(crossed, 'the restored app role reads the other business task');
  assert.equal(result.outcome, 'failed', 'a leaking policy must not earn a passed restore receipt');
});
