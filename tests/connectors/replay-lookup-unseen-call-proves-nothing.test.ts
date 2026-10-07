// SPDX-License-Identifier: AGPL-3.0-only
//
// The stand-in's honest lookup says the provider began nothing only for a call
// it received and refused. A call it has not received yet may still arrive and
// be processed, so a lookup for it must never answer the code the operation
// declared as proof that nothing happened: the broker would release the hold
// while the request can still begin.

import { afterEach, expect, it } from 'vitest';
import {
  REPLAY_COMPOSE,
  REPLAY_LOOKUP_PATH,
  REPLAY_PATH,
  startReplayProvider,
  type ReplayProvider,
} from '../../packages/core-connectors/src/index.ts';

let provider: ReplayProvider | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
});

const post = async (origin: string, path: string, operationId: string): Promise<Response> =>
  await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation_id: operationId }),
  });

const lookedUp = async (origin: string, operationId: string): Promise<unknown> =>
  ((await (await post(origin, REPLAY_LOOKUP_PATH, operationId)).json()) as { code: unknown }).code;

it('a lookup for a call the provider has not received yet proves nothing, and the late call still begins', async () => {
  provider = await startReplayProvider();
  const { origin } = provider;
  const { nothingHappened } = REPLAY_COMPOSE;
  const declared: readonly unknown[] = Array.isArray(nothingHappened) ? nothingHappened : [];

  // Asked before the call arrives: not the declared proof that nothing happened.
  expect(declared).not.toContain(await lookedUp(origin, 'late-call'));
  // The original request then arrives and is processed.
  await (await post(origin, REPLAY_PATH, 'late-call')).text();
  expect(provider.processed.has('late-call')).toBe(true);
  expect(await lookedUp(origin, 'late-call')).toBe('completed');

  // Control: a call the provider received and refused is the declared proof.
  provider.mode('unavailable');
  await (await post(origin, REPLAY_PATH, 'refused-call')).text();
  expect(declared).toContain(await lookedUp(origin, 'refused-call'));
});
