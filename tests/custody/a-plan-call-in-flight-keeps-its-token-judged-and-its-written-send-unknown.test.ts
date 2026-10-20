// SPDX-License-Identifier: AGPL-3.0-only
//
// A plan call in flight, through the real custody process and a loopback
// endpoint (#1620 P4, Sol's proofs on #1916, assertions unchanged). A prepare
// that takes on a replacement pair meanwhile leaves the call judged against
// the token it went out under, so an echo of that token never leaves custody.
// A timeout after the request was written is never told as nothing sent.

import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { seed, tokens, HOUR } from './fixtures/plan-token-world.ts';
import { open } from './fixtures/plan-inflight-world.ts';
import { planRequest } from './fixtures/plan-route-world.ts';
import { completed, stream } from './fixtures/plan-answer-world.ts';

it('a concurrent prepare cannot expose the token of an in-flight call', async () => {
  const w = await open();
  try {
    let pending!: ServerResponse;
    w.onRequest((res) => {
      pending = res;
    });
    const dispatch = w.custody.dispatchBefore('chatgpt_plan', planRequest(), {
      deadlineAt: Date.now() + 3000,
      onWritten: () => {},
    });
    await w.arrived;
    // A same-account sign-in commits a replacement pair while the first call is in flight.
    await seed(w.dir.file, {
      state: 'ready',
      tokens: {
        ...tokens('after', Date.now() + 2 * HOUR),
        accessToken: randomBytes(48).toString('base64url'),
        refreshToken: randomBytes(48).toString('base64url'),
      },
    });
    expect(await w.custody.prepare()).toEqual({ ok: true });
    pending.writeHead(200, { 'content-type': 'text/event-stream' });
    pending.end(stream(completed([`Echo ${w.old.accessToken}.`])));
    const result = await dispatch;
    expect(JSON.stringify(result).includes(w.old.accessToken)).toBe(false);
  } finally {
    await w.close();
  }
}, 15000);

it('a timeout after the request is written cannot claim nothing was sent', async () => {
  const w = await open();
  try {
    w.onRequest(() => {});
    let written = false;
    const result = await w.custody.dispatchBefore(
      'chatgpt_plan',
      { ...planRequest(), timeoutMs: 100 },
      {
        deadlineAt: Date.now() + 3000,
        onWritten: () => {
          written = true;
        },
      },
    );
    await w.arrived;
    expect(written).toBe(true);
    expect(result).not.toMatchObject({ kind: 'refused', started: false });
  } finally {
    await w.close();
  }
}, 15000);

it('a malformed answer after the request is written is withheld, never refused as unsent', async () => {
  const w = await open();
  try {
    w.onRequest((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const result = await w.custody.dispatchBefore('chatgpt_plan', planRequest(), {
      deadlineAt: Date.now() + 3000,
      onWritten: () => {},
    });
    expect(result).toStrictEqual({ kind: 'withheld', started: true, reason: 'malformed' });
  } finally {
    await w.close();
  }
}, 15000);
