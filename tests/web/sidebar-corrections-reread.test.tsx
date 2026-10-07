// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A decision on a correction card that is not taken (VERSION_STALE,
// GATE_ALREADY_DECIDED, or no answer) reads the correction again, so the card
// draws the state and version that read answers and the next decision names
// that version (#1122 item 2).

import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SidebarCorrections } from '../../apps/web/src/views/correction-card.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import {
  ABOUT,
  V1,
  V2,
  askFor,
  card,
  controls,
  mockPropose,
  refusal,
  type View,
} from './sidebar-corrections-support.tsx';

afterEach(unmountAll);

const asRead = (state: string, versionId: string, approver: string | null = null): Response =>
  json({ ok: true, correction: { correctionId: 'mock-correction-1', state, approver, versionId } });

/**
 * Alpha's API answering from a script: each read and each decision takes the
 * next answer queued for it, the last one repeating. A decision queued as null
 * gets no answer at all.
 */
function scripted(reads: readonly Response[], decides: readonly (Response | null)[]) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const next = <T,>(queue: readonly T[], path: string): T => {
    const sent = calls.filter((call) => call.path === path).length;
    const answer = queue[Math.min(sent, queue.length) - 1];
    if (answer === undefined) throw new Error(`nothing scripted for ${path}`);
    return answer;
  };
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const path = at.slice(at.indexOf('/api/b/alpha') + '/api/b/alpha'.length);
    calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    if (path === '/live_correction/read') return Promise.resolve(next(reads, path).clone());
    if (path === '/live_correction/decide') {
      const answer = next(decides, path);
      return answer === null
        ? Promise.reject(new TypeError('network down'))
        : Promise.resolve(answer.clone());
    }
    return Promise.resolve(refusal('NOT_FOUND', 404));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const sent = (path: string) => calls.filter((call) => call.path === path);
  return { client, sent };
}

const refusalOn = (view: View): string =>
  card(view)?.querySelector('[role="alert"]')?.textContent ?? '';

describe('a stale decision reads the correction again', () => {
  it('a stale approve reads again, and the next approve sends the version read then', async () => {
    const { client, sent } = scripted(
      [asRead('requested', V1), asRead('requested', V2)],
      [refusal('VERSION_STALE', 409), json({ recordId: 'mock-correction-1', revision: 3 })],
    );
    const view = await mount(<SidebarCorrections client={client} propose={mockPropose().port} />);
    await askFor(view, ABOUT);
    await view.click('[data-correction-decide="approve"]');
    await tick();
    expect(sent('/live_correction/read')).toHaveLength(2);
    expect(card(view)?.dataset['correctionState']).toBe('requested');
    expect(refusalOn(view)).toMatch(/read again/iu);
    expect(view.text()).not.toContain('VERSION_STALE');
    await view.click('[data-correction-decide="approve"]');
    await tick();
    expect(sent('/live_correction/decide').map((call) => call.body['versionId'])).toStrictEqual([
      V1,
      V2,
    ]);
  });
});

describe('a decision taken elsewhere, or not answered, reads the correction again', () => {
  it('a decision already taken elsewhere is read, and the card stops offering approve and decline', async () => {
    const { client, sent } = scripted(
      [asRead('requested', V1), asRead('approved', V2, 'Grace Hopper')],
      [refusal('GATE_ALREADY_DECIDED', 409)],
    );
    const view = await mount(<SidebarCorrections client={client} propose={mockPropose().port} />);
    await askFor(view, ABOUT);
    expect(controls(view)).toStrictEqual(['Approve', 'Decline']);
    await view.click('[data-correction-decide="approve"]');
    await tick();
    expect(sent('/live_correction/read')).toHaveLength(2);
    expect(card(view)?.dataset['correctionState']).toBe('approved');
    expect(card(view)?.textContent).toContain('Decided by Grace Hopper.');
    expect(controls(view)).toStrictEqual([]);
    expect(refusalOn(view)).toMatch(/decided already/iu);
  });

  it('a decision with no answer is read again, and the card draws what the read answers', async () => {
    const { client, sent } = scripted(
      [asRead('requested', V1), asRead('rejected', V2, 'Grace Hopper')],
      [null],
    );
    const view = await mount(<SidebarCorrections client={client} propose={mockPropose().port} />);
    await askFor(view, ABOUT);
    await view.click('[data-correction-decide="reject"]');
    await tick();
    expect(sent('/live_correction/read')).toHaveLength(2);
    expect(card(view)?.dataset['correctionState']).toBe('declined');
    expect(controls(view)).toStrictEqual([]);
  });
});
