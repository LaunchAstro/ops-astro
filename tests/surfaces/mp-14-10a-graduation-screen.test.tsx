// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one ticket's browser cases, named after its checklist lines */
//
// MP-14-10a, the browser's half of the per-client region on Connections &
// signal: the client scope bar, the graduation switches and the standing
// mandates. The server is a stub that answers `connection.graduation` with
// the case's own body, empty for the fleet and signal reads, and records every
// call, so the cases can prove what each control sends and what sends nothing.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionsScreen } from '../../apps/web/src/screens/Connections.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type {
  ConnectionGraduationResult,
  GraduationRowView,
  MandateView,
} from '../../packages/core-wire/src/index.ts';
import { mount, type Mounted } from './mount.tsx';

const NOW = Date.parse('2026-09-29T12:00:00Z');

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- let the answers land in turn
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

function row(
  id: string,
  clientId: string,
  state: GraduationRowView['state'],
  extra: Partial<GraduationRowView> = {},
): GraduationRowView {
  return {
    id,
    clientId,
    actionClass: `social.${id}`,
    classLabel: `Class ${id}`,
    clearance: 'Draft',
    state,
    heldBy: null,
    neverWhy: null,
    promotedAt: null,
    approved: 30,
    edited: 1,
    rejected: 0,
    since: '2026-08-01',
    note: '',
    revision: 3,
    ...extra,
  };
}

function mandate(id: string, extra: Partial<MandateView> = {}): MandateView {
  return {
    id,
    clientId: 'k-a',
    classes: ['social.*'],
    refuses: false,
    ceiling: { amountMinor: 50_000, currency: 'AUD' },
    expiresAt: '2026-10-29T12:00:00Z',
    expired: false,
    label: `Sentence ${id}`,
    graduationClass: null,
    authoredBy: 'actor-1',
    createdAt: '2026-09-28T12:00:00Z',
    revision: 1,
    ...extra,
  };
}

const BODY: ConnectionGraduationResult = {
  ok: true,
  clients: [
    { id: 'k-a', label: 'Client A', scopes: ['*', 'social.*', 'social.ready', 'social.auto'] },
    { id: 'k-b', label: 'Client B', scopes: ['*', 'social.*', 'social.bready'] },
  ],
  rows: [
    row('ready', 'k-a', 'ready'),
    row('auto', 'k-a', 'promoted', { promotedAt: '2026-09-20T00:00:00Z' }),
    row('held', 'k-a', 'held', { heldBy: 'm-no' }),
    row('short', 'k-a', 'short', { approved: 12 }),
    row('mixed', 'k-a', 'mixed', { rejected: 4 }),
    row('ceiling', 'k-a', 'never', { neverWhy: 'ceiling' }),
    row('audience', 'k-a', 'never', { neverWhy: 'audience' }),
    row('none', 'k-a', 'none', { approved: 0, since: null }),
    row('bready', 'k-b', 'ready'),
  ],
  mandates: [
    mandate('m-yes'),
    mandate('m-no', { refuses: true, ceiling: null, label: 'Nothing social for A' }),
    mandate('m-b', { clientId: 'k-b', label: 'Only for B' }),
  ],
};

const opened: Mounted[] = [];

async function open(
  body: ConnectionGraduationResult = BODY,
): Promise<{ readonly page: Mounted; readonly sent: string[] }> {
  const sent: string[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    sent.push(`${at} ${String(init?.body ?? '')}`);
    if (at.endsWith('/connection/graduation')) return Promise.resolve(json(body));
    if (at.endsWith('/connection/fleet')) {
      return Promise.resolve(
        json({
          ok: true,
          connections: [],
          counts: { all: 0, active: 0, degraded: 0, broken: 0, clientConnections: 0 },
        }),
      );
    }
    if (/\/(mandate|graduation)\/(file|revoke|promote|demote)$/u.test(at)) {
      return Promise.resolve(
        json({ recordId: 'm-new', revision: 1, detail: { mandateId: 'm-new' } }),
      );
    }
    return Promise.resolve(json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404));
  }) as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const page = await mount(<ConnectionsScreen client={client} now={() => NOW} />);
  opened.push(page);
  await tick();
  return { page, sent };
}

