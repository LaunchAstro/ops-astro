// SPDX-License-Identifier: AGPL-3.0-only
//
// The served-identity check (T2b, spike RN-03). Reads the API's identity
// directly and through the web origin, and the web dev server's own, then
// compares them with this checkout's commit tree and migration files. Every
// browser or served-API proof from T2b on records its output.
//
// Usage: node scripts/local/identity-check.mjs
//   API_ORIGIN (default http://127.0.0.1:8790), WEB_ORIGIN (default http://127.0.0.1:5190)

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { identityDefects, migrationHead } from '../../apps/api/identity.ts';

const root = resolve(import.meta.dirname, '../..');
const api = process.env['API_ORIGIN'] ?? 'http://127.0.0.1:8790';
const web = process.env['WEB_ORIGIN'] ?? 'http://127.0.0.1:5190';

async function read(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return await response.json();
}

const migrations = join(root, 'migrations');
const files = readdirSync(migrations)
  .filter((name) => name.endsWith('.sql'))
  .map((name) => ({
    version: name.slice(0, -'.sql'.length),
    checksum: createHash('sha256')
      .update(readFileSync(join(migrations, name)))
      .digest('hex'),
  }));

const evidence = {
  api: await read(`${api}/api/identity`),
  apiViaWeb: await read(`${web}/api/identity`),
  web: await read(`${web}/__identity`),
  evidenceTree: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD^{tree}'], {
    encoding: 'utf8',
  }).trim(),
  migrationFiles: migrationHead(files),
};
const defects = identityDefects(evidence);
console.log(
  JSON.stringify({
    apiTree: evidence.api.tree,
    webTree: evidence.web.tree,
    migrationHead: evidence.api.migrationHead,
    clean: defects.length === 0,
    defects,
  }),
);
process.exitCode = defects.length === 0 ? 0 : 1;
