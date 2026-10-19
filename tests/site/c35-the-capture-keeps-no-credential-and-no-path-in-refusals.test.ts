// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2013): a capture the fence refuses says so by code alone. The agency's page answers
// with a redirect to a members' path carrying a token, which the fence refuses. Nothing the
// runner printed, sent to the API after its pickup (the hand-back's report included) or
// stored names that path, its token, or the pickup's credential; and no request the fence
// made carried a credential of any kind.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, underReview, type C35World } from '../review/c35-world.ts';
import { capturesOf } from '../review/c35-landing.ts';
import { agentCalls, capturePass, PAGE, queueCapture, replay } from './c35-runner-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 capture refusals: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35runcanary');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const PATH_CANARY = 'members-canary-3f9e1c';
const TOKEN_CANARY = 'canary-token-77d2a0';
const HIDDEN = `https://agency.example/${PATH_CANARY}/?token=${TOKEN_CANARY}`;
const browserAt = () => () => Promise.reject(new Error('no browser for a refused page'));

describe.skipIf(serverUrl === undefined)('C35 a refused capture', () => {
  it('C35 the capture keeps no credential and no path in refusals', async () => {
    const reviewed = await underReview(w, 'a page that redirects to a members area');
    await queueCapture(w, reviewed);
    const call = agentCalls(w);
    const transport = replay({
      [PAGE]: {
        kind: 'answer',
        status: 302,
        headers: { location: HIDDEN },
        body: new Uint8Array(),
      },
    });
    const printed: string[] = [];
    const keep = (...line: unknown[]) => void printed.push(line.map(String).join(' '));
    vi.spyOn(console, 'log').mockImplementation(keep);
    vi.spyOn(console, 'error').mockImplementation(keep);
    vi.spyOn(console, 'warn').mockImplementation(keep);

    const captured = await capturePass(w, { call, transport, browserAt });

    expect(captured).toStrictEqual([
      { taskId: reviewed.taskId, outcome: 'CAPTURE_HOST_NOT_CATALOGUED' },
    ]);
    const pickup = call.sent.find((one) => one.verb === 'task.pickup')?.answer as {
      detail: { credential: string };
    };
    const credential = pickup.detail.credential;
    expect(credential.length).toBeGreaterThan(0);
    const afterPickup = call.sent.filter((one) => one.verb !== 'task.pickup');
    const told = JSON.stringify([printed, afterPickup.map(({ verb, body }) => ({ verb, body }))]);
    expect(afterPickup.map((one) => one.verb)).toContain('task.handback');
    for (const canary of [PATH_CANARY, TOKEN_CANARY, credential]) {
      expect(told).not.toContain(canary);
    }
    const rows = JSON.stringify(await capturesOf(w, reviewed.revisionId));
    expect(rows).not.toContain(PATH_CANARY);
    for (const request of transport.asked) {
      const names = Object.keys(request.headers).map((name) => name.toLowerCase());
      expect(names).not.toContain('authorization');
      expect(names).not.toContain('cookie');
    }
  }, 60_000);
});
