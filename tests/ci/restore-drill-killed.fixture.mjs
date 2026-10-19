// SPDX-License-Identifier: AGPL-3.0-only
//
// One restore drill as a process of its own, for
// restore-drill-killed-parent.test.ts to kill mid-drill: real Docker, a made-up
// sealed archive, its container named under the prefix it is given. It
// prints the container's name and stops, until it is killed: at the restore,
// once the container's server answers, or, given `start`, as soon as Docker
// made the container, before the drill hears back from `docker run`.

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
  docker: async (args, input, options) => {
    if (process.argv[3] === 'start' && args[0] === 'run') {
      const result = await docker(args, input, options);
      if (result.code !== 0) throw new Error('real Docker start failed');
      process.stdout.write(`${args[args.indexOf('--name') + 1]}\n`);
      setInterval(() => {}, 60_000);
      return new Promise(() => {});
    }
    if (!args.includes('pg_restore')) return docker(args, input, options);
    process.stdout.write(`${args[args.indexOf('-i') + 1]}\n`);
    setInterval(() => {}, 60_000);
    return new Promise(() => {});
  },
});
