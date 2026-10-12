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

usePreferencesWorld('newestprefwins');

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

it('an older save stored after the newest one but answering first does not keep the older choice', async () => {
  const older = gate();
  const newer = gate();
  // The older sign-in's save is slow to reach the server; the newer one's answer is slow to come back.
  const first = signIn(async (stored) => {
    await older.open;
    return stored();
  });
  const latest = signIn(async (stored) => {
    const answer = await stored();
    await newer.open;
    return answer;
  });
  const person = 'alpha:ada:answers-out-of-order';
  const dark = savePreference(first, 'appearance', 'dark', tag(person));
  await turn();
  const light = savePreference(latest, 'appearance', 'light', tag(person));
  await turn();
  expect((await read(adaToken))['appearance']).toBe('light');
  older.release();
  expect(await dark).toMatchObject({ ok: true });
  expect((await read(adaToken))['appearance']).toBe('dark');
  newer.release();
  expect(await light).toMatchObject({ ok: true });
  await turn();
  await turn();
  expect((await read(adaToken))['appearance']).toBe('light');
});

it('a retry of the newest save whose answer was lost does not leave an older save stored over it', async () => {
  const older = gate();
  let lose = true;
  const first = signIn(async (stored) => {
    await older.open;
    return stored();
  });
  // The newest save is stored, and its answer is lost on the way back once.
  const latest = signIn(async (stored) => {
    const answer = await stored();
    if (!lose) return answer;
    lose = false;
    return new Response('upstream gone', { status: 503 });
  });
  const person = 'alpha:ada:lost-newest-answer';
  const dark = savePreference(first, 'appearance', 'dark', tag(person));
  await turn();
  const lost = await savePreference(latest, 'appearance', 'light', tag(person));
  expect(lost).toMatchObject({ unavailable: true });
  older.release();
  expect(await dark).toMatchObject({ ok: true });
  await turn();
  // The person sees the save did not answer and makes the same choice again: the same intent,
  // so its operation id is the lost one's and the server replays the stored outcome.
  expect(await savePreference(latest, 'appearance', 'light', tag(person))).toMatchObject({
    ok: true,
  });
  await turn();
  await turn();
  expect((await read(adaToken))['appearance']).toBe('light');
});
