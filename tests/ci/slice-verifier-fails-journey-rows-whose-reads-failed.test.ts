// SPDX-License-Identifier: AGPL-3.0-only
import { ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { verify } from './slice-verifier.fixture.ts';

it('failed queue and lineage reads cannot certify hand-back and unchanged state', async () => {
  const names = [
    'J15 the agent hands back and the queue no longer shows it',
    'J16 a stale-version decision is VERSION_SUPERSEDED with unchanged state',
  ];
  const control = await verify({});
  for (const name of names) expect(control.get(name)).toBe('pass');
  let handedBack = false;
  let failedReads = 0;
  const blind = (response: ServerResponse) =>
    handedBack &&
    response.req.headers.authorization === 'Bearer ada@alpha.local' &&
    ['/api/b/alpha/task/queue', '/api/b/alpha/task/read'].includes(response.req.url ?? '');
  const writeHead = ServerResponse.prototype.writeHead;
  const end = ServerResponse.prototype.end;
  const headers = vi.spyOn(ServerResponse.prototype, 'writeHead').mockImplementation(function (
    this: ServerResponse,
    ...args: Parameters<ServerResponse['writeHead']>
  ) {
    if (blind(this)) args[0] = 503;
    return writeHead.apply(this, args);
  });
  const bodies = vi.spyOn(ServerResponse.prototype, 'end').mockImplementation(function (
    this: ServerResponse,
    ...args: Parameters<ServerResponse['end']>
  ) {
    if (this.req.url === '/api/a/b/alpha/task/handback') handedBack = true;
    if (blind(this)) {
      args[0] = '{}';
      failedReads += 1;
    }
    return end.apply(this, args);
  });
  try {
    const rows = await verify({});
    expect(failedReads).toBe(3);
    for (const name of names) expect.soft([name, rows.get(name)]).toStrictEqual([name, 'FAIL']);
  } finally {
    headers.mockRestore();
    bodies.mockRestore();
  }
}, 30_000);
