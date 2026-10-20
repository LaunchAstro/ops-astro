// SPDX-License-Identifier: AGPL-3.0-only
//
// The slice verifier (`scripts/local/verify-slice.mjs`) passes a row on what it
// read back, not on a write's HTTP 200. Each case runs the script itself, as a
// person does, against an API and a GoTrue made here: one that keeps every
// promise it answers, and one that answers success and keeps one promise less.

import { describe, expect, it } from 'vitest';
import { verify } from './slice-verifier.fixture.ts';

const WRITES = [
  'B2 assign noah',
  'B3 start',
  'B3 complete',
  'B3 reopen',
  'B4 update title and due',
  'read back',
  'board list',
];

const LINEAGE = [
  'J15 the agent hands back and the queue no longer shows it',
  'J16 a stale-version decision is VERSION_SUPERSEDED with unchanged state',
];

describe('the slice verifier reads back what each write claims', () => {
  it('passes the write rows against an API that applies what it answers', async () => {
    const rows = await verify({});
    for (const name of [...WRITES, 'B1 a created task has a state', ...LINEAGE]) {
      expect.soft([name, rows.get(name)]).toStrictEqual([name, 'pass']);
    }
  }, 30_000);

  it('fails assignment, every lifecycle move and the edit when the writes change nothing', async () => {
    const rows = await verify({ inertWrites: true });
    for (const name of WRITES) expect.soft([name, rows.get(name)]).toStrictEqual([name, 'FAIL']);
  }, 30_000);

  it('fails the creation-state row when a created task has no state until reopened', async () => {
    const rows = await verify({ statelessCreate: true });
    expect(rows.get('B1 a created task has a state')).toBe('FAIL');
    expect(rows.get('B3 reopen')).toBe('pass');
  }, 30_000);

  it('fails hand-back and the stale decision when the reads that would show them fail', async () => {
    const rows = await verify({ blindAfterHandback: true });
    for (const name of LINEAGE) expect.soft([name, rows.get(name)]).toStrictEqual([name, 'FAIL']);
  }, 30_000);
});
