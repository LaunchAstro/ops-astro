// SPDX-License-Identifier: AGPL-3.0-only
//
// The slice verifier passes a lifecycle row only on a task read that shows the
// revision its write answered. That is a write then a read on two requests, so
// another writer can land between them, and the write's answer can be lost
// after the server applied it. Neither may turn a row to pass that the
// verifier's own write did not earn.

import { Server, ServerResponse, type IncomingMessage } from 'node:http';
import { expect, it, vi } from 'vitest';
import { verify } from './slice-verifier.fixture.ts';

const MIA = 'Bearer mia@alpha.local';

/** Noah, on a connection of his own, edits the one task there is. */
async function noahEdits(host: string): Promise<boolean> {
  const as = { 'content-type': 'application/json', authorization: 'Bearer noah@alpha.local' };
  const board = await fetch(`${host}/api/b/alpha/task/board`, {
    method: 'POST',
    headers: as,
    body: '{}',
  });
  const [task] = ((await board.json()) as { tasks: { id: string; revision: number }[] }).tasks;
  const edit = await fetch(`${host}/api/b/alpha/task/update`, {
    method: 'POST',
    headers: as,
    body: JSON.stringify({
      recordId: task?.id,
      expectedRevision: task?.revision,
      fields: { priority: 'high' },
    }),
  });
  return edit.status === 200;
}

it('a write another person overtakes before its read-back fails that row and no other', async () => {
  const emit = Server.prototype.emit;
  let reads = 0;
  let overtaken = 0;
  const spy = vi.spyOn(Server.prototype, 'emit').mockImplementation(function (
    this: Server,
    event: string | symbol,
    ...args: unknown[]
  ) {
    const request = args[0] as IncomingMessage | undefined;
    const mine =
      event === 'request' &&
      request?.url === '/api/b/alpha/task/read' &&
      request.headers.authorization === MIA;
    if (mine) reads += 1;
    // The second read is the one after the assignment: hold it until Noah's edit lands.
    if (!mine || reads !== 2) return Reflect.apply(emit, this, [event, ...args]) as boolean;
    void noahEdits(`http://${request.headers.host ?? ''}`).then((edited) => {
      if (edited) overtaken += 1;
      return Reflect.apply(emit, this, [event, ...args]) as boolean;
    });
    return true;
  });
  try {
    const rows = await verify({});
    expect(overtaken).toBe(1);
    // Established: the read shows Noah's revision, not the one the assignment
    // answered, so the row fails rather than passing on his write.
    expect(rows.get('B2 assign noah')).toBe('FAIL');
    expect(rows.get('B3 start')).toBe('pass');
  } finally {
    spy.mockRestore();
  }
}, 60_000);

it('a write applied whose answer is lost never passes its row', async () => {
  for (const [path, row] of [
    ['/api/b/alpha/task/assign', 'B2 assign noah'],
    ['/api/b/alpha/task/start', 'B3 start'],
    ['/api/b/alpha/task/complete', 'B3 complete'],
    ['/api/b/alpha/task/reopen', 'B3 reopen'],
    ['/api/b/alpha/task/update', 'B4 update title and due'],
  ] as const) {
    const original = ServerResponse.prototype.writeHead;
    let lost = 0;
    const spy = vi.spyOn(ServerResponse.prototype, 'writeHead').mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<ServerResponse['writeHead']>
    ) {
      // The slice has applied the write by now; its answer never arrives.
      if (this.req.url === path && this.req.headers.authorization === MIA && lost === 0) {
        lost += 1;
        this.req.socket.destroy();
        return this;
      }
      return original.apply(this, args);
    });
    try {
      // oxlint-disable-next-line no-await-in-loop -- one walk at a time
      const rows = await verify({});
      expect.soft([path, lost]).toStrictEqual([path, 1]);
      // Established: the walk stops there; no row from the lost write on is a pass.
      expect.soft([path, rows.get(row)]).not.toStrictEqual([path, 'pass']);
      expect.soft([path, rows.get('read back')]).not.toStrictEqual([path, 'pass']);
    } finally {
      spy.mockRestore();
    }
  }
}, 120_000);
