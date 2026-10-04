// SPDX-License-Identifier: AGPL-3.0-only
//
// C80, Sol's first review of PR 364, criterion 1: the capture's cost stays linear in the page.
// parse5's adoption agency moves a furthest block's children one first child at a time; each
// move searched and shifted every sibling after it, so a shallow page of 1,950,010 bytes took
// 32.7 s. The parser-bound rows in c80-capture.test.ts answer within the same five seconds.

import { describe, expect, it } from 'vitest';
import { capturePage, type TransportAnswer } from '../../packages/core-connectors/src/index.ts';
import { ABOUT, POOL, PUBLIC_V4, html, resolverOf } from './c80-fence-world.ts';

const captured = (body: string) =>
  capturePage(ABOUT, {
    pool: POOL,
    resolve: resolverOf([PUBLIC_V4]),
    transport: (): Promise<TransportAnswer> => Promise.resolve(html(body)),
  });

describe('C80 the fenced capture, Sol R1', () => {
  it('Sol proof, criterion 1: shallow adoption-agency input stays within the linear capture bound', async () => {
    const body = `<b><p>${'<br>'.repeat(487_500)}</b>`;
    expect(body).toHaveLength(1_950_010);
    const started = performance.now();
    const result = await captured(body);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(5000);
    expect(result.ok ? 'ok' : result.code).toBe('CAPTURE_OVERSIZED');
  }, 600_000);
});
