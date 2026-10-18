// SPDX-License-Identifier: AGPL-3.0-only
//
// One restore drill as a process of its own, for
// restore-drill-killed-parent.test.ts to kill mid-drill: real Docker, a made-up
// sealed archive, its container named under the prefix it is given. Once the
// container's server answers, it prints the container's name and stops at the
// restore, until it is killed.

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { sealArchive } from '../../scripts/ops/archive-seal.mjs';
import { docker } from '../../scripts/ops/drill-docker.mjs';
import { restoreDrill } from '../../scripts/ops/drill-restore.mjs';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const body = sealArchive(Buffer.from('a made-up dump'), keys.publicKey);

await restoreDrill({
  fetchArchive: () => Promise.resolve({ takenAt: '2026-10-18T00:00:00.000Z', body }),
  privateKey: keys.privateKey,
  scope: { business: randomUUID(), client: randomUUID(), person: randomUUID() },
  prefix: process.argv[2],
  docker: (args, input, options) => {
    if (!args.includes('pg_restore')) return docker(args, input, options);
    process.stdout.write(`${args[args.indexOf('-i') + 1]}\n`);
    setInterval(() => {}, 60_000);
    return new Promise(() => {});
  },
});
