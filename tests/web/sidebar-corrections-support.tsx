// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by the sidebar correction suites: the labelled mocks for the door's
// port and the site read, the door's three fields, and readers for the card.

import type { CorrectionAsk, ProposePort } from '../../apps/web/src/assistant/correction.ts';
import type { CorrectionTarget } from '../../apps/web/src/assistant/correction-desks.ts';
import { json, type mount } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';

/**
 * MOCK: stands in for the sidebar's `site.source.propose` until that command
 * is on main. It answers each ask with the next made-up id, or the given code.
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

/** MOCK: the site read that finds the About page's file, until one is on main. */
export const ABOUT_FILE: CorrectionTarget = {
  partyId: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222',
  path: 'src/pages/about.md',
  pageUrl: 'https://client.example.test/about',
  baseRevision: 'abc123',
  before: '# About\n\nWe work alongside the teams who run your website.\n',
};
export const aboutPage = (ask: CorrectionAsk): Promise<CorrectionTarget | null> =>
  Promise.resolve(ask.page === 'About' ? ABOUT_FILE : null);

export const V1 = '11111111-1111-4111-8111-111111111111';
export const V2 = '22222222-2222-4222-8222-222222222222';

export const refusal = (code: string, status: number): Response =>
  json({ refused: true, code, names: [], fixes: [] }, status);
