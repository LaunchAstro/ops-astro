// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one capture around every path the canary could leak by */
//
// C57 (#2017): the shepherd's approved send against each hostile answer the fake provider gives
// and a destination custody does not list, and a planted address, a planted credential value and
// a planted marker in the review's client words that must reach nowhere they do not belong.
// Custody's real process, the fake on loopback, no network.

import { describe, expect, it, vi } from 'vitest';
import type { FakeEmailMode } from '../../packages/core-connectors/src/index.ts';
import { consoleLine, streamText } from '../support/console-text.ts';
import {
  approveAs,
  approved,
  attemptsOf,
  custodyListing,
  itemOf,
  noDatabase,
  on,
  raisedScene,
  send,
  shepherd,
  useShepherdWorld,
  w,
} from './shepherd-world.ts';

useShepherdWorld('c57hostile');

const HOSTILE: readonly (readonly [FakeEmailMode, string])[] = [
  ['redirect', 'redirect'],
  ['oversized', 'too_large'],
  ['malformed', 'malformed'],
  ['slow', 'timeout'],
];

/** A raised, approved send's item for its scene's own person. */
async function approvedItem(): Promise<string> {
  const { scene, raised } = await raisedScene();
  await approved('alpha', raised);
  return await itemOf(raised, scene.recipient.personId);
}

describe.skipIf(noDatabase)("C57 a hostile provider and a canary on the shepherd's send", () => {
  it('C57 hostile provider: redirected, oversized, malformed and slow answers are a failed attempt keeping only the fault', async () => {
    try {
      for (const [mode, fault] of HOSTILE) {
        // oxlint-disable-next-line no-await-in-loop
        const item = await approvedItem();
        w.provider.mode(mode);
        const started = Date.now();
        // oxlint-disable-next-line no-await-in-loop
        const result = await send('alpha', item);
        expect(Date.now() - started, mode).toBeLessThan(5_000);
        expect(result, mode).toMatchObject({ ok: false, code: 'EMAIL_FAILED', fault });
        // oxlint-disable-next-line no-await-in-loop
        expect(await attemptsOf(item), mode).toStrictEqual([
          { state: 'asked', evidence: 'class:relationship' },
          { state: 'failed', evidence: fault },
        ]);
        // Each of these may have gone: never sent again, even once the provider accepts.
        w.provider.mode('accept');
        const received = w.provider.received.length;
        // oxlint-disable-next-line no-await-in-loop
        expect(await send('alpha', item), mode).toStrictEqual({
          ok: false,
          code: 'EMAIL_MAY_HAVE_GONE',
        });
        expect(w.provider.received.length, mode).toBe(received);
      }
      expect(w.provider.outbox).toStrictEqual([]);
    } finally {
      w.provider.mode('accept');
    }
  });

  it('C57 hostile provider: a destination custody does not list is refused, recorded as unlisted, nothing reaches the provider', async () => {
    const item = await approvedItem();
    const elsewhere = await custodyListing(['other']);
    try {
      const received = w.provider.received.length;
      expect(await send('alpha', item, elsewhere.broker)).toMatchObject({
        ok: false,
        code: 'EMAIL_FAILED',
        fault: 'unlisted',
      });
      expect(w.provider.received.length).toBe(received);
      expect(await attemptsOf(item)).toStrictEqual([
        { state: 'asked', evidence: 'class:relationship' },
        { state: 'failed', evidence: 'unlisted' },
      ]);
    } finally {
      await elsewhere.stop();
    }
  });

  it('C57 canary: a planted address, credential and client marker never reach logs, errors, attempts or audit rows', async () => {
    const written: string[] = [];
    const capture = (chunk: unknown): boolean => {
      written.push(streamText(chunk));
      return true;
    };
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(capture),
      vi.spyOn(process.stderr, 'write').mockImplementation(capture),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          written.push(consoleLine(...args));
        }),
      ),
    ];
    const results: unknown[] = [];
    const addresses: string[] = [];
    const markers: string[] = [];
    try {
      for (const mode of ['accept', 'redirect', 'malformed', 'slow', 'refuse'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        const { scene, run, raised } = await raisedScene();
        addresses.push(scene.recipient.address ?? '');
        markers.push(scene.marker);
        // A stale approval and a cross-business approval are refused; then the exact one.
        // oxlint-disable-next-line no-await-in-loop
        const stale = await approveAs('alpha', on('alpha').decider, {
          sendId: raised.sendId,
          digest: '0'.repeat(64),
        });
        // oxlint-disable-next-line no-await-in-loop
        const foreign = await approveAs('bravo', on('bravo').decider, {
          sendId: raised.sendId,
          digest: raised.digest,
        });
        results.push(raised, stale, foreign);
        // oxlint-disable-next-line no-await-in-loop
        await approved('alpha', raised);
        w.provider.mode(mode);
        // oxlint-disable-next-line no-await-in-loop
        const item = await itemOf(raised, scene.recipient.personId);
        // oxlint-disable-next-line no-await-in-loop
        results.push(await send('alpha', item), await shepherd(run, scene.review));
        w.provider.mode('accept');
        // oxlint-disable-next-line no-await-in-loop
        results.push(await send('alpha', item));
      }
      // A send through custody that lists no destination for it.
      const { scene, raised } = await raisedScene();
      addresses.push(scene.recipient.address ?? '');
      markers.push(scene.marker);
      await approved('alpha', raised);
      const elsewhere = await custodyListing(['other']);
      try {
        results.push(
          await send('alpha', await itemOf(raised, scene.recipient.personId), elsewhere.broker),
          elsewhere.custody.stderr(),
        );
      } finally {
        await elsewhere.stop();
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      w.provider.mode('accept');
    }
    // The positive control: a planted address reached the provider; no marker ever did.
    const delivered = w.provider.received.map((message) => message.body).join('\n');
    expect(addresses.some((address) => delivered.includes(address))).toBe(true);
    expect(
      markers.some((marker) => delivered.includes(marker)),
      'a marker reached the mail',
    ).toBe(false);
    const stored = await w.db.admin.execute(
      `select (select coalesce(json_agg(d), '[]') from public.inbox_delivery_attempts d)::text as a,
              (select coalesce(json_agg(e), '[]') from public.audit_events e)::text as e,
              (select coalesce(json_agg(s), '[]') from public.review_shepherd_sends s)::text as s,
              (select coalesce(json_agg(r.data), '[]') from public.records r
                where r.data ->> 'source' = 'shepherd')::text as c`,
    );
    const haystack = [
      ...written,
      w.custody.stderr(),
      JSON.stringify(results),
      JSON.stringify(stored),
    ].join('\n');
    // Booleans, so a failure here does not print the planted value itself.
    for (const address of addresses) {
      expect(haystack.includes(address), 'a planted address leaked').toBe(false);
      expect(haystack.includes(address.split('@')[0] ?? address), 'its local part leaked').toBe(
        false,
      );
    }
    for (const marker of markers) {
      expect(haystack.includes(marker), 'a planted client marker leaked').toBe(false);
    }
    expect(haystack.includes(w.key), 'the mail key leaked').toBe(false);
  });
});
