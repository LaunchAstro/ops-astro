// SPDX-License-Identifier: AGPL-3.0-only
import { ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { verify } from './slice-verifier.fixture.ts';

it('failed read-back responses cannot prove assignment lifecycle or editing', async () => {
  const original = ServerResponse.prototype.writeHead;
  let reads = 0;
  let failedReads = 0;
  const spy = vi.spyOn(ServerResponse.prototype, 'writeHead').mockImplementation(function (
    this: ServerResponse,
    status,
    headers,
  ) {
    const request = this.req;
    if (
      request.url === '/api/b/alpha/task/read' &&
      request.headers.authorization === 'Bearer mia@alpha.local'
    ) {
      reads += 1;
      // Keep creation's immediate observation successful; fail the five reads
      // immediately following assignment, start, complete, reopen and edit.
      if (reads >= 2 && reads <= 6) {
        failedReads += 1;
        return original.call(this, 503, headers);
      }
    }
    return original.call(this, status, headers);
  });
  try {
    const rows = await verify({});
    expect(failedReads).toBe(5);
    for (const name of [
      'B2 assign noah',
      'B3 start',
      'B3 complete',
      'B3 reopen',
      'B4 update title and due',
    ]) {
      expect.soft([name, rows.get(name)]).toStrictEqual([name, 'FAIL']);
    }
  } finally {
    spy.mockRestore();
  }
}, 30_000);
