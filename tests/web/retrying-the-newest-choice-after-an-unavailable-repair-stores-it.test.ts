// SPDX-License-Identifier: AGPL-3.0-only
//
// One person's newest preference is the one the server keeps, over the
// composed API, however the answers of two sign-ins' saves come back: an
// older save stored after the newest one can answer first, and the newest
// save's own answer can be lost after it was stored. Either way the person's
// last choice must be what a read finds.

import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { savePreference } from '../../apps/web/src/data/preference-saves.ts';
import { nextRequest, type Tag } from '../../apps/web/src/data/owned.ts';
import { tabOwnerGeneration } from '../../apps/web/src/session/token.ts';
import { adaToken, call, read, usePreferencesWorld } from '../api/preferences-world.ts';

usePreferencesWorld('sol1502repair');

type Step = (stored: () => Promise<Response>, body: Record<string, unknown>) => Promise<Response>;

/** A sign-in's client over the composed API; `step` decides when a save reaches it and answers. */
function signIn(step: Step): OperationsClient {
  return new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const saving = String(input).endsWith('/preference/save');
      const stored = async (): Promise<Response> => {
        const answer = await call(saving ? 'preference.save' : 'preference.read', body, adaToken);
        expect(answer.status, JSON.stringify(answer.body)).toBe(200);
        return Response.json(answer.body, { status: answer.status });
      };
      return saving ? step(stored, body) : stored();
    },
  });
}

function gate(): { readonly open: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { open, release };
}

const tag = (person: string): Tag => ({
  business: 'alpha',
  person,
  request: nextRequest(),
  tab: tabOwnerGeneration(),
});

const turn = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

it('retrying the newest choice after an unavailable repair stores that choice', async () => {
  const held = gate();
  const first = signIn(async (stored) => {
    await held.open;
    return stored();
  });
  let firstId: unknown;
  let attempts = 0;
  const latest = signIn(async (stored, body) => {
    attempts++;
    if (attempts === 1) {
      firstId = body['operationId'];
      await stored();
      return new Response('lost answer', { status: 503 });
    }
    // The repair's fresh operation never reaches storage; the person's retry does.
    if (attempts === 2 && body['operationId'] !== firstId)
      return new Response('unavailable', { status: 503 });
    return stored();
  });
  const person = 'alpha:ada:lost-repair';
  const dark = savePreference(first, 'appearance', 'dark', tag(person));
  await turn();
  expect(await savePreference(latest, 'appearance', 'light', tag(person))).toMatchObject({
    unavailable: true,
  });
  expect((await read(adaToken))['appearance']).toBe('light');
  held.release();
  await dark;
  await turn();
  await turn();
  expect((await read(adaToken))['appearance']).toBe('dark');
  expect(await savePreference(latest, 'appearance', 'light', tag(person))).toMatchObject({
    ok: true,
  });
  await turn();
  await turn();
  expect((await read(adaToken))['appearance']).toBe('light');
});
