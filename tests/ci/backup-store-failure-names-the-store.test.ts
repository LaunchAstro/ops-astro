// SPDX-License-Identifier: AGPL-3.0-only
//
// A backup run names the stage that failed: a store that refuses while the
// upload waits on a healthy dump's next piece is the store's failure, and a
// dump whose pieces throw is the dump's. The store is a stand-in reach that
// reads the script as psql would.

import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

type Reach = (url: string, script: AsyncIterable<string>) => Promise<string>;
type Source = AsyncIterable<Buffer> & { stop?: () => Promise<void> };
const BACKUP = '../../scripts/ops/backup.mjs';
const { runBackup } = (await import(
  /* @vite-ignore */
  BACKUP
)) as {
  runBackup: (options: {
    dump: () => Promise<Source>;
    storeUrl: string;
    publicKey: string;
    heartbeat?: string;
    send?: () => Promise<string>;
    reach: Reach;
  }) => Promise<Record<string, unknown>>;
};

const { publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** A healthy dump that has printed its first piece and is still working on the next. */
function slowDump(): Source {
  const halt = new AbortController();
  async function* pieces() {
    yield Buffer.from('PGDMP made-up');
    await new Promise((resolve) => {
      halt.signal.addEventListener('abort', resolve);
    });
  }
  return Object.assign(pieces(), {
    stop: () => {
      halt.abort();
      return Promise.resolve();
    },
  });
}

const backup = (dump: Source, reach: Reach) =>
  runBackup({ dump: () => Promise.resolve(dump), storeUrl: 'store', publicKey, reach });

/** psql reading the opening lines when the store refuses them, the dump still working. */
const refusing: Reach = async (_url, script) => {
  const lines = script[Symbol.asyncIterator]();
  await lines.next();
  void lines.next();
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  throw new Error('the store refused');
};

/** psql reading the whole script. */
const reading: Reach = async (_url, script) => {
  const lines = [];
  for await (const line of script) lines.push(line);
  return '';
};

async function* broken() {
  yield Buffer.from('PGDMP made-up');
  throw new Error('pg_dump failed');
}

describe('backup failure stage', () => {
  it('names the store when it refuses while the dump is still working', async () => {
    const record = await backup(slowDump(), refusing);
    expect(record['stage'], 'a store refusal recorded as the dump').toBe('store');
  });

  it('names the dump when its pieces throw', async () => {
    expect((await backup(broken(), reading))['stage']).toBe('dump');
  });
});
