// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2013): review captures are spare work. The host's pass runs the corrections first and
// the captures after them, and takes one capture a pass however many wait, so a backlog of
// reviews never holds a correction back. A claim lands only the widths it handed out: a
// retry after one width landed captures and lands the other alone. A picture the browser
// could not take lands nothing, hands the lease back failed with its code, and still lets
// the pass stand. The API is a double that answers as the real one does; the page is replayed.

import { describe, expect, it } from 'vitest';
import type { AgentCall, Answer } from '../../apps/site-runner/claims.ts';
import { passFor } from '../../apps/site-runner/main.ts';
import { CAPTURE_PURPOSE, reviewCaptures } from '../../apps/site-runner/review-captures.ts';
import type { PictureBrowser } from '../../packages/core-connectors/src/index.ts';
import { AGENCY_POOL, PAGE, publicResolver, replay } from './c35-runner-world.ts';

const REVISION = '5f0e8a8e-6f0c-4d8e-9a55-3c1d2b4a6e70';
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** A database whose one read names the asked revision of the task's review on the about page. */
const db = {
  withBusiness: async (_business: string, work: (tx: unknown) => Promise<unknown>) =>
    await work({
      businessId: 'b1',
      query: async () => await Promise.resolve([{ revision_id: REVISION, page_url: PAGE }]),
    }),
} as never;

/** The API double: `waiting` capture steps on the queue, the claim handing out `widths`. */
function api(
  waiting: number,
  widths: readonly number[] = [390, 1480],
): AgentCall & { readonly asked: { verb: string; body: Readonly<Record<string, unknown>> }[] } {
  const asked: { verb: string; body: Readonly<Record<string, unknown>> }[] = [];
  const answers: Record<string, Answer> = {
    'task.queue': {
      detail: {
        queue: Array.from({ length: waiting }, (_, n) => ({
          reservationId: `r${String(n)}`,
          taskId: `t${String(n)}`,
          purpose: CAPTURE_PURPOSE,
        })),
      },
    },
    'task.pickup': {
      detail: { leaseId: 'l1', fence: 1, credential: 'pickup-credential', holderActorId: 'a1' },
    },
    'review.capture_claim': { detail: { revisionId: REVISION, widths } },
    'task.heartbeat': { detail: {} },
    'review.capture_land': { detail: {} },
    'task.handback': { detail: {} },
  };
  const call: AgentCall = async (verb, body) => {
    asked.push({ verb, body });
    return await Promise.resolve(answers[verb] ?? { fault: true });
  };
  return Object.assign(call, { asked });
}

/**
 * A browser that renders a PNG at any width, recording each width it was opened at: it asks
 * for the page, its stylesheet and the copy that sheet's answer imports, as a browser does.
 */
const rendering = (opened: number[]) => (width: 1480 | 390) => {
  opened.push(width);
  const browser: PictureBrowser = async (url, route) => {
    await route({ url, kind: 'document', mainFrame: true });
    const sheet = new URL('/_astro/site.css', url).href;
    const answer = await route({ url: sheet, kind: 'stylesheet', mainFrame: false });
    const copy = /^@import "([^"]*)";/u.exec(answer?.body ?? '')?.[1];
    if (copy !== undefined) await route({ url: copy, kind: 'stylesheet', mainFrame: false });
    return PNG_BYTES;
  };
  return browser;
};

const crashing = () => () => Promise.reject(new Error('the browser crashed'));

const jobOn = (call: AgentCall, browserAt: (width: 1480 | 390) => PictureBrowser) =>
  reviewCaptures({
    call,
    db,
    business: 'b1' as never,
    capture: { pool: AGENCY_POOL, resolve: publicResolver, transport: replay() },
    browserAt,
  });

describe('C35 review captures are spare work', () => {
  it('runs after the corrections and takes one capture a pass however many wait', async () => {
    const order: string[] = [];
    const call = api(3);
    const captures = jobOn(call, rendering([]));
    const pass = passFor(false, {
      locate: async () => {
        order.push('locate');
        return await Promise.resolve([]);
      },
      claims: async () => {
        order.push('corrections');
        return await Promise.resolve([]);
      },
      captures: async () => {
        order.push('captures');
        return await captures();
      },
    });

    await pass();

    expect(order).toStrictEqual(['locate', 'corrections', 'captures']);
    expect(call.asked.filter((one) => one.verb === 'task.pickup')).toHaveLength(1);
    expect(call.asked.filter((one) => one.verb === 'review.capture_land')).toHaveLength(2);
  });
});

describe('C35 a review capture lands what it took', () => {
  it('lands only the widths its claim handed out', async () => {
    const opened: number[] = [];
    const call = api(1, [390]);

    expect(await jobOn(call, rendering(opened))()).toStrictEqual([
      { taskId: 't0', outcome: 'landed' },
    ]);
    expect(opened).toStrictEqual([390]);
    const lands = call.asked.filter((one) => one.verb === 'review.capture_land');
    expect(lands.map((one) => one.body['width'])).toStrictEqual([390]);
  });

  it('a picture the browser could not take lands nothing and hands the lease back failed', async () => {
    const call = api(1);

    expect(await jobOn(call, crashing)()).toStrictEqual([
      { taskId: 't0', outcome: 'CAPTURE_FAILED' },
    ]);
    expect(call.asked.filter((one) => one.verb === 'review.capture_land')).toStrictEqual([]);
    expect(call.asked.find((one) => one.verb === 'task.handback')?.body).toMatchObject({
      outcome: 'failed',
      report: { capture: 'CAPTURE_FAILED' },
    });
  });
});
