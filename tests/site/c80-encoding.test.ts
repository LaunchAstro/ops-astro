// SPDX-License-Identifier: AGPL-3.0-only
//
// C80: the fenced capture reads a page or sheet only in the encoding a browser would: UTF-8, named
// on the one Content-Type line, read as a browser reads it.

import { describe, expect, it } from 'vitest';
import { fencedFetch, type FenceRefusal } from '../../packages/core-connectors/src/index.ts';
import { ABOUT, POOL, PUBLIC_V4, html, resolverOf, transportOf } from './c80-fence-world.ts';

// Security review of P25, fifth re-bind, finding 1: with no charset parameter a browser reads the
// page in the encoding its markup declares, while the capture read UTF-8 whatever it declared.
const typed = (type: string, body: string) => ({
  ...html(body),
  headers: { 'content-type': type },
});
const page = (type: string, body: string, recorded: FenceRefusal[] = []) =>
  fencedFetch(ABOUT, {
    pool: POOL,
    resolve: resolverOf([PUBLIC_V4]),
    transport: transportOf(() => typed(type, body)),
    kind: 'document',
    record: (refusal) => recorded.push(refusal),
  });

// The sixth re-bind, finding 1: a browser reads every Content-Type line, split on commas, with the
// WHATWG MIME parser, where the capture split one line on each `;`. Bodies hold a windows-1252 meta.
type Row = readonly ['document' | 'stylesheet', string, number, object, boolean];
const served = ([kind, type, lines, coding]: Row) => {
  const headers = { 'content-type': type, ...coding };
  const answer = { ...html('<meta charset=windows-1252>é'), headers, contentTypeLines: lines };
  const options = { pool: POOL, resolve: resolverOf([PUBLIC_V4]), page: ABOUT, kind };
  const url = kind === 'document' ? ABOUT : `${ABOUT}.css`;
  return fencedFetch(url, { ...options, transport: transportOf(() => answer) });
};
const [DOC, CSS, NONE, NBSP] = ['text/html; charset=utf-8', 'text/css', {}, '\u00A0'];
describe('C80 capture, the document encoding', () => {
  it.each([
    ['text/html', '<meta charset=windows-1252><p>Base é</p>'],
    [
      'text/html',
      '<meta http-equiv=content-type content="text/html; charset=windows-1252"><p>é</p>',
    ],
    ['text/html; q=1', '<meta charset=iso-2022-kr><p>Base SHOWN</p>'],
    ['TEXT/HTML', '<meta charset=iso-2022-jp><p>Base \u001B$B</p>'],
    ['text/html', '<p>Base</p>'],
  ])(
    'refuses and records a page served as %s holding %j, its charset unnamed',
    async (type, body) => {
      const recorded: FenceRefusal[] = [];
      expect(await page(type, body, recorded)).toEqual({
        ok: false,
        code: 'CAPTURE_BODY_MALFORMED',
      });
      expect(recorded.map((entry) => entry.code)).toEqual(['CAPTURE_BODY_MALFORMED']);
    },
  );

  it.each(['text/html; charset=utf-8', 'text/html; charset=UTF-8'])(
    'reads a page served as %s as UTF-8, whatever its markup declares',
    async (type) => {
      const body = '<meta charset=windows-1252><p>Base é</p>';
      expect(await page(type, body)).toMatchObject({ ok: true, value: { body } });
    },
  );

  it.each([
    ['document', 'text/html; x="a;charset=utf-8;"', 1, NONE, false],
    ['document', 'text/html; charset =utf-8', 1, NONE, false],
    ['document', DOC, 2, NONE, false],
    ['stylesheet', CSS, 2, NONE, false],
    ['document', `${NBSP}${DOC}`, 1, NONE, false],
    ['document', `${DOC}; x=1, text/plain`, 1, NONE, false],
    ['stylesheet', `${CSS}; x=1, text/plain`, 1, NONE, false],
    ['document', DOC, 1, { 'content-encoding': 'br' }, false],
    ['document', DOC, 1, { 'transfer-encoding': 'gzip' }, false],
    ['document', 'text/html;charset="UTF-8"', 1, { 'transfer-encoding': 'chunked' }, true],
    ['stylesheet', CSS, 1, NONE, true],
  ] as const)('reads a %s as %j, %i line(s), with %j, only as UTF-8: %s', async (...row) => {
    expect((await served(row)).ok).toBe(row[4]);
  });
});
