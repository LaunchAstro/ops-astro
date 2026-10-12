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
import type { RollupFloor } from '../../apps/web/src/data/rollup-floor.ts';
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
    row('heldauto', 'k-a', 'held', {
      heldBy: 'm-no',
      promotedAt: '2026-09-20T00:00:00Z',
      revision: 6,
    }),
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

interface Opening {
  readonly rollup?: RollupFloor;
  /** The refusal code, stale by default; `once` refuses only the first matching call. */
  readonly code?: string;
  readonly once?: boolean;
  /** How many matching calls are answered before the refusing starts; none by default. */
  readonly after?: number;
  /** Commands wait on this before they are answered. */
  readonly hold?: Promise<void>;
  readonly resendHold?: Promise<void>;
  /** A step-up the page may call, where the case needs one. */
  readonly stepUp?: (code: string) => Promise<{ ok: true; sessionId: string }>;
  /** The first matching command is stored, then its answer is lost on the way back. */
  readonly lose?: RegExp;
  /**
   * Matching commands go through the operation register as `envelope.ts`
   * keeps it: each operation keeps its first answer, a stored refusal answers
   * again as it is, and a stored success only to a stepped-up sign-in. Until
   * the step-up, an operation is refused STEP_UP_REQUIRED, and nothing is
   * stored for it (`unheld`).
   */
  readonly register?: RegExp;
  /** The sign-in is fresh for the first registered command, and ages past the window after it. */
  readonly ages?: true;
  /**
   * Stepped-up commands a stored success is still withheld from: the new
   * factor's time ahead of the database clock past its skew, until the clock
   * catches up.
   */
  readonly ahead?: number;
  /** While `down` is true, every read of the region fails on the way. */
  readonly outage?: { down: boolean };
  readonly readRegion?: () => ConnectionGraduationResult;
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
  let stepped = opening.ages === true;
  let ahead = opening.ahead ?? 0;
  return {
    answer: async (at, call) => {
      if (opening.register?.test(at) !== true) return;
      const operation = String(bodyOf(call)['operationId']);
      const kept = registered.get(operation);
      // A stored success is withheld from a sign-in not fresh; nothing is stored.
      if (kept?.status === 200 && (!stepped || ahead-- > 0)) return json(STEP_UP, 403);
      if (kept !== undefined) return json(kept.body, kept.status);
      if (!stepped) return json(STEP_UP, 403);
      const reply = answer(at, () => false, 'VERSION_STALE', region());
      registered.set(operation, { status: reply.status, body: await reply.clone().json() });
      if (opening.ages === true && registered.size === 1) stepped = false;
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

/** Whether a read of the region at `at` fails, the case's outage being on. */
const readDown = (opening: Opening, at: string): boolean =>
  opening.outage?.down === true && at.endsWith('/connection/graduation');

/** Open the page; a command whose path matches `refuse` is refused, as stale by default. */
// eslint-disable-next-line max-lines-per-function -- the stub's every opening, in one place
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
  let commandCount = 0;
  const stored = stubStore();
  const register = registerStub(opening, stored.region);
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const call = `${at} ${String(init?.body ?? '')}`;
    sent.push(call);
    if (readDown(opening, at)) throw new TypeError('Failed to fetch');
    if (at.endsWith('/connection/graduation') && opening.readRegion !== undefined) {
      return json(opening.readRegion());
    }
    if (COMMAND.test(at)) {
      await opening.hold;
      if (++commandCount === 2) await opening.resendHold;
    }
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
        {...(opening.rollup === undefined ? {} : { rollup: opening.rollup })}
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

/** A gate the stub's commands wait on until the case releases it. */
function gated(): { readonly hold: Promise<void>; readonly release: () => void } {
  const gate: { release?: () => void } = {};
  const hold = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  return { hold, release: () => gate.release?.() };
}

// eslint-disable-next-line max-lines-per-function -- one stub server, the cases that share it
describe('Scoped fix re-check', () => {
  it('an intervening successful demotion preserves a lost filing operation', async () => {
    const { page, sent } = await open(undefined, { lose: /\/mandate\/file$/u });
    await fillApproval(page);
    await page.click('[data-mandate-add]');
    await tick();
    await page.click('[data-grad="auto"] [data-auto]');
    await tick();
    expect(sentTo(sent, '/graduation/demote')).toMatchObject({ classId: 'auto' });
    await page.click('[data-mandate-add]');
    await tick();
    const operations = operationsTo(sent, '/mandate/file');
    expect(operations).toHaveLength(2);
    expect(operations[1]).toBe(operations[0]);
    expect(page.find('[data-mandate="m-new-1"]')).toBeNull();
  });

  it('a promoted class held by a refusal remains enabled for demotion', async () => {
    const { page, sent } = await open();
    const sw = page.find('[data-grad="heldauto"] [data-auto]') as HTMLButtonElement | null;
    expect([sw?.disabled, sw?.getAttribute('aria-checked')]).toStrictEqual([false, 'true']);
    expect(page.find('[data-grad="heldauto"] .autosw__lbl')?.textContent).toBe(
      'Held by "Nothing social for A" below',
    );
    await page.click('[data-grad="heldauto"] [data-auto]');
    await tick();
    expect(page.find('[data-promote-form="heldauto"]')).toBeNull();
    expect(sentTo(sent, '/graduation/demote')).toMatchObject({
      classId: 'heldauto',
      expectedRevision: 6,
    });
  });

  it('promotion and mandate dates use the reader timezone', async () => {
    const zone = process.env['TZ'];
    try {
      process.env['TZ'] = 'America/Los_Angeles';
      const behind = await open();
      expect(behind.page.find('[data-grad="auto"] .autosw__lbl')?.textContent).toBe(
        'Auto since 2026-09-19',
      );
      await behind.page.unmount();
      process.env['TZ'] = 'Pacific/Auckland';
      const ahead = await open();
      expect(ahead.page.find('[data-mandate="m-yes"]')?.textContent).toContain('until 2026-10-30');
    } finally {
      process.env['TZ'] = zone;
    }
  });

  it('formatted ceilings submit their amount', async () => {
    const { page, sent } = await open();
    await page.click('[data-grad="ready"] [data-auto]');
    await page.type('[data-promote-form="ready"] [data-promote-ceiling]', '$50');
    await page.type('[data-promote-form="ready"] [data-promote-expiry]', '2026-10-15');
    await page.click('[data-promote-form="ready"] [data-promote-confirm]');
    await tick();
    expect(sentTo(sent, '/graduation/promote')).toMatchObject({
      ceiling: { amountMinor: 5000, currency: 'AUD' },
    });
    await page.type('[data-mandate-label]', 'Up to a thousand');
    await page.type('[data-mandate-ceiling]', '$1,000.50');
    await page.type('[data-mandate-expiry]', '2026-10-31');
    await page.click('[data-mandate-add]');
    await tick();
    expect(sentTo(sent, '/mandate/file')).toMatchObject({
      ceiling: { amountMinor: 100_050, currency: 'AUD' },
    });
  });

  it('a held class names its holding mandate label', async () => {
    const { page } = await open();
    expect(page.find('[data-grad="held"] .autosw__lbl')?.textContent).toBe(
      'Held by "Nothing social for A" below',
    );
  });
  it('falling back to another client withdraws the removed client pending write', async () => {
    let region = BODY;
    const followers = new Set<() => void>();
    const rollup: RollupFloor = {
      follow: (refresh) => {
        followers.add(refresh);
        return () => {
          followers.delete(refresh);
        };
      },
    };
    const gate = gated();
    const { page, sent, signInAgain } = await open(/\/graduation\/demote$/u, {
      code: 'STEP_UP_REQUIRED',
      once: true,
      hold: gate.hold,
      stepUp: steppedUp,
      readRegion: () => region,
      rollup,
    });
    await page.click('[data-grad="auto"] [data-auto]');
    await tick();
    expect(operationsTo(sent, '/graduation/demote')).toHaveLength(1);
    region = {
      ...BODY,
      clients: BODY.clients.filter((one) => one.id !== 'k-a'),
      rows: BODY.rows.filter((one) => one.clientId !== 'k-a'),
      mandates: BODY.mandates.filter((one) => one.clientId !== 'k-a'),
    };
    await act(() => {
      for (const refresh of followers) refresh();
    });
    await tick();
    expect(page.find('[data-section="010"] [data-scope-client]')?.textContent).toBe('Client B');
    gate.release();
    await tick();
    if (page.find('[data-step-up="prompt"]') !== null) {
      await stepUpWith(page);
      await signInAgain();
    }
    expect(
      operationsTo(sent, '/graduation/demote'),
      'Client A must not resend after the scope fell back to B',
    ).toHaveLength(1);
    expect(page.find('[data-step-up="prompt"]')).toBeNull();
    expect(page.find('[data-region-said]')).toBeNull();
  });

  it('choosing another client clears a settled refusal', async () => {
    const { page } = await open(/\/graduation\/demote$/u);
    await page.click('[data-grad="auto"] [data-auto]');
    await tick();
    expect(page.find('[data-region-said]')?.textContent).toContain('VERSION_STALE');
    await page.choose('[data-client-scope] select', 'k-b');
    expect(page.find('[data-region-said]')).toBeNull();
  });

  it('a mandate expiry uses the reader timezone', async () => {
    const zone = process.env['TZ'];
    try {
      process.env['TZ'] = 'Pacific/Auckland';
      const { page } = await open();
      expect(page.find('[data-mandate="m-yes"]')?.textContent).toContain('until 2026-10-30');
    } finally {
      if (zone === undefined) delete process.env['TZ'];
      else process.env['TZ'] = zone;
    }
  });

  it('a ceiling typed with thousands commas files its amount', async () => {
    const { page, sent } = await open();
    await page.type('[data-mandate-label]', 'Up to a thousand');
    await page.type('[data-mandate-ceiling]', '1,000');
    await page.type('[data-mandate-expiry]', '2026-10-31');
    await page.click('[data-mandate-add]');
    await tick();
    expect(sentTo(sent, '/mandate/file')).toMatchObject({
      ceiling: { amountMinor: 100_000, currency: 'AUD' },
    });
  });
});
