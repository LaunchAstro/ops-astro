// SPDX-License-Identifier: AGPL-3.0-only
//
// #742: an export reads each part from the store sealed under a key of its
// own, then asks the operator gate, and only then has the store release that
// key (deploy/staging/backup-store-upgrade-3.sql). The operator's grant is
// held from that ask until the key arrives, so a revocation cannot land
// between them; the part's read itself is never under the hold, so a
// revocation never waits on a part read (security L1).

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { carried, drillModule, folder, gateOf, TAKEN } from './carried-archive.fixture.ts';
import { twoPhaseStore, type Taken } from './two-phase-store.fixture.ts';

const REVOKED = 'the operator no longer holds operations:manage';

/** One archive of `body`, as the planted store's header names it. */
async function headerOf(body: Buffer) {
  const { digestOf } = await carried();
  return { id: randomUUID(), takenAt: TAKEN, bytes: body.length, parts: 1, sha256: digestOf(body) };
}

/**
 * An export of `body` through a gate whose every ask, and a store whose every
 * script taken and line printed, is noted, each marked when the grant is held.
 */
async function watchedExport(body: Buffer): Promise<{ events: string[]; file: string }> {
  const events: string[] = [];
  let held = false;
  const gate = {
    ...gateOf(),
    stillOperator: () => {
      events.push(held ? 'ask (held)' : 'ask');
      return Promise.resolve();
    },
    holdingGrant: async <T>(during: (release: () => void) => Promise<T>): Promise<T> => {
      held = true;
      try {
        return await during(() => {
          held = false;
        });
      } finally {
        held = false;
      }
    },
  };
  const note = (verb: string) => (what: Taken) =>
    events.push(`${verb} ${what}${held ? ' (held)' : ''}`);
  const reach = twoPhaseStore(await headerOf(body), body, {
    taken: note('takes'),
    printing: note('prints'),
  });
  const file = join(folder('released'), 'archive.sealed');
  const { exportArchive } = await drillModule();
  await exportArchive({ gate, storeUrl: 'store', file, reach });
  return { events, file };
}

describe('an export releases a part only after the last ask', () => {
  it('takes the key under the held grant, asked last under that hold, and never holds it over the read', async () => {
    const body = Buffer.from('-- a made-up sealed archive\n');
    const { events, file } = await watchedExport(body);
    expect(readFileSync(file).equals(body)).toBe(true);
    const release = events.indexOf('takes release (held)');
    expect(release, 'the store took a release under the held grant').toBeGreaterThan(0);
    expect(events.slice(release - 1, release + 2)).toEqual([
      'ask (held)',
      'takes release (held)',
      'prints release (held)',
    ]);
    expect(
      events.filter((event) => event.includes(' part')),
      'the read is never held',
    ).toEqual(['takes part', 'prints part']);
  });

  it('a gate that refuses once the sealed part is in sends no release and keeps nothing', async () => {
    const body = Buffer.from('-- a made-up sealed archive\n');
    const taken: Taken[] = [];
    const gate = {
      ...gateOf(),
      stillOperator: () =>
        taken.includes('part') ? Promise.reject(new Error(REVOKED)) : Promise.resolve(),
    };
    const reach = twoPhaseStore(await headerOf(body), body, { taken: (what) => taken.push(what) });
    const file = join(folder('refused'), 'archive.sealed');
    const { exportArchive } = await drillModule();
    await expect(exportArchive({ gate, storeUrl: 'store', file, reach })).rejects.toThrow();
    expect({ taken, kept: existsSync(file) }).toEqual({ taken: ['header', 'part'], kept: false });
  });
});
