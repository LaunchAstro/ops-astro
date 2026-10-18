// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The card offers Approve only on a correction waiting for a decision whose
// read names a version and a check that still holds (#1693). While the page
// is being found, once it could not be found, or once it was overtaken, the
// card says so in plain words and offers no Approve. The door's port sends
// the task, the page and the two words, and nothing else: the server finds
// the page and the site runner reads the file, so the browser never sees it.

import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { taskCorrectionPort } from '../../apps/web/src/assistant/locate.ts';
import { SidebarCorrections } from '../../apps/web/src/views/correction-card.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { ABOUT, V1, askFor, card, mockPropose, refusal } from './sidebar-corrections-support.tsx';

afterEach(unmountAll);

const TASK = '22222222-2222-4222-8222-222222222222';

interface Read {
  readonly state: string;
  readonly versionId?: string | null;
  readonly verifiedForMs?: number;
  readonly refusal?: string | null;
}

/** Alpha's API: every read answers `read`; a request answers `request`. Every call is kept. */
function alpha(read: Read, request: () => Promise<Response> = () => Promise.reject(new Error())) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const path = at.slice(at.indexOf('/api/b/alpha') + '/api/b/alpha'.length);
    calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    if (path === '/live_correction/request') return request();
    const versionId = read.versionId ?? null;
    const verifiedForMs = read.verifiedForMs ?? 0;
    return Promise.resolve(
      json({
        ok: true,
        correction: {
          correctionId: 'mock-correction-1',
          state: read.state,
          approver: null,
          versionId,
          verifiedAt: verifiedForMs > 0 ? '2026-10-19T00:00:00.000Z' : null,
          verifiedForMs,
          refusal: read.refusal ?? null,
        },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, calls };
}

async function drawn(read: Read) {
  const view = await mount(
    <SidebarCorrections client={alpha(read).client} propose={mockPropose().port} />,
  );
  await askFor(view, ABOUT);
  return view;
}

const approvable = (view: Awaited<ReturnType<typeof drawn>>): boolean =>
  view.find('[data-correction-decide="approve"]') !== null;

describe('no Approve without a known, checked version', () => {
  const cases: readonly (readonly [string, Read])[] = [
    ['locating', { state: 'locating' }],
    ['unlocated', { state: 'unlocated', refusal: 'WORD_NOT_FOUND' }],
    ['superseded', { state: 'superseded', versionId: V1, refusal: 'CONTENT_DRIFTED' }],
    ['requested with no version', { state: 'requested', verifiedForMs: 60_000 }],
    ['requested with a check good for 0 ms', { state: 'requested', versionId: V1 }],
  ];
  it.each(cases)('%s offers no Approve', async (_name, read) => {
    const view = await drawn(read);
    expect(card(view)).not.toBeNull();
    expect(approvable(view)).toBe(false);
  });

  it('requested with a version and a check that holds offers Approve', async () => {
    const view = await drawn({ state: 'requested', versionId: V1, verifiedForMs: 60_000 });
    expect(approvable(view)).toBe(true);
  });
});

describe('the card says the locate states in plain words', () => {
  const said = async (read: Read): Promise<string> =>
    (await drawn(read)).find('[data-correction-words]')?.textContent ?? '';

  it('locating says it is finding the page', async () => {
    expect(await said({ state: 'locating' })).toMatch(/finding the page/iu);
  });

  it('superseded says the page changed before it was published', async () => {
    expect(await said({ state: 'superseded', refusal: 'CONTENT_DRIFTED' })).toBe(
      'The page changed before it was published. Ask again.',
    );
  });

  const unlocated: readonly (readonly [string, RegExp])[] = [
    ['NOT_FOUND', /not one you can reach/iu],
    ['WORD_NOT_FOUND', /word is not on that page/iu],
    ['CHANGE_ENVELOPE_EXCEEDED', /one word for one word/iu],
    ['SITE_UNREACHABLE', /site did not answer/iu],
    ['SITE_CHANGED', /site changed/iu],
    ['SITE_NOT_CONFIGURED', /no site is set up/iu],
    ['PROVIDER_RESPONSE_MALFORMED', /could not be read/iu],
    ['SOMETHING_NEW_FROM_THE_RUNNER', /nothing was sent/iu],
  ];
  it.each(unlocated)('unlocated with %s is said in one plain sentence', async (code, words) => {
    const view = await drawn({ state: 'unlocated', refusal: code });
    const line = view.find('[data-correction-words]')?.textContent ?? '';
    expect(line).toMatch(words);
    expect(view.text()).not.toContain(code);
    expect(card(view)?.dataset['correctionState']).toBe('unlocated');
  });

  it('a state the table does not name is unknown', async () => {
    const view = await drawn({ state: 'relocating-somewhere', versionId: V1 });
    expect(card(view)?.dataset['correctionState']).toBe('unknown');
  });
});

/** The request's answer: correction c-1, asked for. */
const answered = (): Promise<Response> =>
  Promise.resolve(
    json({ recordId: 'c-1', revision: 1, detail: { correctionId: 'c-1', state: 'locating' } }),
  );

describe('the door’s port sends the task, the page and the two words, and nothing else', () => {
  it('sends exactly the four operands, and answers the correction it was given', async () => {
    const { client, calls } = alpha({ state: 'locating' }, answered);
    const answer = await taskCorrectionPort(client, TASK)(ABOUT);
    expect(answer).toStrictEqual({ ok: true, correctionId: 'c-1' });
    const sent = calls.filter((call) => call.path === '/live_correction/request');
    expect(sent).toHaveLength(1);
    const { operationId: _id, ...operands } = sent[0]?.body ?? {};
    expect(operands).toStrictEqual({
      taskId: TASK,
      page: 'About',
      word: 'alongside',
      replacement: 'beside',
    });
  });

  it('answers a refusal by its code, NOT_FOUND included', async () => {
    for (const [code, status] of [
      ['NOT_FOUND', 404],
      ['SCOPE_NOT_GRANTED', 403],
      ['CHANGE_ENVELOPE_EXCEEDED', 422],
    ] as const) {
      const { client } = alpha({ state: 'locating' }, () => Promise.resolve(refusal(code, status)));
      // oxlint-disable-next-line no-await-in-loop
      expect(await taskCorrectionPort(client, TASK)(ABOUT)).toStrictEqual({ ok: false, code });
    }
  });

  it('answers a call that got no answer as UNAVAILABLE', async () => {
    const { client } = alpha({ state: 'locating' });
    expect(await taskCorrectionPort(client, TASK)(ABOUT)).toStrictEqual({
      ok: false,
      code: 'UNAVAILABLE',
    });
  });
});
