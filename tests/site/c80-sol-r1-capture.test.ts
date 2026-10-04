// SPDX-License-Identifier: AGPL-3.0-only
//
// C80, Sol's first review of PR 364, criterion 1: the capture's cost stays linear in the page.
// parse5's adoption agency moves a furthest block's children one first child at a time; each
// move searched and shifted every sibling after it, so a shallow page of 1,950,010 bytes took
// 32.7 s. The parser-bound rows in c80-capture.test.ts answer within the same five seconds.
// The twelfth re-bind, L1: rebuilt formatting elements share their tag's 255 attributes, and the
// capture read every one, so a 2 MiB page of them answered in about four seconds.

import { describe, expect, it } from 'vitest';
import { capturePage, type TransportAnswer } from '../../packages/core-connectors/src/index.ts';
import { ABOUT, POOL, PUBLIC_V4, html, resolverOf } from './c80-fence-world.ts';

const captured = (body: string) =>
  capturePage(ABOUT, {
    pool: POOL,
    resolve: resolverOf([PUBLIC_V4]),
    transport: (): Promise<TransportAnswer> => Promise.resolve(html(body)),
  });

describe('C80 the fenced capture keeps its cost linear in the page', () => {
  it('refuses rebuilt elements that carry 255 attributes each well inside a second', async () => {
    const names = Array.from({ length: 254 }, (_, at) => ` a${at}`).join('');
    const head = `<div>${Array.from({ length: 10 }, (_, at) => `<b z=${at}${names}>`).join('')}</div>`;
    const body = head + '<div>X</div>'.repeat(Math.floor((2 * 1024 * 1024 - head.length) / 12));
    const started = performance.now();
    const result = await captured(body);
    const elapsed = performance.now() - started;
    expect(result.ok ? 'ok' : result.code).toBe('CAPTURE_OVERSIZED');
    expect(elapsed).toBeLessThan(1000);
  }, 600_000);
});
