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

import { act, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionsScreen } from '../../apps/web/src/screens/Connections.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StepUpContext } from '../../apps/web/src/records/use-money-command.ts';
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

const REVOKE_CONFIRMED = '[data-confirm="revoke-mandate"] [data-act="revoke"] button';
const REVOKE_KEPT = '[data-confirm="revoke-mandate"] [data-act="keep"] button';

interface Opening {
  /** The refusal code, stale by default; `once` refuses only the first matching call. */
  readonly code?: string;
  readonly once?: boolean;
  /** How many matching calls are answered before the refusing starts; none by default. */
  readonly after?: number;
  /** Commands wait on this before they are answered. */
  readonly hold?: Promise<void>;
  /** A step-up the page may call, where the case needs one. */
  readonly stepUp?: (code: string) => Promise<{ ok: true; sessionId: string }>;
  /** The first matching command is stored, then its answer is lost on the way back. */
  readonly lose?: RegExp;
  /**
   * Matching commands go through the operation register as `envelope.ts`'s
   * `replay` keeps it: each operation keeps its first answer, a stored refusal
   * answers again as it is, and a stored success only to a stepped-up sign-in.
   * Until the step-up, a new operation is refused STEP_UP_REQUIRED, and stored.
   */
  readonly register?: RegExp;
}

const STEP_UP = { refused: true, code: 'STEP_UP_REQUIRED', names: [], fixes: [] };

const FLEET = {
  ok: true,
  connections: [],
  counts: { all: 0, active: 0, degraded: 0, broken: 0, clientConnections: 0 },
};

/** The stub's answer to one call; `refusing` says whether a matching command is refused. */
function answer(
  at: string,
  refusing: () => boolean,
  code: string,
  region: ConnectionGraduationResult,
): Response {
  if (at.endsWith('/connection/graduation')) return json(region);
  if (at.endsWith('/connection/fleet')) return json(FLEET);
  if (COMMAND.test(at) && refusing()) {
    return json(
      {
        refused: true,
        code,
        names: ['revision=4'],
        fixes: ['Read the region again and act on the revision it is at now.'],
      },
      409,
    );
  }
  if (COMMAND.test(at)) {
    return json({ recordId: 'm-new', revision: 1, detail: { mandateId: 'm-new' } });
  }
  return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
}

/**
 * What the stub has stored: a filing adds its mandate to the next read once
 * per operation, as the server's register does, and a revoke ends its mandate.
 */
function stubStore(): {
  readonly region: () => ConnectionGraduationResult;
  readonly keep: (at: string, body: Record<string, unknown>) => void;
} {
  const filed = new Map<string, MandateView>();
  const ended = new Set<string>();
  return {
    region: () => ({
      ...BODY,
      mandates: [...BODY.mandates, ...filed.values()].filter((one) => !ended.has(one.id)),
    }),
    keep: (at, body) => {
      const operation = String(body['operationId']);
      if (at.endsWith('/mandate/file') && !filed.has(operation)) {
        const id = filed.size === 0 ? 'm-new' : `m-new-${filed.size}`;
        filed.set(
          operation,
          mandate(id, { clientId: String(body['clientId']), label: String(body['label']) }),
        );
      }
      if (at.endsWith('/mandate/revoke')) ended.add(String(body['mandateId']));
    },
  };
}

/** The operation register `Opening.register` describes, and the step-up it watches. */
function registerStub(
  opening: Opening,
  region: () => ConnectionGraduationResult,
): {
  readonly answer: (at: string, call: string) => Promise<Response | undefined>;
  readonly stepUp: NonNullable<Opening['stepUp']> | null;
} {
  const registered = new Map<string, { readonly status: number; readonly body: unknown }>();
  const asked = opening.stepUp ?? null;
  let stepped = false;
  return {
    answer: async (at, call) => {
      if (opening.register?.test(at) !== true) return;
      const operation = String(bodyOf(call)['operationId']);
      const kept = registered.get(operation);
      // A stored success is withheld from a sign-in not stepped up; nothing new is stored.
      if (kept?.status === 200 && !stepped) return json(STEP_UP, 403);
      if (kept !== undefined) return json(kept.body, kept.status);
      if (!stepped) {
        registered.set(operation, { status: 403, body: STEP_UP });
        return json(STEP_UP, 403);
      }
      const reply = answer(at, () => false, 'VERSION_STALE', region());
      registered.set(operation, { status: reply.status, body: await reply.clone().json() });
      return reply;
    },
    stepUp:
      asked &&
      (async (code) => {
        const result = await asked(code);
        stepped = true;
        return result;
      }),
  };
}

