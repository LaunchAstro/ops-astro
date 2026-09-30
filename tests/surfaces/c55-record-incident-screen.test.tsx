// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C55's one write on the operations view: the holder of `privacy:manage`
// records a privacy incident (`privacy.record_incident`, the tracked action
// `privacy incident recorded`) from a form below the incidents card, through
// the real App and client against a stand-in API. The command's own checks,
// its grant and its audit are pinned on the real server
// (`tests/operations/c55-operations-view.test.ts`); what this screen owes is
// to send the five fields as typed, read the view again after it worked, and
// draw a refusal as the server's, sending nothing more.

import { afterEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { INFORMATION_KINDS } from '../../packages/core-records/src/index.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const SESSION = { token: 'the-live-token', businessKey: 'alpha', email: 'ada@alpha.local' };
const READ_URL = '/api/b/alpha/operations/read';
const RECORD_URL = '/api/b/alpha/privacy/record_incident';

const FILLED = {
  whatHappened: 'A made-up export went to the wrong inbox',
  foundAt: '2026-09-30T09:00:00.000Z',
  foundBy: 'Ada Alpha',
  affected: 'Two made-up contacts of Acme Dental',
};

const RECORDED = {
  id: '5b0a4c1e-0000-4000-8000-000000000002',
  ...FILLED,
  informationKinds: ['contact', 'health'],
  assessBy: '2026-10-30T09:00:00.000Z',
  overdue: false,
  status: 'open',
  recordedAt: '2026-09-30T09:05:00.000Z',
  recordedByActorId: '5b0a4c1e-0000-4000-8000-00000000000d',
};

const view = (privacyIncidents: readonly unknown[]) => ({
  ok: true,
  unattended: [],
  privacyIncidents,
  breachRunbook: null,
  serviceHealth: { checkedAt: '2026-09-30T08:00:00.000Z', sources: [], services: [] },
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** A stand-in API: `reads` answer `operations.read` in turn (the last repeats), `write` the rest. */
function server(reads: readonly Response[], write: () => Response) {
  const calls: Call[] = [];
  let read = 0;
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url: at, body });
    if (at !== READ_URL) return Promise.resolve(write());
    const answer = reads[Math.min(read, reads.length - 1)];
    read += 1;
    return Promise.resolve(answer?.clone() ?? json({}, 500));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, urls: () => calls.map((call) => call.url) };
}

const live: Mounted[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((each) => each.unmount()));
});

async function open(fetch: typeof globalThis.fetch): Promise<Mounted> {
  const held = new Map([['ops-astro.session', JSON.stringify(SESSION)]]);
  const sessions = new SessionStore({
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  });
  const element: ReactElement = (
    <App
      path="/settings/operations/"
      navigate={() => {
        // One address for the whole case.
      }}
      sessions={sessions}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      storage={window.sessionStorage}
    />
  );
  const mounted = await mount(element);
  live.push(mounted);
  await settle();
  await settle();
  return mounted;
}

const FORM = '[data-section="record-incident"]';

/** Fill the five fields the way a person does, then send. */
async function fillAndSend(page: Mounted, kinds: readonly string[]): Promise<void> {
  await page.type(`${FORM} [data-field="whatHappened"] textarea`, FILLED.whatHappened);
  await page.type(`${FORM} [data-field="foundAt"] input`, FILLED.foundAt);
  await page.type(`${FORM} [data-field="foundBy"] input`, FILLED.foundBy);
  await page.type(`${FORM} [data-field="affected"] textarea`, FILLED.affected);
  // One click after another, as a person makes them.
  await kinds.reduce(
    (prior, kind) =>
      prior.then(() => page.click(`${FORM} [data-kind="${kind}"] [role="checkbox"]`)),
    Promise.resolve(),
  );
  await page.click(`${FORM} button[type="submit"]`);
  await settle();
  await settle();
}

const refused = (
  code: string,
  names: readonly string[],
  fixes: readonly string[],
  status: number,
) => json({ refused: true, code, names, fixes }, status);

describe('C55 records from the view', () => {
  it('C55 records from the view: the owner fills the form, one privacy.record_incident is sent with the fields, and the view reads again', async () => {
    const api = server([json(view([])), json(view([RECORDED]))], () =>
      json({ recordId: RECORDED.id, revision: 1, detail: { incidentId: RECORDED.id } }),
    );
    const page = await open(api.fetch);
    // Every kind the record allows is offered, in the record's order, and no other.
    const offered = page
      .all(`${FORM} [data-kind]`)
      .map((each) => (each as HTMLElement).dataset['kind']);
    expect(offered).toEqual([...INFORMATION_KINDS]);

    await fillAndSend(page, ['health', 'contact']);
    expect(api.urls()).toEqual([READ_URL, RECORD_URL, READ_URL]);
    expect(api.calls[1]?.body).toEqual({
      ...FILLED,
      informationKinds: ['contact', 'health'],
      operationId: expect.any(String) as unknown,
    });
    const row = page.find(`[data-incident="${RECORDED.id}"]`)?.closest('tr');
    expect(row?.textContent).toContain(FILLED.whatHappened);
  });
});

describe('C55 records from the view: refusals', () => {
  it('C55 records from the view: a refused field is shown by name and nothing else is sent', async () => {
    const fix = 'Send when it was found as an ISO 8601 time, not in the future.';
    const api = server([json(view([]))], () =>
      refused('FIELD_VALUE_INVALID', ['foundAt'], [fix], 422),
    );
    const page = await open(api.fetch);
    await fillAndSend(page, ['contact']);
    expect(api.urls()).toEqual([READ_URL, RECORD_URL]);
    expect(page.find(`${FORM} [data-field="foundAt"] .field__error`)?.textContent).toBe(fix);
    expect(page.find(`${FORM} [data-field="whatHappened"] .field__error`)).toBeNull();
    expect(page.find(`${FORM} [data-record-outcome]`)?.textContent).toContain(
      'FIELD_VALUE_INVALID (foundAt).',
    );
    // What was typed stays, for the person to put right.
    const whatHappened = page.find(`${FORM} [data-field="whatHappened"] textarea`);
    expect((whatHappened as HTMLTextAreaElement | null)?.value).toBe(FILLED.whatHappened);
  });

  it('C55 refusal privacy:manage on the view: a holder of operations:read alone is told they may not record, and the view stays', async () => {
    const api = server([json(view([]))], () => refused('SCOPE_NOT_GRANTED', [], [], 403));
    const page = await open(api.fetch);
    await fillAndSend(page, ['contact']);
    expect(api.urls()).toEqual([READ_URL, RECORD_URL]);
    const outcome = page.find(`${FORM} [data-record-outcome]`)?.textContent ?? '';
    expect(outcome).toContain('You may not record privacy incidents');
    expect(outcome).toContain('SCOPE_NOT_GRANTED');
    // The view is still drawn from its read; the refusal changed nothing on it.
    expect(page.find('[data-outcome="denied"]')).toBeNull();
    expect(page.find('[data-section="incidents"]')?.textContent).toContain('No privacy incident');
    const foundBy = page.find(`${FORM} [data-field="foundBy"] input`);
    expect((foundBy as HTMLInputElement | null)?.value).toBe(FILLED.foundBy);
  });
});
