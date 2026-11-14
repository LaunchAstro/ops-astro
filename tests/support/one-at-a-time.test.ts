// SPDX-License-Identifier: AGPL-3.0-only
//
// A body still running past its case's timeout keeps every later body waiting,
// however many cases time out while it runs: only the next one starts when it
// ends, never two at once (Sol's S2440-1 on #2440).

import { expect, it } from 'vitest';
import { oneAtATime } from './one-at-a-time.ts';

function held(): { readonly done: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { done, release };
}

const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

it('starts one waiting body at a time after a slow body ends', async () => {
  const inTurn = oneAtATime();
  const order: string[] = [];
  let active = 0;
  let peak = 0;
  const gates = { a: held(), b: held(), c: held() };
  const body = (name: keyof typeof gates) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    order.push(name);
    await gates[name].done;
    active -= 1;
  };
  // A outlasts its own and B's deadlines, so B and C are both handed in
  // while A still runs, as vitest does once each case times out.
  const runs = [inTurn(body('a'))];
  await settled();
  runs.push(inTurn(body('b')));
  await settled();
  runs.push(inTurn(body('c')));
  await settled();
  expect(order).toStrictEqual(['a']);

  gates.a.release();
  await settled();
  expect(order, 'B starts alone; C waits for B').toStrictEqual(['a', 'b']);

  gates.b.release();
  gates.c.release();
  await Promise.all(runs);
  expect(order).toStrictEqual(['a', 'b', 'c']);
  expect(peak).toBe(1);
});

it('a body that fails still lets the next one run', async () => {
  const inTurn = oneAtATime();
  const failed = inTurn(() => Promise.reject(new Error('slow prefix failed')));
  const next = inTurn(() => Promise.resolve('ran'));
  await expect(failed).rejects.toThrow('slow prefix failed');
  await expect(next).resolves.toBe('ran');
});
