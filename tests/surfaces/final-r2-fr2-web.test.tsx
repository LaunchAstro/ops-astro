// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, lane FR2-WEB: the task page's forms keep one attempt
// per intention, a refused decision is drawn where the person sees it, and the
// settings dock tab does what it says.
//
// - R2-SURFACE-10: a propose or comment whose answer was lost is retried under
//   the same `operationId`, so the server's register replays it rather than
//   storing a second lineage or a second comment. A changed form is a new one.
// - R2-THERMO-12 / R1-SURFACE-34: a decision refused because the gate was
//   superseded is still quoted after the reread, under the lineage it was
//   about and under no other.
// - R2-SURFACE-42: on /settings the dock tab announced as "Close Settings"
//   closes it.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from './mount.tsx';

const TASK_ID = '66666666-6666-4666-8666-666666666666';

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const refusal = (code: string, status: number): Response =>
  json({ refused: true, code, names: [`${code} here`], fixes: ['Read the task again.'] }, status);

/** How the server answers one write: stored, or an answer that never arrived. */
type Reply = 'ok' | 'lost' | 'dropped';

interface VersionSpec {
  readonly id: string;
  readonly version: number;
  readonly gateId: string;
  readonly gateState?: string;
  readonly superseded?: boolean;
}

interface LineageSpec {
  readonly id: string;
  readonly versions: readonly VersionSpec[];
}

function lineageOf(spec: LineageSpec) {
  return {
    lineageId: spec.id,
    state: 'live',
    versions: spec.versions.map((version) => ({
      versionId: version.id,
      version: version.version,
      purpose: 'client_renewal_quote',
      maximumMinor: 10_000,
      currency: 'AUD',
      payloadDigest: `digest-${version.id}`,
      payload: { step: 'draft the quote' },
      supersededAt: version.superseded === true ? '2026-09-24T00:00:00.000Z' : null,
      runId: null,
      evidence: null,
      gate: {
        id: version.gateId,
        state: version.gateState ?? 'pending',
        round: 1,
        expiresAt: '2099-01-01T00:00:00.000Z',
        expired: false,
        payloadDigest: `digest-${version.id}`,
      },
    })),
    decisions: [],
    reservations: [],
  };
}

interface ServerOptions {
  readonly lineages?: readonly LineageSpec[];
  /** Answers to `task.propose`, in order; the last repeats. */
  readonly propose?: readonly Reply[];
  /** Answers to `task.comment`, in order; the last repeats. */
  readonly comment?: readonly Reply[];
  /** What `task.decide` refuses with, and the lineages the reread returns after it. */
  readonly decide?: { readonly code: string; readonly after: readonly LineageSpec[] };
}

/** The scripted answer for the `index`th call; the last one repeats. */
const answer = (replies: readonly Reply[] | undefined, index: number): Reply =>
  replies === undefined ? 'ok' : (replies[Math.min(index, replies.length - 1)] ?? 'ok');

function server(options: ServerOptions = {}) {
  const task = {
    id: TASK_ID,
    key: 'TSK-61',
    title: 'A task whose answers go missing',
    description: null,
    state: { id: 's1', key: 'todo', label: 'To do', machineCategory: 'unstarted' },
    assignee: null,
    due: null,
    priority: null,
    completedAt: null,
    revision: 3,
    history: [],
    comments: [],
    proposals: (options.lineages ?? []).map(lineageOf),
  };
  const sent: Record<string, Record<string, unknown>[]> = {};
  let minted = 0;

  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const operation = at.slice(at.lastIndexOf('/', at.lastIndexOf('/') - 1) + 1);
    (sent[operation] ??= []).push(body);
    const index = (sent[operation]?.length ?? 1) - 1;
    if (operation === 'person/list') return json({ ok: true, persons: [] });
    if (operation === 'task/read') return json({ ok: true, task });
    if (operation === 'task/propose' || operation === 'task/comment') {
      const reply = answer(operation === 'task/propose' ? options.propose : options.comment, index);
      // The commit happened, or did not; either way the answer is lost.
      if (reply === 'lost') return new Response('bad gateway', { status: 502 });
      if (reply === 'dropped') throw new TypeError('Failed to fetch');
      return json({ recordId: TASK_ID, revision: task.revision });
    }
    if (operation === 'task/decide') {
      if (options.decide !== undefined) {
        // Another actor moved the lineage on before this press arrived.
        task.proposals = options.decide.after.map(lineageOf);
        return refusal(options.decide.code, 409);
      }
      return json({ recordId: TASK_ID, revision: task.revision });
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;

  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    token: 'a-token',
    fetch,
    newOperationId: () => {
      minted += 1;
      return `operation-${String(minted)}`;
    },
  });

  const idsOf = (operation: string): readonly unknown[] =>
    (sent[operation] ?? []).map((body) => body['operationId']);
  return { client, idsOf };
}