afterEach(async () => {
  for (const page of opened.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one page at a time
    if (page.host.isConnected) await page.unmount();
  }
});

const commands = (sent: readonly string[]): string[] =>
  sent.filter((call) => /\/(mandate|graduation)\/(file|revoke|promote|demote) /u.test(call));

const bodyOf = (call: string | undefined): Record<string, unknown> =>
  JSON.parse(call?.slice(call.indexOf(' ') + 1) ?? '{}') as Record<string, unknown>;

// eslint-disable-next-line max-lines-per-function -- one stub server, the cases that share it
describe('MP-14-10a Connections & signal: client scope bar, graduation and standing mandates', () => {
  it('MP-14-10a owner check: choose a client, file a standing approval with a limit and expiry, then revoke it', async () => {
    const { page, sent } = await open();
    await page.choose('[data-client-scope] select', 'k-b');
    await page.type('[data-mandate-label]', 'Posts for B under five hundred dollars');
    await page.choose('[data-mandate-scope]', 'social.*');
    await page.type('[data-mandate-ceiling]', '500');
    await page.type('[data-mandate-expiry]', '2026-10-31');
    await page.click('[data-mandate-add]');
    await tick();
    const filed = bodyOf(commands(sent).find((call) => call.includes('/mandate/file')));
    expect(filed).toMatchObject({
      clientId: 'k-b',
      classes: ['social.*'],
      refuses: false,
      ceiling: { amountMinor: 50_000, currency: 'AUD' },
      label: 'Posts for B under five hundred dollars',
    });
    expect(Date.parse(String(filed['expiresAt']))).toBeGreaterThan(NOW);

    await page.click('[data-mandate="m-b"] [data-mandate-revoke]');
    await tick();
    const revoked = bodyOf(commands(sent).find((call) => call.includes('/mandate/revoke')));
    expect(revoked).toMatchObject({ mandateId: 'm-b', expectedRevision: 1 });
  });

  it('MP-14-10a one select drives all three sections, and choosing a client sends nothing', async () => {
    const { page, sent } = await open();
    expect(page.find('[data-grad="ready"]')).not.toBeNull();
    expect(page.find('[data-grad="bready"]')).toBeNull();
    expect(page.find('[data-mandate="m-b"]')).toBeNull();
    for (const section of ['010', '011', '012']) {
      expect(page.find(`[data-section="${section}"] [data-scope-client]`)?.textContent).toBe(
        'Client A',
      );
    }
    const calls = sent.length;
    await page.choose('[data-client-scope] select', 'k-b');
    await tick();
    expect(sent.length).toBe(calls);
    expect(page.find('[data-grad="bready"]')).not.toBeNull();
    expect(page.find('[data-grad="ready"]')).toBeNull();
    expect(page.find('[data-mandate="m-b"]')).not.toBeNull();
    expect(page.find('[data-mandate="m-yes"]')).toBeNull();
    for (const section of ['010', '011', '012']) {
      expect(page.find(`[data-section="${section}"] [data-scope-client]`)?.textContent).toBe(
        'Client B',
      );
    }
    expect(page.find('[data-client-scope]')?.textContent).toContain('describes one client');
  });

  it('MP-14-10a the switch moves promoted and ready only when live, disabled with its reason otherwise', async () => {
    const { page, sent } = await open();
    const sw = (id: string): HTMLButtonElement | null =>
      page.find(`[data-grad="${id}"] [data-auto]`) as HTMLButtonElement | null;
    expect([sw('ready')?.disabled, sw('ready')?.getAttribute('aria-checked')]).toStrictEqual([
      false,
      'false',
    ]);
    expect([sw('auto')?.disabled, sw('auto')?.getAttribute('aria-checked')]).toStrictEqual([
      false,
      'true',
    ]);
    const reasons: Record<string, string> = {
      held: 'Held by m-no below',
      short: '12 approved so far',
      mixed: '4 rejected',
      ceiling: 'Ceiling: Draft',
      audience: 'The client reads it',
      none: 'Never proposed here',
    };
    for (const [id, why] of Object.entries(reasons)) {
      expect(sw(id)?.disabled, id).toBe(true);
      expect(page.find(`[data-grad="${id}"] [data-grad-why]`)?.textContent).toBe(why);
    }
    const calls = sent.length;
    await page.click('[data-grad="short"] [data-auto]');
    await tick();
    expect(sent.length).toBe(calls);
    expect(page.find('[data-grad="auto"]')?.textContent).toContain('Running unattended');
  });

  it('MP-14-10a promoting asks for its ceiling and expiry and writes the mandate; demoting revokes it', async () => {
    const { page, sent } = await open();
    await page.click('[data-grad="ready"] [data-auto]');
    expect(commands(sent)).toHaveLength(0);
    expect(page.find('[data-promote-form="ready"]')).not.toBeNull();
    await page.click('[data-promote-form="ready"] [data-promote-confirm]');
    await tick();
    expect(commands(sent)).toHaveLength(0);
    await page.type('[data-promote-form="ready"] [data-promote-ceiling]', '25.50');
    await page.type('[data-promote-form="ready"] [data-promote-expiry]', '2026-10-15');
    await page.click('[data-promote-form="ready"] [data-promote-confirm]');
    await tick();
    const promoted = bodyOf(commands(sent).find((call) => call.includes('/graduation/promote')));
    expect(promoted).toMatchObject({
      classId: 'ready',
      ceiling: { amountMinor: 2550, currency: 'AUD' },
      expectedRevision: 3,
    });

    await page.click('[data-grad="auto"] [data-auto]');
    await tick();
    const demoted = bodyOf(commands(sent).find((call) => call.includes('/graduation/demote')));
    expect(demoted).toMatchObject({ classId: 'auto', expectedRevision: 3 });
  });

  it('MP-14-10a a refusal is drawn as a refusal and names the classes it holds', async () => {
    const { page } = await open();
    const refusal = page.find('[data-mandate="m-no"]');
    expect(refusal?.classList.contains('ps--no')).toBe(true);
    expect(refusal?.textContent).toContain('refusal');
    expect(refusal?.textContent).toContain('social.*');
    const approval = page.find('[data-mandate="m-yes"]');
    expect(approval?.classList.contains('ps--no')).toBe(false);
    expect(approval?.textContent).toContain('$500.00');
    expect(page.find('[data-grad="held"]')?.textContent).toContain('Held by a sentence');
  });

  it('MP-14-10a nothing files until the classes, client, ceiling and expiry are set', async () => {
    const { page, sent } = await open();
    await page.click('[data-mandate-add]');
    expect(commands(sent)).toHaveLength(0);
    expect(document.activeElement).toBe(page.find('[data-mandate-label]'));
    await page.type('[data-mandate-label]', 'No ceiling yet');
    await page.type('[data-mandate-expiry]', '2026-10-31');
    await page.click('[data-mandate-add]');
    expect(commands(sent)).toHaveLength(0);
    expect(document.activeElement).toBe(page.find('[data-mandate-ceiling]'));
    // A refusal carries no ceiling: ticking it takes the ceiling away.
    await page.click('[data-mandate-refuses]');
    expect((page.find('[data-mandate-ceiling]') as HTMLInputElement | null)?.disabled).toBe(true);
    await page.click('[data-mandate-add]');
    await tick();
    const filed = bodyOf(commands(sent).find((call) => call.includes('/mandate/file')));
    expect(filed).toMatchObject({ refuses: true, ceiling: null, classes: ['*'] });
  });
});
