// SPDX-License-Identifier: AGPL-3.0-only
//
// The preference repair (an older sign-in's save answered after the newest
// one, so the newest value is sent again) is queued behind the newest
// client's earlier saves. It sends nothing once the tab's owner has left, and
// it never leaves its value stored over a choice the person made after it.

import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { savePreference } from '../../apps/web/src/data/preference-saves.ts';
import { nextRequest, type Tag } from '../../apps/web/src/data/owned.ts';
import { tabOwnerGeneration } from '../../apps/web/src/session/token.ts';

interface Gate {
  readonly open: Promise<void>;
  readonly release: () => void;
}

function gate(): Gate {
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { open, release };
}

/** A last-write-wins store standing in for the server, and every save it was sent. */
function world() {
  const stored = new Map<string, unknown>();
  const sent: (readonly [string, string, unknown])[] = [];
  const holds = new Map<unknown, Gate>();
  const client = (name: string) =>
    new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: async (_, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const preference = String(body['preference']);
        sent.push([name, preference, body['value']]);
        stored.set(preference, body['value']);
        await holds.get(`${name}:${String(body['value'])}`)?.open;
        return Response.json({ recordId: null, revision: null, detail: {} });
      },
    });
  const hold = (name: string, value: string): Gate => {
    const held = gate();
    holds.set(`${name}:${value}`, held);
    return held;
  };
  return { stored, sent, client, hold };
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

it('a queued repair does not keep its value over a choice made after it', async () => {
  const api = world();
  const older = api.client('older');
  const newer = api.client('newer');
  const newest = api.client('newest');
  const person = 'alpha:ada:repair-then-newer-choice';
  const darkHeld = api.hold('older', 'dark');
  const dark = savePreference(older, 'appearance', 'dark', tag(person));
  await turn();
  await savePreference(newer, 'appearance', 'light', tag(person));
  const densityHeld = api.hold('newer', 'compact');
  const density = savePreference(newer, 'density', 'compact', tag(person));
  await turn();
  darkHeld.release();
  await dark;
  await turn();
  // A step-up gives a new client, and the person chooses again while the repair still waits.
  expect(await savePreference(newest, 'appearance', 'system', tag(person))).toMatchObject({
    ok: true,
  });
  densityHeld.release();
  await density;
  for (let at = 0; at < 6; at += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each turn lets one queued save answer
    await turn();
  }
  expect(api.stored.get('appearance')).toBe('system');
  expect(api.sent.filter(([, preference]) => preference === 'appearance').length).toBeLessThan(6);
});
