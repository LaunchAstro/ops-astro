// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one stub server, the cases that share it */
//
// The browser's half of the per-client region on Connections & signal: the
// client scope bar, the graduation rows and their switches, the standing
// approvals and refusals, and the made-up channels and exceptions. The server
// is a stub that answers `connection.graduation` with the case's own body,
// empty for the fleet and signal reads, and records every call, so the cases
// can prove what each control sends and what sends nothing.

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
    row('ready', 'k-a', 'ready', { note: 'Every post this month went out as drafted.' }),
    row('auto', 'k-a', 'promoted', { promotedAt: '2026-09-20T00:00:00Z', revision: 5 }),
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
    mandate('m-b', { clientId: 'k-b', label: 'Only for B', revision: 2 }),
  ],
};

const COMMAND = /\/(mandate|graduation)\/(file|revoke|promote|demote)$/u;

const opened: Mounted[] = [];

/** Open the page; a command whose path matches `refuse` is refused as stale. */
async function open(refuse?: RegExp): Promise<{ readonly page: Mounted; readonly sent: string[] }> {
  const sent: string[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    sent.push(`${at} ${String(init?.body ?? '')}`);
    if (at.endsWith('/connection/graduation')) return Promise.resolve(json(BODY));
    if (at.endsWith('/connection/fleet')) {
      return Promise.resolve(
        json({
          ok: true,
          connections: [],
          counts: { all: 0, active: 0, degraded: 0, broken: 0, clientConnections: 0 },
        }),
      );
    }
    if (refuse?.test(at) === true) {
      return Promise.resolve(
        json(
          {
            refused: true,
            code: 'VERSION_STALE',
            names: ['revision=4'],
            fixes: ['Read the region again and act on the revision it is at now.'],
          },
          409,
        ),
      );
    }
    if (COMMAND.test(at)) {
      return Promise.resolve(
        json({ recordId: 'm-new', revision: 1, detail: { mandateId: 'm-new' } }),
      );
    }
    return Promise.resolve(json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404));
  }) as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const page = await mount(
    <ConnectionsScreen client={client} grantKey="alpha:a@x:0" now={() => NOW} />,
  );
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
  sent.filter((call) => COMMAND.test(call.slice(0, call.indexOf(' '))));

const bodyOf = (call: string | undefined): Record<string, unknown> =>
  JSON.parse(call?.slice(call.indexOf(' ') + 1) ?? '{}') as Record<string, unknown>;

const sentTo = (sent: readonly string[], path: string): Record<string, unknown> =>
  bodyOf(commands(sent).find((call) => call.includes(path)));

