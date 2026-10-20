// SPDX-License-Identifier: AGPL-3.0-only
//
// Demo data for a live business, the command (#2211). The decisions and the
// safeguards are in `demo-data.ts`; this file runs them.
//
//   node scripts/ops/demo-data.mjs seed <manifest.json>
//   node scripts/ops/demo-data.mjs remove <manifest.json>
//
// The person's own act, with OPS_ASTRO_TOKEN (their sign-in), OPS_ASTRO_API
// (the app's address) and OPS_ASTRO_BUSINESS (the business key) set. `seed`
// makes the manifest when it is absent and saves it after every step, so a
// rerun carries on and replays; `remove` trashes the manifest's tasks only.
// The manifest holds ids and names, never a credential. Prints counts, never
// a value of the environment. Exit 0 when done, 1 when refused.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createCli, httpTransport } from '../../apps/cli/client.ts';
import { CLIENTS, Refusal, remove, seed, THREADS } from './demo-data.ts';

const [verb, file] = process.argv.slice(2);
const token = process.env['OPS_ASTRO_TOKEN'] ?? '';
const api = process.env['OPS_ASTRO_API'] ?? '';
const business = process.env['OPS_ASTRO_BUSINESS'] ?? '';

function stop(why) {
  console.error(`demo-data: REFUSED, ${why}. Nothing more was done.`);
  process.exit(1);
}

if (!['seed', 'remove'].includes(verb ?? '') || file === undefined) {
  stop('run it as `demo-data.mjs seed|remove <manifest.json>`');
}
for (const [name, value] of [
  ['OPS_ASTRO_TOKEN', token],
  ['OPS_ASTRO_API', api],
  ['OPS_ASTRO_BUSINESS', business],
]) {
  if (value === '') stop(`${name} is not set`);
}
if (!/^https:\/\/[^/]+$|^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(api)) {
  stop('OPS_ASTRO_API is not an https origin');
}

let manifest;
if (existsSync(file)) {
  manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.version !== 1 || manifest.business !== business || manifest.api !== api) {
    stop(`${file} is another business's or address's manifest`);
  }
} else if (verb === 'seed') {
  manifest = {
    version: 1,
    batch: randomBytes(6).toString('hex'),
    business,
    api,
    createdAt: new Date().toISOString(),
    made: [],
  };
} else {
  stop(`no manifest at ${file}`);
}

/** Written whole, then moved into place, so a stop never leaves half a manifest. */
function save() {
  writeFileSync(`${file}.next`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.next`, file);
}

const cli = createCli({ transport: httpTransport(api), businessKey: business, credential: token });
const send = async (command, body) => {
  const answer = await cli.run(command, body);
  return { status: answer.status, body: answer.body };
};

try {
  if (verb === 'seed') {
    save();
    const fresh = await seed(send, manifest, save);
    const count = (kind) => manifest.made.filter((m) => m.kind === kind).length;
    console.log(
      `demo-data: ${business} batch ${manifest.batch}: made ${String(fresh.length)} this run; ` +
        `clients ${String(count('client'))}, tags ${String(count('tag'))}, tasks ${String(count('task'))}, ` +
        `comments ${String(count('comment'))}, proposals ${String(count('proposal'))}, ` +
        `threads ${String(count('thread'))}; manifest ${file}`,
    );
  } else {
    const { trashed, gone } = await remove(send, manifest);
    console.log(
      `demo-data: ${business} batch ${manifest.batch}: trashed ${String(trashed)} demo tasks, ` +
        `${String(gone)} already gone; kept (no command removes them, #2209): ` +
        `${String(CLIENTS.length)} Demo clients, the Demo tag, ${String(THREADS.length)} Demo threads`,
    );
  }
} catch (error) {
  if (!(error instanceof Refusal)) throw error;
  stop(error.message);
}
