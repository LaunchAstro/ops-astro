// SPDX-License-Identifier: AGPL-3.0-only
//
// The large-archive cases of `S0-3 store reach`, live (REV158S criterion 5),
// run by staging-backup-reach-live.test.ts against its real `backups` service,
// which staging's definition holds to 512m of memory. An archive larger than
// that goes into the store and comes back to the drill in parts, the stored
// total exact, and neither the job nor the drill ever holds it whole; one over
// the cap is refused part way through and the store keeps nothing of it.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { expect } from 'vitest';

type Reach = (
  url: string,
  script: string | Iterable<string> | AsyncIterable<string>,
  onLine?: (line: string) => unknown,
) => Promise<string>;
type Live = {
  reach: Reach;
  logins: Record<string, string>;
  keys: { publicKey: string; privateKey: string };
  asAdmin: (script: string) => { status: number | null; out: string };
  scratch: string;
};

const PART = 4 * 1024 * 1024;
const importOps = async <T>(name: string): Promise<T> => {
  const path = `../../scripts/ops/${name}`;
  return (await import(
    /* @vite-ignore */
    path
  )) as T;
};
const send = (): Promise<string> => Promise.resolve('sent');
const job = async () =>
  await importOps<{
    runBackup: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
  }>('backup.mjs');

const collect = (() => {
  setFlagsFromString('--expose-gc');
  return runInNewContext('gc') as () => void;
})();

/**
 * The most this process's live heap and buffers grow above where they stood
 * when it started: sampled every 100 ms after a full collection, so it counts
 * what is held, not garbage not yet collected.
 */
function watermark(): { stop: () => number } {
  const live = () => {
    collect();
    const { heapUsed, arrayBuffers } = process.memoryUsage();
    return heapUsed + arrayBuffers;
  };
  const base = live();
  let peak = 0;
  const timer = setInterval(() => {
    peak = Math.max(peak, live() - base);
  }, 100);
  return {
    stop: () => {
      clearInterval(timer);
      return peak;
    },
  };
}

/** A made-up dump of `size` bytes, streamed a MiB at a time. */
async function* dumpOf(size: number): AsyncGenerator<Buffer> {
  const piece = randomBytes(1024 * 1024);
  for (let at = 0; at < size; at += piece.length) yield piece;
}

/** An archive of 520 MiB, over the store's 512m: stored exactly, fetched back, never held whole. */
export async function largeArchive(live: Live): Promise<void> {
  const { runBackup } = await job();
  const watch = watermark();
  const added = await runBackup({
    dump: () => Promise.resolve(dumpOf(520 * 1024 * 1024)),
    storeUrl: live.logins['ops_astro_backup'],
    publicKey: live.keys.publicKey,
    reach: live.reach,
    send,
  });
  const jobPeak = watch.stop();
  expect(added).toMatchObject({ outcome: 'recorded' });
  const bytes = Number(added['bytes']);
  expect(bytes).toBeGreaterThan(520 * 1024 * 1024);
  expect(
    live.asAdmin(`select concat_ws('|', a.bytes, a.parts,
        (select sum(length(chunk)) from backups.archive_parts p where p.archive_id = a.id),
        s.bytes = (select sum(bytes) from backups.archives))
      from backups.archives a, backups.stored s order by a.taken_at desc limit 1`).out,
  ).toBe(`${bytes}|${Math.ceil(bytes / PART)}|${bytes}|t`);

  const { fetchLatest } = await importOps<{
    fetchLatest: (
      url: string,
      file: string,
      reach: Reach,
    ) => Promise<{ sha256: string; bytes: number }>;
  }>('restore-drill.mjs');
  const { checkSealedFile } = await importOps<{
    checkSealedFile: (file: string, key: string) => Promise<void>;
  }>('archive-seal.mjs');
  const file = join(live.scratch, 'large');
  const again = watermark();
  const fetched = await fetchLatest(
    live.logins['ops_astro_backup_restore'] ?? '',
    file,
    live.reach,
  );
  const drillPeak = again.stop();
  expect(fetched.bytes).toBe(bytes);
  const whole = createHash('sha256');
  for await (const chunk of createReadStream(file)) whole.update(chunk as Buffer);
  expect(whole.digest('hex')).toBe(fetched.sha256);
  await checkSealedFile(file, live.keys.privateKey);
  rmSync(file);
  // Holding the archive whole takes at least its size, over 520 MiB; each end
  // holds a few parts at most.
  expect(jobPeak, 'the job').toBeLessThan(64 * 1024 * 1024);
  expect(drillPeak, 'the drill').toBeLessThan(64 * 1024 * 1024);
}

/** An archive of three parts where two fit: refused, and nothing of it kept. */
export async function overTheCap(live: Live): Promise<void> {
  const { runBackup } = await job();
  const set = live.asAdmin(
    `update backups.settings set max_bytes = (select bytes from backups.stored) + ${2 * PART}`,
  );
  expect(set.status, set.out).toBe(0);
  const held = () =>
    live.asAdmin(`select concat_ws('|', (select count(*) from backups.archives),
      (select count(*) from backups.archive_parts), (select count(*) from backups.receipts),
      (select bytes from backups.stored))`).out;
  const before = held();
  const refused = await runBackup({
    dump: () => Promise.resolve(randomBytes(3 * PART)),
    storeUrl: live.logins['ops_astro_backup'],
    publicKey: live.keys.publicKey,
    reach: live.reach,
    send,
  });
  expect(refused).toMatchObject({ outcome: 'failed', stage: 'store' });
  expect(held()).toBe(before);
}