// eslint-disable-next-line max-lines-per-function -- one stub server, the cases that share it
describe('Connections & signal: client scope bar, graduation and standing approvals', () => {
  it('owner check: choose a client, file a standing approval with a limit and expiry, then revoke it', async () => {
    const { page, sent } = await open();
    await page.choose('[data-client-scope] select', 'k-b');
    await page.type('[data-mandate-label]', 'Posts for B under five hundred dollars');
    await page.choose('[data-mandate-scope]', 'social.*');
    await page.type('[data-mandate-ceiling]', '500');
    await page.type('[data-mandate-expiry]', '2026-10-31');
    await page.click('[data-mandate-add]');
    await tick();
    const filed = sentTo(sent, '/mandate/file');
    expect(filed).toMatchObject({
      clientId: 'k-b',
      classes: ['social.*'],
      refuses: false,
      ceiling: { amountMinor: 50_000, currency: 'AUD' },
      label: 'Posts for B under five hundred dollars',
    });
    // The one form the command takes: a time that reads back as itself.
    const expiry = String(filed['expiresAt']);
    expect(new Date(expiry).toISOString()).toBe(expiry);
    expect(Date.parse(expiry)).toBeGreaterThan(NOW);

    await page.click('[data-mandate="m-b"] [data-mandate-revoke]');
    await tick();
    expect(sentTo(sent, '/mandate/revoke')).toMatchObject({
      mandateId: 'm-b',
      expectedRevision: 2,
    });
  });

  it('each row shows its state chip, its reason, the three counts and its note', async () => {
    const { page } = await open();
    const ready = page.find('[data-grad="ready"]');
    expect(ready?.querySelector('[data-grad-state]')?.textContent).toBe('Clears the bar');
    expect([...(ready?.querySelectorAll('.grad__n') ?? [])].map((n) => n.textContent)).toEqual([
      '30 approved',
      '1 edited',
      '0 rejected',
    ]);
    expect(ready?.textContent).toContain('since 2026-08-01');
    expect(ready?.querySelector('.grad__note')?.textContent).toBe(
      'Every post this month went out as drafted.',
    );
    expect(page.find('[data-grad="auto"] [data-grad-state]')?.textContent).toBe(
      'Running unattended',
    );
    expect(page.find('[data-grad="none"]')?.textContent).toContain('No decisions on record.');
    expect(page.find('[data-grad="none"] .grad__note')).toBeNull();
  });

  it('the switch moves promoted and ready only, disabled with its reason otherwise', async () => {
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
  });

  it('one select drives all three sections, and choosing a client sends nothing', async () => {
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

  it('promoting asks for its ceiling and expiry and sends the row revision; demoting sends one command', async () => {
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
    expect(sentTo(sent, '/graduation/promote')).toMatchObject({
      classId: 'ready',
      ceiling: { amountMinor: 2550, currency: 'AUD' },
      expectedRevision: 3,
    });

    await page.click('[data-grad="auto"] [data-auto]');
    await tick();
    expect(sentTo(sent, '/graduation/demote')).toMatchObject({
      classId: 'auto',
      expectedRevision: 5,
    });
  });

  it('a refused command shows its refusal, and the region is read again', async () => {
    const { page, sent } = await open(/\/graduation\/demote$/u);
    const reads = sent.filter((call) => call.includes('/connection/graduation')).length;
    await page.click('[data-grad="auto"] [data-auto]');
    await tick();
    expect(page.find('[data-section="010"] [role="alert"]')?.textContent).toContain(
      'VERSION_STALE',
    );
    expect(page.find('[data-section="010"] [role="alert"]')?.textContent).toContain(
      'Read the region again',
    );
    expect(sent.filter((call) => call.includes('/connection/graduation')).length).toBe(reads + 1);
  });

  it('a refusal is drawn as a refusal and names the classes it holds', async () => {
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

  it('nothing files until the sentence, ceiling and expiry are set; a refusal carries no ceiling', async () => {
    const { page, sent } = await open();
    await page.click('[data-mandate-add]');
    expect(commands(sent)).toHaveLength(0);
    expect(document.activeElement).toBe(page.find('[data-mandate-label]'));
    await page.type('[data-mandate-label]', 'No ceiling yet');
    await page.type('[data-mandate-expiry]', '2026-10-31');
    await page.click('[data-mandate-add]');
    expect(commands(sent)).toHaveLength(0);
    expect(document.activeElement).toBe(page.find('[data-mandate-ceiling]'));
    await page.click('[data-mandate-refuses]');
    expect((page.find('[data-mandate-ceiling]') as HTMLInputElement | null)?.disabled).toBe(true);
    await page.click('[data-mandate-add]');
    await tick();
    expect(sentTo(sent, '/mandate/file')).toMatchObject({
      refuses: true,
      ceiling: null,
      classes: ['*'],
    });
  });

  it('channels and exceptions draw made-up rows marked mock, and act on nothing', async () => {
    const { page, sent } = await open();
    const before = sent.length;
    for (const [section, rows] of [
      ['011', '.chan__row'],
      ['012', '.exc__row'],
    ] as const) {
      const mock = page.find(`[data-section="${section}"] [data-provenance="mock"]`);
      expect(mock?.querySelector('.mocktag')?.textContent).toBe('Mock');
      expect(mock?.querySelectorAll(rows).length).toBeGreaterThan(0);
      const controls = [...(mock?.querySelectorAll('button') ?? [])];
      expect(controls.length).toBeGreaterThan(0);
      expect(controls.every((one) => one.disabled)).toBe(true);
    }
    // Real data never carries the mark.
    expect(page.find('[data-section="010"] [data-provenance="mock"]')).toBeNull();
    expect(sent).toHaveLength(before);
  });
});
