// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// C80 decision read on the card: the live desk reads a waiting correction's
// decision again through `live_correction.read`, so its card offers "Check
// again" and redraws in place with the approver's name. The client is a
// recorder standing in for the network only; the read itself is proven on the
// real routes in `tests/site/c80-decision-read.test.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { CorrectionTarget } from '../../apps/web/src/assistant/correction.ts';
import { liveDesk } from '../../apps/web/src/assistant/correction-desks.ts';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const CORRECTION = '44444444-4444-4444-8444-444444444444';
const VERSION = '55555555-5555-4555-8555-555555555555';
const LINE = 'We work alongside the teams who run your website.';
const ASK = { page: 'About', word: 'alongside', replacement: 'beside' };

const target: CorrectionTarget = {
  partyId: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222',
  path: 'src/pages/about.astro',
  pageUrl: 'https://agencyastro.com/about',
  baseRevision: 'abc123',
  before: LINE,
};

interface Sent {
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** The API as the desk reaches it: the request, then the decision as `decided` says. */
function server(decided: Readonly<Record<string, unknown>> | 'not-found') {
  const sent: Sent[] = [];
  const client = {
    read: async (name: string, body: Readonly<Record<string, unknown>>) => {
      await Promise.resolve();
      sent.push({ name, body });
      if (name === 'session.capabilities') {
        const grants = [{ collection: 'run', action: 'write' }];
        return { ok: true, value: { ok: true, grants } };
      }
      if (decided === 'not-found') {
        return { ok: false, refused: true, code: 'NOT_FOUND', names: [], fixes: ['Gone.'] };
      }
      return { ok: true, value: { ok: true, correction: decided } };
    },
    mutate: async (name: string, body: Readonly<Record<string, unknown>>) => {
      await Promise.resolve();
      sent.push({ name, body });
      const detail = { correctionId: CORRECTION, versionId: VERSION, state: 'requested' };
      return { ok: true, value: { recordId: CORRECTION, revision: 1, detail } };
    },
  } as unknown as OperationsClient;
  return { client, sent };
}

const approved = {
  correctionId: CORRECTION,
  state: 'approved',
  approver: 'Ben Approver',
  versionId: VERSION,
};

describe('C80 decision read on the card', () => {
  it('a waiting live card can be checked again, and the read redraws it with the approver', async () => {
    const { client, sent } = server(approved);
    const desk = liveDesk(client, () => Promise.resolve(target));
    const asked = await desk.request(ASK);
    expect(asked.kind === 'card' && asked.correction.checkable).toBe(true);
    const again = await desk.recheck?.(CORRECTION);
    expect(sent.at(-1)).toStrictEqual({
      name: 'live_correction.read',
      body: { correctionId: CORRECTION },
    });
    expect(again).toStrictEqual({
      kind: 'card',
      correctionId: CORRECTION,
      correction: {
        ...ASK,
        before: LINE,
        after: 'We work beside the teams who run your website.',
        state: 'approved',
        approver: 'Ben Approver',
        checkable: false,
      },
    });
  });

  it('a decision still waiting stays checkable, and one the read cannot find is refused', async () => {
    const waiting = server({ ...approved, state: 'requested', approver: null });
    const desk = liveDesk(waiting.client, () => Promise.resolve(target));
    await desk.request(ASK);
    const still = await desk.recheck?.(CORRECTION);
    expect(still?.kind === 'card' && still.correction).toMatchObject({
      state: 'waiting',
      checkable: true,
    });
    const gone = server('not-found');
    const other = liveDesk(gone.client, () => Promise.resolve(target));
    await other.request(ASK);
    expect((await other.recheck?.(CORRECTION))?.kind).toBe('refused');
    expect((await other.recheck?.('made-up-elsewhere'))?.kind).toBe('refused');
  });

  it('in the drawer, Check again redraws the live card approved, with no mock mark', async () => {
    const { client } = server(approved);
    const page = track(
      await mount(
        <AssistantView
          client={client}
          route="agency:settings"
          here="/settings"
          entry={null}
          onClose={() => {}}
          corrections={liveDesk(client, () => Promise.resolve(target))}
        />,
      ),
    );
    await page.type('[data-assistant="input"]', 'Change alongside to beside on the About page');
    await press(page, '[data-assistant="input"]', 'Enter');
    for (let turn = 0; turn < 4; turn += 1) {
      // eslint-disable-next-line no-await-in-loop -- one flush per awaited step of the ask
      await settle();
    }
    await page.click('[data-correction-check] button');
    await settle();
    const card = page.find('[data-correction]');
    expect(card?.getAttribute('data-correction')).toBe('approved');
    expect(page.find('[data-correction-state]')?.textContent).toBe('Approved by Ben Approver');
    expect(card?.closest('.is-mock')).toBeNull();
  });
});
