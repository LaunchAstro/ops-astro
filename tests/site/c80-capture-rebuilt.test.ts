// SPDX-License-Identifier: AGPL-3.0-only
//
// C80, the eleventh security re-bind of PR 364, M1: </div> pops formatting elements but leaves them
// on the active list, and each later run of text rebuilds every one no longer open. Tags of
// distinct attributes pass the three-copy limit, so 250 of them then <div>X</div> repeated to 1 MiB
// made about 21 million elements: Node died out of heap, which no catch can answer.
//
// The capture runs in a child Node with its heap capped at 512 MB, so a parse with no bound kills
// the child, not the test runner; the child reports the answer and the parse's time.

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const INDEX = new URL('../../packages/core-connectors/src/index.ts', import.meta.url).href;

const CHILD = `
import { capturePage } from ${JSON.stringify(INDEX)};
const ABOUT = 'https://www.example.com/about';
const head = '<div>' + Array.from({ length: 250 }, (_, at) => '<b a' + at + '>').join('') + '</div>';
const unit = '<div>X</div>';
const body = head + unit.repeat(Math.floor((1024 * 1024 - head.length) / unit.length));
const page = {
  kind: 'answer',
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: new TextEncoder().encode(body),
};
const started = performance.now();
const result = await capturePage(ABOUT, {
  pool: { agencyPages: [ABOUT], otherPages: [], closedPoolReviews: [] },
  resolve: () => Promise.resolve(['93.184.215.14']),
  transport: () => Promise.resolve(page),
});
const ms = performance.now() - started;
console.log(JSON.stringify({ code: result.ok ? 'ok' : result.code, ms, length: body.length }));
`;

/** The child's answer, or how it died. */
function inChild(): { code: string; ms: number; length?: number } {
  const run = spawnSync(
    process.execPath,
    ['--max-old-space-size=512', '--input-type=module', '--eval', CHILD],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  const last = run.stdout.trim().split('\n').at(-1) ?? '';
  if (run.status === 0 && last.startsWith('{'))
    return JSON.parse(last) as { code: string; ms: number };
  if (/heap out of memory/u.test(run.stderr)) return { code: 'died out of heap', ms: Number.NaN };
  return { code: `died: ${run.signal ?? run.status} ${run.stderr.slice(-300)}`, ms: Number.NaN };
}

describe('C80 the fenced capture, the eleventh re-bind', () => {
  it('refuses rebuilt formatting elements as oversized within five seconds, not out of heap', () => {
    const answer = inChild();
    expect(answer.code).toBe('CAPTURE_OVERSIZED');
    expect(answer.length).toBeGreaterThan(1_048_000);
    expect(answer.ms).toBeLessThan(5000);
  }, 180_000);
});
