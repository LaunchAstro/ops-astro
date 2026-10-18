// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by the sidebar correction suites: the labelled mock for the door's
// port, the tasks a door is opened on, the door's three fields, and readers
// for the card.

import type { CorrectionAsk, ProposePort } from '../../apps/web/src/assistant/correction.ts';
import { json, type mount } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';

/**
 * MOCK: stands in for the door's `live_correction.request` port where a suite
 * is about the card. It answers each ask with the next made-up id, or the
 * given code.
 */
export function mockPropose(refusal: string | null = null) {
  const asked: CorrectionAsk[] = [];
  const port: ProposePort = (ask) => {
    asked.push(ask);
    return Promise.resolve(
      refusal === null
        ? { ok: true, correctionId: `mock-correction-${String(asked.length)}` }
        : { ok: false, code: refusal },
    );
  };
  return { port, asked };
}

export type View = Awaited<ReturnType<typeof mount>>;

export async function askFor(view: View, ask: CorrectionAsk): Promise<void> {
  await view.type('[data-correction-door] [name="page"]', ask.page);
  await view.type('[data-correction-door] [name="word"]', ask.word);
  await view.type('[data-correction-door] [name="replacement"]', ask.replacement);
  await view.click('[data-correction-ask]');
  await tick();
}

export const ABOUT = { page: 'About', word: 'alongside', replacement: 'beside' };

export const controls = (view: View): string[] =>
  view.all('[data-correction-card] button').map((button) => button.textContent ?? '');

/** The first card drawn, or null. */
export const card = (view: View): HTMLElement | null =>
  view.find('[data-correction-card]') as HTMLElement | null;

/** A task on client A, whose site has the About page: the server finds the page from it. */
export const TASK_A = '22222222-2222-4222-8222-222222222222';
/** A task on client B, whose site has the Pricing page. */
export const TASK_B = '55555555-5555-4555-8555-555555555555';

/** How long a read's version check holds in these suites: longer than any of them runs. */
export const CHECK_HOLDS_MS = 600_000;

export const V1 = '11111111-1111-4111-8111-111111111111';
export const V2 = '22222222-2222-4222-8222-222222222222';

export const refusal = (code: string, status: number): Response =>
  json({ refused: true, code, names: [], fixes: [] }, status);
