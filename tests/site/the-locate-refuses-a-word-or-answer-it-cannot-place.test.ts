// SPDX-License-Identifier: AGPL-3.0-only
//
// #1693: the site runner's locate settles a request it cannot place, and pins
// nothing. On a real database, one locate pass through custody over a double
// of the source host:
// - a word the page's file does not hold as a whole word settles `unlocated
//   WORD_NOT_FOUND`;
// - file content that is not the canonical base64 of UTF-8 settles
//   `unlocated PROVIDER_RESPONSE_MALFORMED`;
// - a file read that times out is a failed check, backed off 30 s, and the
//   first one once the request is 120 s old settles it `unlocated
//   SITE_UNREACHABLE`.
// Every request handed to custody is a read, and no case leaves a version.
/* eslint-disable max-lines-per-function -- each case keeps its passes and the row they leave in one place */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Custody, CustodyOutcome } from '../../packages/core-custody/src/index.ts';
import { ABOUT, BEFORE, PAGE } from './c80-world.ts';
import { serverUrl } from './c80-register-world.ts';
import {
  dueNow,
  locateOnce,
  noneWaiting,
  requestOn,
  requestedAgo,
  rowOf,
  sourceDouble,
  type SourceDouble,
} from './locate-world.ts';
import { useRunnerWorld } from './site-runner-world.ts';

useRunnerWorld();

const TIMED_OUT: CustodyOutcome = {
  kind: 'answered',
  started: true,
  outbound: { ok: false, fault: 'timeout', status: null },
  credentialKind: 'api_key',
  account: null,
};

/** The double, its answer to every read of `path` replaced by `answer` (given its own), each request still counted. */
function answering(
  double: SourceDouble,
  path: string,
  answer: (own: CustodyOutcome) => CustodyOutcome,
): SourceDouble {
  const dispatch: Custody['dispatch'] = async (ref, request) => {
    const own = await double.ports.custody.dispatch(ref, request);
    const { pathname } = new URL(request.path, 'https://source.invalid');
    const read = decodeURIComponent(pathname.split('/contents/')[1] ?? '');
    return read === path ? answer(own) : own;
  };
  return { ...double, ports: { ...double.ports, custody: { dispatch } } };
}

/** The provider's own answer, its file content replaced by `content`. */
const withContent =
  (content: string) =>
  (own: CustodyOutcome): CustodyOutcome => {
    if (own.kind !== 'answered' || !own.outbound.ok) throw new Error('the double did not answer');
    const body = { ...(JSON.parse(own.outbound.body) as Record<string, unknown>), content };
    return { ...own, outbound: { ...own.outbound, body: JSON.stringify(body) } };
  };

/** Settled `unlocated` with `code`, and no part of a version stored. */
async function unpinned(id: string, code: string): Promise<void> {
  const row = await rowOf(id);
  expect(row).toMatchObject({
    state: 'unlocated',
    locate_code: code,
    version_id: null,
    base_revision: null,
    pre_image_digest: null,
    version_digest: null,
    verified_at: null,
  });
}

const onlyReads = (double: SourceDouble): boolean =>
  double.requests.every((asked) => asked.startsWith('GET '));

beforeEach(async () => {
  if (serverUrl !== undefined) await noneWaiting();
});

describe.skipIf(serverUrl === undefined)(
  'the locate refuses a word or an answer it cannot place',
  () => {
    it.each([
      ['a word the file does not hold', 'marvellous'],
      ['a word the file holds only inside a longer one', 'friend'],
    ])('settles %s unlocated WORD_NOT_FOUND, pinning nothing', async (_name, word) => {
      const id = await requestOn(PAGE, { word, replacement: 'splendid' });
      const double = sourceDouble({ [ABOUT]: BEFORE });

      expect(await locateOnce(double)).toEqual([{ correctionId: id, outcome: 'WORD_NOT_FOUND' }]);
      await unpinned(id, 'WORD_NOT_FOUND');
      // The head, then the file at it: two reads and nothing else.
      expect(double.requests).toHaveLength(2);
      expect(onlyReads(double)).toBe(true);
    });

    it.each([
      ['text that is not base64', '%%% not base64 %%%'],
      ['base64 without its padding', 'V2U'],
      ['base64 of bytes that are not UTF-8', Buffer.from([0xff, 0xfe, 0xfd]).toString('base64')],
    ])(
      'settles file content of %s unlocated PROVIDER_RESPONSE_MALFORMED, pinning nothing',
      async (_name, content) => {
        const id = await requestOn(PAGE);
        const double = answering(sourceDouble({ [ABOUT]: BEFORE }), ABOUT, withContent(content));

        expect(await locateOnce(double)).toEqual([
          { correctionId: id, outcome: 'PROVIDER_RESPONSE_MALFORMED' },
        ]);
        await unpinned(id, 'PROVIDER_RESPONSE_MALFORMED');
        expect(double.requests).toHaveLength(2);
        expect(onlyReads(double)).toBe(true);
      },
    );

    it('backs a timed-out file read off 30 s, then settles it SITE_UNREACHABLE once 120 s old, pinning nothing', async () => {
      const id = await requestOn(PAGE);
      const double = answering(sourceDouble({ [ABOUT]: BEFORE }), ABOUT, () => TIMED_OUT);

      // A timeout is a failed check, not a settlement: the request waits 30 s for the next try.
      expect(await locateOnce(double)).toEqual([{ correctionId: id, outcome: 'CHECK_FAILED' }]);
      const waiting = await rowOf(id);
      expect(waiting).toMatchObject({
        state: 'locating',
        locate_code: null,
        check_failures: 1,
        version_id: null,
      });
      expect(waiting.next_in).toBeGreaterThan(25);
      expect(waiting.next_in).toBeLessThanOrEqual(30);

      // Requested 121 s ago: the next timeout settles it.
      await requestedAgo(id, 121);
      await dueNow(id);
      expect(await locateOnce(double)).toEqual([{ correctionId: id, outcome: 'SITE_UNREACHABLE' }]);
      await unpinned(id, 'SITE_UNREACHABLE');
      expect(double.requests).toHaveLength(4);
      expect(onlyReads(double)).toBe(true);
    });
  },
);