// A failed assertion skips the test's own unmount, and a page left behind
// breaks the next test's typing, so every page is unmounted here as well.
const live: Mounted[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((page) => page.unmount()));
});

async function open(client: OperationsClient): Promise<Mounted> {
  const page = await mount(
    <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-61" />,
  );
  live.push(page);
  await tick();
  return page;
}

async function typeComment(page: Mounted, value: string): Promise<void> {
  const field = page.find('#comment-body') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(page: Mounted, selector: string): Promise<void> {
  await page.click(selector);
  await tick();
}

describe('R2-SURFACE-10: a lost answer is retried as the same attempt', () => {
  it('propose: an unchanged form resends its operationId, and a changed one mints another', async () => {
    const { client, idsOf } = server({ propose: ['lost', 'lost', 'ok'] });
    const page = await open(client);

    await page.type('#propose-purpose', 'client_renewal_quote');
    await page.type('#propose-maximum', '500');
    await press(page, '[data-propose="submit"]');
    expect(page.find('[data-propose="refusal"]')?.textContent).toContain('502');

    await press(page, '[data-propose="submit"]');
    const [first, second] = idsOf('task/propose');
    expect(second).toBe(first);
    expect(page.find('[data-propose="unresolved"]')).not.toBeNull();

    await page.type('#propose-purpose', 'client_budget');
    await press(page, '[data-propose="submit"]');
    const third = idsOf('task/propose')[2];
    expect(third).not.toBe(first);
  });

  it('propose: a known outcome ends the attempt, so the next proposal is a new one', async () => {
    const { client, idsOf } = server({ propose: ['lost', 'ok', 'ok'] });
    const page = await open(client);

    await page.type('#propose-purpose', 'client_renewal_quote');
    await page.type('#propose-maximum', '500');
    await press(page, '[data-propose="submit"]');
    await press(page, '[data-propose="submit"]');
    await page.type('#propose-purpose', 'client_renewal_quote');
    await page.type('#propose-maximum', '500');
    await press(page, '[data-propose="submit"]');

    const [first, second, third] = idsOf('task/propose');
    expect(second).toBe(first);
    expect(third).not.toBe(first);
  });

  for (const reply of ['lost', 'dropped'] as const) {
    it(`comment (${reply}): an unchanged box resends its operationId, and an edited one mints another`, async () => {
      const { client, idsOf } = server({ comment: [reply, reply, 'ok'] });
      const page = await open(client);

      await typeComment(page, 'Sent to the client once, whatever the network does.');
      await page.choose('#comment-audience', 'client');
      await press(page, '[data-comment="post"]');
      expect(page.find('[data-comment="refusal"]')).not.toBeNull();

      await press(page, '[data-comment="post"]');
      const [first, second] = idsOf('task/comment');
      expect(second).toBe(first);
      expect(page.find('[data-comment="unresolved"]')).not.toBeNull();

      await typeComment(page, 'A different comment altogether.');
      await press(page, '[data-comment="post"]');
      expect(idsOf('task/comment')[2]).not.toBe(first);
    });
  }

  it('comment: changing only the audience is a different comment', async () => {
    const { client, idsOf } = server({ comment: ['lost', 'ok'] });
    const page = await open(client);

    await typeComment(page, 'Who reads this matters.');
    await press(page, '[data-comment="post"]');
    await page.choose('#comment-audience', 'client');
    await press(page, '[data-comment="post"]');

    const [first, second] = idsOf('task/comment');
    expect(second).not.toBe(first);
  });
});

describe('R2-THERMO-12 / R1-SURFACE-34: a refused decision survives the reread that moved its gate', () => {
  const before: readonly LineageSpec[] = [
    { id: 'l-0001', versions: [{ id: 'v-0001', version: 1, gateId: 'g-0001' }] },
    { id: 'l-0002', versions: [{ id: 'v-0002', version: 1, gateId: 'g-0002' }] },
  ];
  // Another actor proposed version 2 into l-0001: v-0001 and g-0001 are superseded.
  const superseded: readonly LineageSpec[] = [
    {
      id: 'l-0001',
      versions: [
        { id: 'v-0003', version: 2, gateId: 'g-0003' },
        { id: 'v-0001', version: 1, gateId: 'g-0001', gateState: 'superseded', superseded: true },
      ],
    },
    before[1] as LineageSpec,
  ];
  // A reread that no longer lists the refused gate at all.
  const gone: readonly LineageSpec[] = [
    { id: 'l-0001', versions: [{ id: 'v-0003', version: 2, gateId: 'g-0003' }] },
    before[1] as LineageSpec,
  ];

  for (const code of ['GATE_ALREADY_DECIDED', 'VERSION_SUPERSEDED']) {
    it(`quotes ${code} once, under the superseded gate in l-0001, and nowhere in l-0002`, async () => {
      const { client } = server({ lineages: before, decide: { code, after: superseded } });
      const page = await open(client);

      await press(page, '[data-gate-id="g-0001"][data-decide="approve"]');

      // The reread happened: l-0001's head is now version 2.
      expect(page.find('[data-lineage-id="l-0001"] [data-version-id="v-0003"]')).not.toBeNull();
      const quoted = page.all('[data-decide="refusal"]');
      expect(quoted).toHaveLength(1);
      expect(quoted[0]?.textContent).toContain(code);
      expect(quoted[0]?.closest('[data-version-id]')?.getAttribute('data-version-id')).toBe(
        'v-0001',
      );
      expect(page.find('[data-lineage-id="l-0002"] [data-decide="refusal"]')).toBeNull();
    });
  }

  it('quotes the refusal under its lineage when the reread no longer lists the gate', async () => {
    const { client } = server({
      lineages: before,
      decide: { code: 'GATE_ALREADY_DECIDED', after: gone },
    });
    const page = await open(client);

    await press(page, '[data-gate-id="g-0001"][data-decide="approve"]');

    const quoted = page.all('[data-decide="refusal"]');
    expect(quoted).toHaveLength(1);
    expect(quoted[0]?.textContent).toContain('GATE_ALREADY_DECIDED');
    expect(quoted[0]?.closest('[data-lineage-id]')?.getAttribute('data-lineage-id')).toBe('l-0001');
  });
});

const settingsTab = (page: Mounted): Element | undefined =>
  page.all('.dock__tab').find((tab) => tab.getAttribute('aria-label')?.endsWith(' Settings'));

describe('R2-SURFACE-42: the settings dock tab does what it announces', () => {
  const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
  const storage = (): StorageLike => {
    const held = new Map([['ops-astro.session', JSON.stringify(SESSION)]]);
    return {
      getItem: (key) => held.get(key) ?? null,
      setItem: (key, value) => {
        held.set(key, value);
      },
      removeItem: (key) => {
        held.delete(key);
      },
    };
  };
  // Every read stays in flight: only the dock is under test.
  const fetch = (() =>
    new Promise<Response>(() => undefined)) as unknown as typeof globalThis.fetch;

  async function appAt(path: string, went: string[]): Promise<Mounted> {
    const page = await mount(
      <App
        path={path}
        navigate={(next) => {
          went.push(next);
        }}
        sessions={new SessionStore(storage())}
        gotrueUrl="http://gotrue.test"
        apiOrigin=""
        fetch={fetch}
        storage={null}
      />,
    );
    live.push(page);
    return page;
  }

  it('on /settings, "Close Settings" leaves the settings address', async () => {
    const went: string[] = [];
    const page = await appAt('/settings', went);
    const tab = settingsTab(page);
    expect(tab?.getAttribute('aria-label')).toBe('Close Settings');
    expect(tab?.getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      (tab as HTMLElement).click();
    });

    expect(went).toHaveLength(1);
    expect(went[0]).not.toBe('/settings');
  });

  it('elsewhere, "Open Settings" goes to /settings', async () => {
    const went: string[] = [];
    const page = await appAt('/projects/', went);
    const tab = settingsTab(page);
    expect(tab?.getAttribute('aria-label')).toBe('Open Settings');
    expect(tab?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      (tab as HTMLElement).click();
    });

    expect(went).toEqual(['/settings']);
  });
});
