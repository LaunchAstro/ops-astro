// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 1, lane FR1-WEB-A: the task page's controls follow the
// record and the refusal they belong to.
//
// - #27: a cancelled lineage's still-pending gate is not offered for a
//   decision, because `task.decide` refuses every such decision with
//   `LINEAGE_TERMINAL`.
// - #33: a stale lifecycle or assignee press is not drawn as a conflict over a
//   title and due date that nobody edited.
// - #34/#44: a refused decision is quoted under the gate it was about, not under
//   every lineage on the task.
// - #35: a comment (or proposal) refused for this reader stays refused across a
//   reread, so the box does not invite the same refusal again.
// - #45: the propose form offers only the currency the seeded cap is kept in.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from './mount.tsx';

const TASK_ID = '55555555-5555-4555-8555-555555555555';

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

interface LineageSpec {
  readonly id: string;
  readonly state: string;
  readonly gateId: string;
}

interface ServerOptions {
  readonly lineages?: readonly LineageSpec[];
  /** What `task.decide` refuses with, if anything. */
  readonly refuseDecide?: { readonly code: string; readonly status: number };
  /** `task.comment` answers `SCOPE_NOT_GRANTED`. */
  readonly refuseComment?: boolean;
  /** `task.propose` answers `SCOPE_NOT_GRANTED`. */
  readonly refusePropose?: boolean;
}

function lineageOf(spec: LineageSpec) {
  return {
    lineageId: spec.id,
    state: spec.state,
    versions: [
      {
        versionId: `v-${spec.id}`,
        version: 1,
        purpose: 'client_renewal_quote',
        maximumMinor: 10_000,
        currency: 'AUD',
        payloadDigest: `digest-${spec.id}`,
        payload: { step: 'draft the quote' },
        supersededAt: null,
        runId: null,
        evidence: null,
        gate: {
          id: spec.gateId,
          state: 'pending',
          round: 1,
          expiresAt: '2099-01-01T00:00:00.000Z',
          expired: false,
          payloadDigest: `digest-${spec.id}`,
        },
      },
    ],
    decisions: [],
    reservations: [],
  };
}

/**
 * A task whose writes are checked against its revision the way the API checks
 * them, so a press made from a page another tab has moved on is `VERSION_STALE`.
 */
function server(options: ServerOptions = {}) {
  const task = {
    id: TASK_ID,
    key: 'TSK-51',
    title: 'A task two tabs are looking at',
    description: null,
    state: { id: 's1', key: 'todo', label: 'To do', machineCategory: 'unstarted' },
    assignee: null,
    due: '2026-10-01T00:00:00.000Z',
    priority: null,
    completedAt: null,
    revision: 3,
    history: [],
    comments: [],
    proposals: (options.lineages ?? []).map(lineageOf),
  };
  const calls: string[] = [];
  // A read held open, the way a real network read is: without it the reread's
  // `loading` and its answer land in one flush and nothing below it unmounts.
  let readGate: Promise<void> | null = null;
  let openRead: (() => void) | null = null;

  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const operation = at.slice(at.lastIndexOf('/', at.lastIndexOf('/') - 1) + 1);
    calls.push(operation);
    if (operation === 'person/list') return json({ ok: true, persons: [] });
    if (operation === 'task/read') {
      const held = readGate;
      readGate = null;
      await (held ?? Promise.resolve());
      return json({ ok: true, task });
    }
    if (operation === 'task/comment') {
      if (options.refuseComment === true) return refusal('SCOPE_NOT_GRANTED', 403);
      return json({ recordId: TASK_ID, revision: task.revision });
    }
    if (operation === 'task/propose') {
      if (options.refusePropose === true) return refusal('SCOPE_NOT_GRANTED', 403);
      return json({ recordId: TASK_ID, revision: task.revision });
    }
    if (operation === 'task/decide') {
      if (options.refuseDecide !== undefined) {
        return refusal(options.refuseDecide.code, options.refuseDecide.status);
      }
      return json({ recordId: TASK_ID, revision: task.revision });
    }
    if (['task/start', 'task/complete', 'task/reopen', 'task/assign'].includes(operation)) {
      if (Number(body['expectedRevision']) !== task.revision) {
        return refusal('VERSION_STALE', 409);
      }
      task.revision += 1;
      return json({ recordId: TASK_ID, revision: task.revision });
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;

  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    token: 'a-token',
    fetch,
    newOperationId: () => 'operation-1',
  });

  return {
    client,
    task,
    count: (operation: string) => calls.filter((call) => call === operation).length,
    holdRead: () => {
      readGate = new Promise<void>((resolve) => {
        openRead = resolve;
      });
    },
    releaseRead: async () => {
      await act(async () => {
        openRead?.();
      });
      await tick();
    },
  };
}

const screenFor = (client: OperationsClient) => (
  <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-51" />
);

