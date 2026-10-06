// SPDX-License-Identifier: AGPL-3.0-only
//
// P6 (docs/plan/sandbox-contract.md, section 6): the sweep does not depend
// on the proxy's record, because the daemon can hold a container the proxy
// never recorded. It lists every container, read as an array of objects of
// which only a 64-hex `Id` is taken; force-deletes every listed id, where
// "no such container" counts as removed; lists again, which must be empty;
// and `GET /info` must report zero containers. A malformed list, any other
// delete answer, a second list that is not empty, or a count above zero
// fails the sweep, and the caller retries it every 30 s.

import { expect, it } from 'vitest';
import { sweep, SWEEP_RETRY_MS, type SweepDaemon } from '../../packages/core-sandbox/src/sweep.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
type Reply = { readonly status: number; readonly body: Uint8Array };
const reply = (status: number, value?: unknown): Reply => ({
  status,
  body: value === undefined ? new Uint8Array() : json(value),
});

/** A daemon double: lists answered in turn, deletes by id, and one count; it logs each call. */
function daemon(
  lists: readonly Reply[],
  deletes: Readonly<Record<string, number>> = {},
  containers = 0,
) {
  const calls: string[] = [];
  let listed = 0;
  const port: SweepDaemon = {
    list: () => {
      calls.push('list');
      listed += 1;
      return Promise.resolve(lists[listed - 1] ?? reply(200, []));
    },
    remove: (id) => {
      calls.push(`delete ${id.slice(0, 1)}`);
      return Promise.resolve(reply(deletes[id] ?? 204));
    },
    info: () => {
      calls.push('info');
      return Promise.resolve(reply(200, { Containers: containers, Images: 3 }));
    },
  };
  return { port, calls };
}
const failed = { ok: false, reason: 'internal', why: 'sweep' };

it('deletes every listed id, recorded or not, then finds the daemon empty', async () => {
  const { port, calls } = daemon([
    reply(200, [{ Id: A, Names: ['/x'] }, { Id: B }]),
    reply(200, []),
  ]);
  expect(await sweep(port)).toEqual({ ok: true });
  expect(calls).toEqual(['list', 'delete a', 'delete b', 'list', 'info']);
});

it('counts a delete answered "no such container" as removed', async () => {
  const { port } = daemon([reply(200, [{ Id: A }]), reply(200, [])], { [A]: 404 });
  expect(await sweep(port)).toEqual({ ok: true });
});

it('fails on any other delete answer', async () => {
  const runs = [409, 500, 200].map((status) =>
    sweep(daemon([reply(200, [{ Id: A }]), reply(200, [])], { [A]: status }).port),
  );
  expect(await Promise.all(runs)).toEqual([failed, failed, failed]);
});

it('fails on a malformed list before deleting anything', async () => {
  const doubles = [
    reply(200, [{ Id: A.slice(1) }]),
    reply(200, [{ Id: A.toUpperCase() }]),
    reply(200, { Id: A }),
    reply(200, [{ id: A }]),
    reply(500, []),
  ].map((list) => daemon([list]));
  const results = await Promise.all(doubles.map(({ port }) => sweep(port)));
  expect(results).toEqual(doubles.map(() => failed));
  expect(doubles.map(({ calls }) => calls)).toEqual(doubles.map(() => ['list']));
});

it('fails when the second list is not empty or the daemon still counts a container', async () => {
  const again = daemon([reply(200, [{ Id: A }]), reply(200, [{ Id: B }])]);
  expect(await sweep(again.port)).toEqual(failed);
  const counted = daemon([reply(200, []), reply(200, [])], {}, 1);
  expect(await sweep(counted.port)).toEqual(failed);
  expect(counted.calls).toEqual(['list', 'list', 'info']);
});

it('retries a failed sweep every 30 s', () => {
  expect(SWEEP_RETRY_MS).toBe(30_000);
});
