// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { markMadeUp } from '../../scripts/ops/made-up-only.ts';

const server = databaseUrlFromEnvironment();
assert.ok(server, 'Run against the reviewer-owned disposable Postgres');
const seed = new URL('../../scripts/local-seed.mjs', import.meta.url).pathname;
const ownerUrl = (db) => {
  const url = new URL(server);
  url.pathname = `/${db.name}`;
  return url.toString();
};

async function runSeed(env, preload) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), seed], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (bytes) => { out += bytes.toString(); });
    child.stderr.on('data', (bytes) => { out += bytes.toString(); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, out }));
  });
}

test('the seed refuses to send a hosted service key to remote plaintext HTTP', async () => {
  const db = await createFreshDatabase({ part: 'ow077_http' });
  const folder = mkdtempSync(join(tmpdir(), 'sol-ow077-http-'));
  const marker = join(folder, 'unsafe-send.json');
  const preload = join(folder, 'observe-fetch.mjs');
  const canary = `test-only-ow077-${randomUUID()}`;
  writeFileSync(preload, `import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  const headers = new Headers(init?.headers);
  if (url.hostname === 'auth.example.test' && url.protocol === 'http:') {
    writeFileSync(process.env.OW077_MARKER, JSON.stringify({
      serviceKeySent: headers.get('apikey') === process.env.SUPABASE_SERVICE_KEY,
      bearerSent: headers.get('authorization') === 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
    }));
    throw new Error('Sol stopped the outbound request at the fetch boundary');
  }
  if (url.hostname === 'auth.example.test' && url.protocol === 'https:') {
    return Response.json({ id: randomUUID() });
  }
  throw new Error('Unexpected outbound request');
};
`);
  try {
    const env = {
      DATABASE_ADMIN_URL: ownerUrl(db), DATABASE_URL: db.appUrl,
      LOCAL_SEED_MADE_UP: 'confirm', OPS_SEED_DIR: folder,
      GOTRUE_URL: 'https://auth.example.test', SUPABASE_SERVICE_KEY: canary,
      OW077_MARKER: marker,
    };
    const control = await runSeed(env, preload);
    assert.ok(!control.out.includes(canary), 'The proof must not print its canary');
    assert.equal(control.status, 0, 'The same seed with an HTTPS provider must work');
    const result = await runSeed({ ...env, GOTRUE_URL: 'http://auth.example.test' }, preload);
    assert.ok(!result.out.includes(canary), 'The proof must not print its canary');
    const sent = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : {};
    assert.notEqual(sent.serviceKeySent, true,
      'The real seed handed its hosted service key to fetch for a remote plaintext HTTP request');
    assert.notEqual(sent.bearerSent, true);
    assert.notEqual(result.status, 0, 'An unsafe provider URL must be refused');
  } finally {
    rmSync(folder, { recursive: true, force: true });
    await db.drop();
  }
});

test('a made-up admin database cannot admit writes into a different unmarked application database', async () => {
  const checked = await createFreshDatabase({ part: 'ow077_checked' });
  const target = await createFreshDatabase({ part: 'ow077_target' });
  const folder = mkdtempSync(join(tmpdir(), 'sol-ow077-target-'));
  const preload = join(folder, 'synthetic-auth.mjs');
  writeFileSync(preload, `import { randomUUID } from 'node:crypto';
globalThis.fetch = async (input) => {
  if (new URL(input).origin !== 'https://auth.example.test') throw new Error('Unexpected outbound request');
  return Response.json({ id: randomUUID() });
};\n`);
  const alpha = randomUUID();
  const bravo = randomUUID();
  try {
    // Restored installations retain business UUIDs. Only the admin target is
    // marked made-up; the application URL accidentally points at its other copy.
    for (const db of [checked, target]) {
      for (const [id, key] of [[alpha, 'alpha'], [bravo, 'bravo']]) {
        await db.admin.execute(
          'insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $2)',
          [id, key],
        );
      }
    }
    await target.admin.execute(
      'insert into public.people (business_id, id, display_name) values ($1, $2, $3)',
      [alpha, randomUUID(), 'Existing private person canary'],
    );
    await markMadeUp(checked.admin, [alpha, bravo]);
    const env = {
      DATABASE_ADMIN_URL: ownerUrl(checked), DATABASE_URL: checked.appUrl,
      OPS_SEED_DIR: folder, LOCAL_SEED_MADE_UP: '',
      GOTRUE_URL: 'https://auth.example.test',
      SUPABASE_SERVICE_KEY: `test-only-ow077-${randomUUID()}`,
    };
    const control = await runSeed(env, preload);
    assert.equal(control.status, 0, 'Matching guarded targets must seed successfully');
    const result = await runSeed({ ...env, DATABASE_URL: target.appUrl }, preload);
    const [row] = await target.admin.execute(
      'select count(*)::int as n from public.people where display_name <> $1',
      ['Existing private person canary'],
    );
    assert.equal(row.n, 0,
      'The seed wrote synthetic identities into the unmarked application database after guarding only the admin database');
    assert.notEqual(result.status, 0, 'Different target databases must be refused');
  } finally {
    rmSync(folder, { recursive: true, force: true });
    await target.drop();
    await checked.drop();
  }
});