async function open(client: OperationsClient): Promise<Mounted> {
  const page = await mount(screenFor(client));
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

describe('#27: a cancelled lineage is not offered for a decision', () => {
  it('draws no Approve or Reject on its pending head gate, and says why', async () => {
    const { client } = server({
      lineages: [{ id: 'l-0001', state: 'cancelled', gateId: 'g-0001' }],
    });
    const page = await open(client);

    const lineage = page.find('[data-lineage-id="l-0001"]');
    expect(lineage?.getAttribute('data-lineage-state')).toBe('cancelled');
    expect(page.find('[data-decide="approve"]')).toBeNull();
    expect(page.find('[data-decide="reject"]')).toBeNull();
    const why = page.find('[data-lineage-id="l-0001"] [data-decide="closed"]');
    expect(why?.textContent).toContain('cancelled');
    expect(why?.textContent).toContain('restart');
    await page.unmount();
  });

  it('still offers the decision on a live lineage beside it', async () => {
    const { client } = server({
      lineages: [
        { id: 'l-0001', state: 'cancelled', gateId: 'g-0001' },
        { id: 'l-0002', state: 'live', gateId: 'g-0002' },
      ],
    });
    const page = await open(client);

    expect(page.find('[data-lineage-id="l-0001"] [data-decide="approve"]')).toBeNull();
    expect(page.find('[data-lineage-id="l-0002"] [data-decide="approve"]')).not.toBeNull();
    await page.unmount();
  });
});

describe('#33: a stale press that was not a title or due-date save', () => {
  for (const press of ['complete', 'start'] as const) {
    it(`quotes VERSION_STALE for ${press} and lists no unsaved edit`, async () => {
      const { client, task, count } = server();
      const page = await open(client);
      // Another tab moved the task on after this one read it.
      task.revision = 4;

      await page.click(`[data-lifecycle="${press}"]`);
      await tick();

      expect(count(`task/${press}`)).toBe(1);
      expect(page.find('[data-conflict="unsaved"]')).toBeNull();
      expect(page.find('[data-conflict="version"]')).toBeNull();
      expect(page.text()).toContain('VERSION_STALE');
      // And the page read the task again, so the next press carries revision 4.
      expect(page.find('[data-revision]')?.getAttribute('data-revision')).toBe('4');
      await page.unmount();
    });
  }
});

describe('#34/#44: a refused decision is quoted under its own gate', () => {
  for (const code of ['GATE_ALREADY_DECIDED', 'SCOPE_NOT_GRANTED']) {
    it(`draws ${code} once, inside the lineage that was pressed`, async () => {
      const { client } = server({
        lineages: [
          { id: 'l-0001', state: 'live', gateId: 'g-0001' },
          { id: 'l-0002', state: 'live', gateId: 'g-0002' },
        ],
        refuseDecide: { code, status: code === 'SCOPE_NOT_GRANTED' ? 403 : 409 },
      });
      const page = await open(client);

      await page.click('[data-lineage-id="l-0001"] [data-decide="approve"]');
      await tick();

      const refusals = page.all('[data-decide="refusal"]');
      expect(refusals).toHaveLength(1);
      expect(refusals[0]?.closest('[data-lineage-id]')?.getAttribute('data-lineage-id')).toBe(
        'l-0001',
      );
      expect(refusals[0]?.textContent).toContain(code);
      expect(page.find('[data-lineage-id="l-0002"] [data-decide="refusal"]')).toBeNull();
      // Nothing under the other gate says its own decision was refused.
      expect(page.find('[data-lineage-id="l-0002"]')?.textContent ?? '').not.toContain(
        'on this gate',
      );
      await page.unmount();
    });
  }
});

describe('#35: a refusal about this reader outlives the reread', () => {
  it('keeps the comment box closed after an unrelated write rereads the task', async () => {
    const { client, count, holdRead, releaseRead } = server({ refuseComment: true });
    const page = await open(client);

    await typeComment(page, 'A note the member may not post.');
    await page.click('[data-comment="post"]');
    await tick();
    expect(count('task/comment')).toBe(1);
    expect(page.find('[data-comment="refusal"]')?.textContent).toContain('SCOPE_NOT_GRANTED');

    // Start is allowed, and a successful write rereads the task. The reread
    // draws `loading`, which unmounts the comment box.
    holdRead();
    await page.click('[data-lifecycle="start"]');
    await tick();
    expect(count('task/start')).toBe(1);
    expect(page.find('#comment-body')).toBeNull();
    await releaseRead();
    expect(page.find('[data-revision]')?.getAttribute('data-revision')).toBe('4');

    expect((page.find('#comment-body') as HTMLTextAreaElement).disabled).toBe(true);
    expect(page.find('[data-comment="refusal"]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(page.find('[data-comment="closed"]')).not.toBeNull();
    await page.click('[data-comment="post"]');
    await tick();
    expect(count('task/comment')).toBe(1);
    await page.unmount();
  });

  it('keeps the propose form closed after Refresh rereads the task', async () => {
    const { client, count, holdRead, releaseRead } = server({ refusePropose: true });
    const page = await open(client);

    await page.type('#propose-purpose', 'client_renewal_quote');
    await page.type('#propose-maximum', '10');
    await act(async () => {
      (page.find('#task-propose') as HTMLFormElement).requestSubmit();
    });
    await tick();
    expect(count('task/propose')).toBe(1);

    holdRead();
    await page.click('[data-refresh="task"]');
    await tick();
    expect(page.find('#task-propose')).toBeNull();
    await releaseRead();

    expect((page.find('[data-propose="submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect(page.find('[data-propose="refusal"]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(page.find('[data-propose="closed"]')).not.toBeNull();
    await page.unmount();
  });
});

describe('#45: the propose form offers the currency the seeded cap is kept in', () => {
  it('lists AUD and nothing else', async () => {
    const { client } = server();
    const page = await open(client);

    const options = page.all('#propose-currency option').map((node) => node.getAttribute('value'));
    // `scripts/local-seed.mjs` inserts every business's cap in AUD, and
    // `task.decide` refuses a version in any other currency.
    expect(options).toEqual(['AUD']);
    await page.unmount();
  });
});