/** Whether a call to `at` is refused: it matches, comes after `after` calls, and is the first if `once`. */
function refuser(refuse: RegExp | undefined, opening: Opening): (at: string) => boolean {
  let refused = 0;
  let matched = 0;
  return (at) =>
    refuse?.test(at) === true &&
    matched++ >= (opening.after ?? 0) &&
    (opening.once !== true || refused++ === 0);
}

/** Open the page; a command whose path matches `refuse` is refused, as stale by default. */
async function open(
  refuse?: RegExp,
  opening: Opening = {},
): Promise<{
  readonly page: Mounted;
  readonly sent: string[];
  readonly signInAgain: () => Promise<void>;
  readonly as: (businessKey: string, grantKey: string) => Promise<void>;
}> {
  const sent: string[] = [];
  const refusing = refuser(refuse, opening);
  let lost = 0;
  const stored = stubStore();
  const register = registerStub(opening, stored.region);
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const call = `${at} ${String(init?.body ?? '')}`;
    sent.push(call);
    if (COMMAND.test(at)) await opening.hold;
    const reply =
      (await register.answer(at, call)) ??
      answer(at, () => refusing(at), opening.code ?? 'VERSION_STALE', stored.region());
    if (COMMAND.test(at) && reply.ok) stored.keep(at, bodyOf(call));
    if (opening.lose?.test(at) === true && lost++ === 0) throw new TypeError('Failed to fetch');
    return reply;
  }) as typeof globalThis.fetch;
  const screen = (businessKey = 'alpha', grantKey = 'alpha:a@x:0'): ReactElement => (
    <StepUpContext.Provider value={register.stepUp}>
      <ConnectionsScreen
        client={new OperationsClient({ origin: '', businessKey, signedIn: true, fetch })}
        grantKey={grantKey}
        now={() => NOW}
      />
    </StepUpContext.Provider>
  );
  const page = await mount(screen());
  opened.push(page);
  await tick();
  // The application builds a new client for a stepped-up sign-in.
  const signInAgain = async (): Promise<void> => {
    await page.render(screen());
    await tick();
  };
  // Another business, or another person in the same one: a new client and grant.
  const as = async (businessKey: string, grantKey: string): Promise<void> => {
    await page.render(screen(businessKey, grantKey));
    await tick();
  };
  return { page, sent, signInAgain, as };
}

afterEach(async () => {
  for (const page of opened.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one page at a time
    if (page.host.isConnected) await page.unmount();
  }
});

const commands = (sent: readonly string[]): string[] =>
  sent.filter((call) => COMMAND.test(call.slice(0, call.indexOf(' '))));

function bodyOf(call: string | undefined): Record<string, unknown> {
  return JSON.parse(call?.slice(call.indexOf(' ') + 1) || '{}') as Record<string, unknown>;
}

const sentTo = (sent: readonly string[], path: string): Record<string, unknown> =>
  bodyOf(commands(sent).find((call) => call.includes(path)));

const operationsTo = (sent: readonly string[], path: string): unknown[] =>
  commands(sent)
    .filter((call) => call.includes(path))
    .map((call) => bodyOf(call)['operationId']);

const steppedUp = async () => await Promise.resolve({ ok: true as const, sessionId: 'stepped' });

/** Fill the standing approval form with the one approval the cases file. */
async function fillApproval(page: Mounted): Promise<void> {
  await page.type('[data-mandate-label]', 'Approve posts');
  await page.choose('[data-mandate-scope]', 'social.ready');
  await page.type('[data-mandate-ceiling]', '500');
  await page.type('[data-mandate-expiry]', '2026-10-31');
}

