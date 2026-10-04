// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
};
const close = (server) => new Promise((resolve) => server.close(resolve));

test('Sol proof, criterion 3: a seed HTTPS redirect cannot send the service key to remote plaintext HTTP', async () => {
  const db = await createFreshDatabase({ part: 'sol_d1_redirect' });
  const folder = mkdtempSync(join(tmpdir(), 'sol-d1-redirect-'));
  const keyFile = join(folder, 'key.pem'), certFile = join(folder, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile,
    '-out', certFile, '-days', '1', '-subj', '/CN=auth.example.test', '-addext', 'subjectAltName=DNS:auth.example.test'], { stdio: 'ignore' });
  const canary = `sol-only-service-key-${randomUUID()}`;
  let plaintext = false, reachedTLS = false;
  const target = httpServer((req, res) => {
    if (req.headers.apikey === canary || req.headers.authorization === `Bearer ${canary}`) plaintext = true;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: randomUUID() }));
  });
  const port = await listen(target);
  const provider = httpsServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
    reachedTLS = req.headers.apikey === canary;
    req.resume();
    res.writeHead(307, { location: `http://auth.example.test:${port}/admin/users` });
    res.end();
  });
  const tlsPort = await listen(provider);
  const preload = join(folder, 'dns.mjs');
  writeFileSync(preload, `import dns from 'node:dns';\nconst lookup = dns.lookup;\ndns.lookup = (host, options, callback) => lookup(host === 'auth.example.test' ? '127.0.0.1' : host, options, callback);\n`);
  const owner = new URL(databaseUrlFromEnvironment()); owner.pathname = `/${db.name}`;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', preload, 'scripts/local-seed.mjs'], {
        env: { PATH: process.env.PATH, DATABASE_ADMIN_URL: owner.href, DATABASE_URL: db.appUrl,
          LOCAL_SEED_MADE_UP: 'confirm', OPS_SEED_DIR: folder,
          GOTRUE_URL: `https://auth.example.test:${tlsPort}`, SUPABASE_SERVICE_KEY: canary,
          NODE_EXTRA_CA_CERTS: certFile }, stdio: ['ignore','pipe','pipe'] });
      let out = ''; child.stdout.on('data', (v) => { out += v; }); child.stderr.on('data', (v) => { out += v; });
      child.on('error', reject); child.on('close', (status) => resolve({ status, out }));
    });
    assert.ok(!result.out.includes(canary), 'no credential is printed');
    assert.ok(reachedTLS, 'the trusted HTTPS provider received the initial authenticated call');
    assert.equal(plaintext, false, 'the redirect sent the hosted service key to a remote HTTP endpoint');
  } finally {
    await close(provider); await close(target); await db.drop(); rmSync(folder, { recursive: true, force: true });
  }
});
