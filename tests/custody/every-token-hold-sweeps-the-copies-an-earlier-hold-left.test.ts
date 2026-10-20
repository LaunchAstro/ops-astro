// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P1, second sign-in custody check Q4: the design sweeps every `.next`
// and `.undo` copy at the start of every lock hold, so no token copy survives
// beyond the next hold. A copy an earlier hold left (a failed `.undo` removal,
// a writer killed between link and rename) is gone after any hold that reads
// or writes the record, the sign-in seam's shape included, not only after a
// holder's prepare.

import { readdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  commitBytes,
  commitTokenFile,
  HOST_REGISTRATION_FILE,
  readTokenFileLocked,
} from '../../packages/core-custody/src/token-file.ts';
import { withTokenLock, type HeldLock } from '../../packages/core-custody/src/token-lock.ts';
import { HOUR, T0, seed, tempDir, tokens } from './fixtures/plan-token-world.ts';

const soon = (): { deadlineAt: number } => ({ deadlineAt: Date.now() + 5_000 });
const KEPT = ['plan-token.json', 'plan-token.json.lock', 'plan-token.json.state'];

/** Leftovers of an earlier hold: a replaced pair's `.undo`, an uncommitted `.next`, and the host file's. */
function plant(dir: string): string[] {
  const names = [
    'plan-token.json.0123456789abcdef.undo',
    'plan-token.json.fedcba9876543210.next',
    `${HOST_REGISTRATION_FILE}.00112233445566ff.next`,
  ];
  for (const name of names)
    writeFileSync(`${dir}/${name}`, 'synthetic-refresh-replaced', { mode: 0o600 });
  return names;
}

it.each<[string, (held: HeldLock, file: string) => unknown]>([
  [
    'a sign-in shaped hold (read, judge, commit)',
    (held, file) => {
      readTokenFileLocked(held, file);
      return commitTokenFile(held, file, { state: 'ready', tokens: tokens('new', T0 + HOUR) });
    },
  ],
  ['a hold that only reads', (held, file) => readTokenFileLocked(held, file)],
  [
    'a hold that only writes the token file',
    (held, file) =>
      commitTokenFile(held, file, { state: 'ready', tokens: tokens('new', T0 + HOUR) }),
  ],
  [
    'a hold that only writes the host registration',
    (held, file) =>
      commitBytes(held, file.replace(/[^/]+$/u, HOST_REGISTRATION_FILE), Buffer.from('{}')),
  ],
])('%s leaves no copy an earlier hold left', async (_name, work) => {
  const w = tempDir();
  try {
    await seed(w.file, { state: 'ready', tokens: tokens('old', T0 + HOUR) });
    plant(w.dir);
    const out = await withTokenLock(w.file, soon(), (held) => Promise.resolve(work(held, w.file)));
    expect(out.held).toBe(true);
    expect(
      readdirSync(w.dir)
        .filter((n) => n !== HOST_REGISTRATION_FILE)
        .toSorted(),
    ).toEqual(KEPT);
  } finally {
    w.done();
  }
});

it('healthy: a file that is not a copy stays, and a hold not on the lock sweeps nothing', async () => {
  const w = tempDir();
  try {
    await seed(w.file, { state: 'ready', tokens: tokens('old', T0 + HOUR) });
    writeFileSync(`${w.dir}/plan-token.json.notes`, 'kept', { mode: 0o600 });
    let dead: HeldLock | undefined;
    await withTokenLock(w.file, soon(), (held) => {
      dead = held;
      readTokenFileLocked(held, w.file);
      return Promise.resolve();
    });
    const planted = plant(w.dir);
    expect(readTokenFileLocked(dead as HeldLock, w.file)).toEqual({
      state: 'refused',
      code: 'SUBSCRIPTION_STORE_FAILED',
    });
    expect(readdirSync(w.dir).toSorted()).toEqual(
      [...KEPT, 'plan-token.json.notes', ...planted].toSorted(),
    );
  } finally {
    w.done();
  }
});