/** Enter a code in the open step-up prompt and confirm it. */
async function stepUpWith(page: Mounted, code = '123456'): Promise<void> {
  await page.type('[data-step-up="code"]', code);
  await page.click('[data-step-up="confirm"]');
  await tick();
}

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

    // The filed approval is on the card list, and the revoke ends that one.
    expect(page.find('[data-mandate="m-new"]')?.textContent).toContain(
      'Posts for B under five hundred dollars',
    );
    await page.click('[data-mandate="m-new"] [data-mandate-revoke]');
    await page.click(REVOKE_CONFIRMED);
    await tick();
    expect(sentTo(sent, '/mandate/revoke')).toMatchObject({
      mandateId: 'm-new',
      expectedRevision: 1,
    });
    expect(page.find('[data-mandate="m-new"]')).toBeNull();
    expect(page.find('[data-mandate="m-b"]')).not.toBeNull();
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
  it('revoking a standing approval waits on a confirmation that names its sentence; keeping it sends nothing', async () => {
    const { page, sent } = await open();
    await page.click('[data-mandate="m-yes"] [data-mandate-revoke]');
    await tick();
    expect(commands(sent)).toHaveLength(0);
    expect(page.find('[data-confirm="revoke-mandate"]')?.textContent).toContain('Sentence m-yes');
    await page.click(REVOKE_KEPT);
    await tick();
    expect(page.find('[data-confirm="revoke-mandate"]')).toBeNull();
    expect(commands(sent)).toHaveLength(0);
    await page.click('[data-mandate="m-yes"] [data-mandate-revoke]');
    await page.click(REVOKE_CONFIRMED);
    await tick();
    expect(commands(sent)).toHaveLength(1);
    expect(sentTo(sent, '/mandate/revoke')).toMatchObject({
      mandateId: 'm-yes',
      expectedRevision: 1,
    });
  });

  it('revoking a refusal names the classes it will stop holding before anything is sent', async () => {
    const { page, sent } = await open();
    await page.click('[data-mandate="m-no"] [data-mandate-revoke]');
    await tick();
    expect(commands(sent)).toHaveLength(0);
    const confirm = page.find('[data-confirm="revoke-mandate"]')?.textContent ?? '';
    expect(confirm).toContain('Nothing social for A');
    expect(confirm).toContain('Class held');
  });

  it('a write refused for a fresh sign-in asks for the code and sends once more when stepped up', async () => {
    const codes: string[] = [];
    const { page, sent, signInAgain } = await open(/\/graduation\/demote$/u, {
      code: 'STEP_UP_REQUIRED',
      once: true,
      stepUp: async (code) => {
        codes.push(code);
        return await Promise.resolve({ ok: true, sessionId: 'stepped' });
      },
    });
    await page.click('[data-grad="auto"] [data-auto]');
    await tick();
    expect(page.find('[data-step-up="prompt"]')).not.toBeNull();
    await page.type('[data-step-up="code"]', '123456');
    await page.click('[data-step-up="confirm"]');
    await tick();
    expect(codes).toEqual(['123456']);
    await signInAgain();
    expect(commands(sent).filter((call) => call.includes('/graduation/demote'))).toHaveLength(2);
    expect(page.find('[data-step-up="prompt"]')).toBeNull();
  });

  it('a refused filing keeps its sentence and a refused promote keeps its form open', async () => {
    const { page, sent } = await open(/\/(mandate\/file|graduation\/promote)$/u, {});
    await page.type('[data-mandate-label]', 'Kept after a refusal');
    await page.type('[data-mandate-ceiling]', '500');
    await page.type('[data-mandate-expiry]', '2026-10-31');
    await page.click('[data-mandate-add]');
    await tick();
    expect(commands(sent)).toHaveLength(1);
    expect((page.find('[data-mandate-label]') as HTMLInputElement | null)?.value).toBe(
      'Kept after a refusal',
    );
    await page.click('[data-grad="ready"] [data-auto]');
    await page.type('[data-promote-form="ready"] [data-promote-ceiling]', '25');
    await page.type('[data-promote-form="ready"] [data-promote-expiry]', '2026-10-15');
    await page.click('[data-promote-form="ready"] [data-promote-confirm]');
    await tick();
    expect(commands(sent)).toHaveLength(2);
    expect(
      (page.find('[data-promote-form="ready"] [data-promote-ceiling]') as HTMLInputElement | null)
        ?.value,
    ).toBe('25');
  });

  it('a filing that succeeds clears the sentence', async () => {
    const { page, sent } = await open();
    await page.type('[data-mandate-label]', 'Cleared once filed');
    await page.type('[data-mandate-ceiling]', '500');
    await page.type('[data-mandate-expiry]', '2026-10-31');
    await page.click('[data-mandate-add]');
    await tick();
    expect(commands(sent)).toHaveLength(1);
    expect((page.find('[data-mandate-label]') as HTMLInputElement | null)?.value).toBe('');
  });

  it('the controls that write are disabled while a write is in flight', async () => {
    const gate: { release?: () => void } = {};
    const hold = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const { page } = await open(undefined, { hold });
    await page.click('[data-grad="auto"] [data-auto]');
    await tick();
    const disabled = (selector: string): boolean | undefined =>
      page.host.querySelector<HTMLButtonElement>(selector)?.disabled;
    expect(disabled('[data-mandate-add]')).toBe(true);
    expect(disabled('[data-grad="ready"] [data-auto]')).toBe(true);
    expect(disabled('[data-mandate="m-yes"] [data-mandate-revoke]')).toBe(true);
    gate.release?.();
    await tick();
    expect(disabled('[data-mandate-add]')).toBe(false);
  });

  it('a filing whose answer is lost goes again under the same operation, so it files once', async () => {
    const { page, sent } = await open(undefined, { lose: /\/mandate\/file$/u });
    await page.type('[data-mandate-label]', 'Approve posts');
    await page.type('[data-mandate-ceiling]', '500');
    await page.type('[data-mandate-expiry]', '2026-10-31');
    await page.click('[data-mandate-add]');
    await tick();
    await page.click('[data-mandate-add]');
    await tick();
    const files = commands(sent).filter((call) => call.includes('/mandate/file'));
    expect(files).toHaveLength(2);
    expect(bodyOf(files[1])['operationId']).toBe(bodyOf(files[0])['operationId']);
  });

  it('a write held for a fresh sign-in is withdrawn when the scope bar moves to another client', async () => {
    const { page, sent, signInAgain } = await open(/\/graduation\/demote$/u, {
      code: 'STEP_UP_REQUIRED',
      once: true,
      stepUp: async () => await Promise.resolve({ ok: true, sessionId: 'stepped' }),
    });
    await page.click('[data-grad="auto"] [data-auto]');
    await tick();
    expect(page.find('[data-step-up="prompt"]')).not.toBeNull();
    await page.choose('[data-client-scope] select', 'k-b');
    await tick();
    expect(page.find('[data-step-up="prompt"]')).toBeNull();
    expect(page.find('[data-region-said]')).toBeNull();
    await signInAgain();
    expect(commands(sent).filter((call) => call.includes('/graduation/demote'))).toHaveLength(1);
  });

  it('cancelling a promotion held for a fresh sign-in withdraws it, so nothing files later', async () => {
    const { page, sent, signInAgain } = await open(/\/graduation\/promote$/u, {
      code: 'STEP_UP_REQUIRED',
      once: true,
      stepUp: async () => await Promise.resolve({ ok: true, sessionId: 'stepped' }),
    });
    await page.click('[data-grad="ready"] [data-auto]');
    await page.type('[data-promote-form="ready"] [data-promote-ceiling]', '25');
    await page.type('[data-promote-form="ready"] [data-promote-expiry]', '2026-10-15');
    await page.click('[data-promote-form="ready"] [data-promote-confirm]');
    await tick();
    expect(page.find('[data-step-up="prompt"]')).not.toBeNull();
    await page.click('[data-promote-form="ready"] [data-promote-cancel]');
    await tick();
    expect(page.find('[data-step-up="prompt"]')).toBeNull();
    await signInAgain();
    expect(commands(sent).filter((call) => call.includes('/graduation/promote'))).toHaveLength(1);
  });

  it('an open revoke confirmation cannot be pressed while another write is in flight', async () => {
    const gate: { release?: () => void } = {};
    const hold = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const { page, sent } = await open(undefined, { hold });
    await page.click('[data-mandate="m-yes"] [data-mandate-revoke]');
    await page.click('[data-grad="auto"] [data-auto]');
    await tick();
    expect(page.host.querySelector<HTMLButtonElement>(REVOKE_CONFIRMED)?.disabled).toBe(true);
    gate.release?.();
    await tick();
    await page.click(REVOKE_CONFIRMED);
    await tick();
    expect(sentTo(sent, '/mandate/revoke')).toMatchObject({ mandateId: 'm-yes' });
  });

  it('the sentence cannot be edited while its filing is in flight, so no newer draft is lost', async () => {
    const gate: { release?: () => void } = {};
    const hold = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const { page } = await open(undefined, { hold });
    await page.type('[data-mandate-label]', 'First rule');
    await page.type('[data-mandate-ceiling]', '500');
    await page.type('[data-mandate-expiry]', '2026-10-31');
    await page.click('[data-mandate-add]');
    await tick();
    const label = (): HTMLInputElement | null =>
      page.host.querySelector<HTMLInputElement>('[data-mandate-label]');
    expect(label()?.disabled).toBe(true);
    gate.release?.();
    await tick();
    expect(label()?.disabled).toBe(false);
  });

  it('a held write and its refusal do not cross to another business', async () => {
    const { page, sent, as } = await open(/\/graduation\/demote$/u, {
      code: 'STEP_UP_REQUIRED',
      once: true,
      stepUp: async () => await Promise.resolve({ ok: true, sessionId: 'stepped' }),
    });
    await page.click('[data-grad="auto"] [data-auto]');
    await tick();
    expect(page.find('[data-step-up="prompt"]')).not.toBeNull();
    await as('bravo', 'bravo:a@x:0');
    expect(page.find('[data-step-up="prompt"]')).toBeNull();
    expect(page.find('[data-region-said]')).toBeNull();
    expect(sent.some((call) => call.startsWith('/api/b/bravo/connection/graduation'))).toBe(true);
    await as('bravo', 'bravo:a@x:0');
    expect(commands(sent).filter((call) => call.includes('/graduation/demote'))).toHaveLength(1);
  });

  it('a held write and its refusal do not cross to another person in the same business', async () => {
    const { page, sent, as } = await open(/\/graduation\/demote$/u, {
      code: 'STEP_UP_REQUIRED',
      once: true,
      stepUp: async () => await Promise.resolve({ ok: true, sessionId: 'stepped' }),
    });
    await page.click('[data-grad="auto"] [data-auto]');
    await tick();
    expect(page.find('[data-step-up="prompt"]')).not.toBeNull();
    await as('alpha', 'alpha:b@x:0');
    expect(page.find('[data-step-up="prompt"]')).toBeNull();
    expect(page.find('[data-region-said]')).toBeNull();
    await as('alpha', 'alpha:b@x:0');
    expect(commands(sent).filter((call) => call.includes('/graduation/demote'))).toHaveLength(1);
  });

  it('a lost filing refused for a fresh sign-in on its retry goes again under its operation once stepped up, so it files once', async () => {
    const { page, sent, signInAgain } = await open(/\/mandate\/file$/u, {
      code: 'STEP_UP_REQUIRED',
      once: true,
      after: 1,
      lose: /\/mandate\/file$/u,
      stepUp: steppedUp,
    });
    await fillApproval(page);
    await page.click('[data-mandate-add]');
    await tick();
    await page.click('[data-mandate-add]');
    await tick();
    expect(page.find('[data-step-up="prompt"]')).not.toBeNull();
    await stepUpWith(page);
    await signInAgain();
    const operations = operationsTo(sent, '/mandate/file');
    expect(operations).toHaveLength(3);
    expect(new Set(operations).size).toBe(1);
    expect(page.find('[data-mandate="m-new"]')?.textContent).toContain('Approve posts');
    expect(page.find('[data-mandate="m-new-1"]')).toBeNull();
  });

  it('a lost filing refused for a fresh sign-in keeps its operation when pressed again', async () => {
    const { page, sent } = await open(/\/mandate\/file$/u, {
      code: 'STEP_UP_REQUIRED',
      once: true,
      after: 1,
      lose: /\/mandate\/file$/u,
      stepUp: steppedUp,
    });
    await fillApproval(page);
    await page.click('[data-mandate-add]');
    await tick();
    await page.click('[data-mandate-add]');
    await tick();
    await page.click('[data-step-up="cancel"]');
    await tick();
    await page.click('[data-mandate-add]');
    await tick();
    const operations = operationsTo(sent, '/mandate/file');
    expect(operations).toHaveLength(3);
    expect(new Set(operations).size).toBe(1);
    expect(page.find('[data-mandate="m-new-1"]')).toBeNull();
  });

  it('a fresh filing refused for a fresh sign-in goes again under a new operation once stepped up', async () => {
    const { page, sent, signInAgain } = await open(/\/mandate\/file$/u, {
      code: 'STEP_UP_REQUIRED',
      once: true,
      stepUp: steppedUp,
    });
    await fillApproval(page);
    await page.click('[data-mandate-add]');
    await tick();
    await stepUpWith(page);
    await signInAgain();
    const operations = operationsTo(sent, '/mandate/file');
    expect(operations).toHaveLength(2);
    expect(operations[1]).not.toBe(operations[0]);
    expect(page.find('[data-mandate="m-new"]')?.textContent).toContain('Approve posts');
  });

  it('cancelling an unsent promotion form keeps another write held for a fresh sign-in', async () => {
    const { page, sent, signInAgain } = await open(/\/mandate\/revoke$/u, {
      code: 'STEP_UP_REQUIRED',
      once: true,
      stepUp: steppedUp,
    });
    await page.click('[data-grad="ready"] [data-auto]');
    expect(page.find('[data-promote-form="ready"]')).not.toBeNull();
    await page.click('[data-mandate="m-yes"] [data-mandate-revoke]');
    await page.click(REVOKE_CONFIRMED);
    await tick();
    expect(page.find('[data-step-up="prompt"]')).not.toBeNull();
    await page.click('[data-promote-form="ready"] [data-promote-cancel]');
    await tick();
    expect(page.find('[data-promote-form="ready"]')).toBeNull();
    expect(page.find('[data-step-up="prompt"]')).not.toBeNull();
    expect(page.find('[data-region-said]')?.textContent).toContain('STEP_UP_REQUIRED');
    await stepUpWith(page);
    await signInAgain();
    expect(commands(sent).filter((call) => call.includes('/mandate/revoke'))).toHaveLength(2);
    expect(commands(sent).filter((call) => call.includes('/graduation/promote'))).toHaveLength(0);
    expect(page.find('[data-mandate="m-yes"]')).toBeNull();
  });

  it('a lost revoke refused for a fresh sign-in on its retry revokes under a new operation once stepped up (SC2-F1)', async () => {
    const { page, sent, signInAgain } = await open(undefined, {
      register: /\/mandate\/revoke$/u,
      lose: /\/mandate\/revoke$/u,
      stepUp: steppedUp,
    });
    await page.click('[data-mandate="m-yes"] [data-mandate-revoke]');
    await page.click(REVOKE_CONFIRMED);
    await tick();
    expect(page.find('[data-step-up="prompt"]')).toBeNull();
    await page.click('[data-mandate="m-yes"] [data-mandate-revoke]');
    await page.click(REVOKE_CONFIRMED);
    await tick();
    expect(page.find('[data-step-up="prompt"]')).not.toBeNull();
    await stepUpWith(page);
    await signInAgain();
    await tick();
    const operations = operationsTo(sent, '/mandate/revoke');
    expect(operations).toHaveLength(4);
    expect(new Set(operations.slice(0, 3)).size).toBe(1);
    expect(operations[3]).not.toBe(operations[0]);
    expect(page.find('[data-mandate="m-yes"]')).toBeNull();
    expect(page.find('[data-step-up="prompt"]')).toBeNull();
  });
});
