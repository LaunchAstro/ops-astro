// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, lane FR2-WEB continuation: what a person typed on the
// task page outlives the reread, and a retried save is the same attempt.
//
// - R2-SURFACE-41: a comment or proposal refused `VERSION_STALE` rereads the
//   task, keeps the text, and the next press is sent against the new revision.
//   An unrelated reread keeps the text as well.
// - The details save (the observation on R2-SURFACE-10): a save whose answer
//   was lost is retried under the same `operationId`, so the server's register
//   replays it (`docs/local/API.md`, a replay is prepared "without the target's
//   revision") instead of the page calling the person's own save somebody
//   else's change.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from './mount.tsx';

const TASK_ID = '77777777-7777-4777-8777-777777777777';

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
  /** Answers to `task.update`, in order; the last repeats. A lost one still commits. */
  readonly update?: readonly Reply[];
}

/** The scripted answer for the `index`th call; the last one repeats. */
const answer = (replies: readonly Reply[] | undefined, index: number): Reply =>
  replies === undefined ? 'ok' : (replies[Math.min(index, replies.length - 1)] ?? 'ok');

function server(options: ServerOptions = {}) {
  const task = {
    id: TASK_ID,
    key: 'TSK-71',
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
  const register = new Map<string, unknown>();
  let minted = 0;

  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const operation = at.slice(at.lastIndexOf('/', at.lastIndexOf('/') - 1) + 1);
    (sent[operation] ??= []).push(body);
    const index = (sent[operation]?.length ?? 1) - 1;
    if (operation === 'person/list') return json({ ok: true, persons: [] });
    if (operation === 'task/read') return json({ ok: true, task });
    if (operation === 'task/update') {
      const id = String(body['operationId']);
      // The register: a known attempt replays its stored answer, whatever the
      // revision is now.
      const stored = register.get(id);
      if (stored !== undefined) return json(stored);
      if (Number(body['expectedRevision']) !== task.revision) return refusal('VERSION_STALE', 409);
      const fields = body['fields'] as { title?: string };
      task.title = fields.title ?? task.title;
      task.revision += 1;
      const result = { recordId: TASK_ID, revision: task.revision };
      register.set(id, result);
      const reply = answer(options.update, index);
      if (reply === 'lost') return new Response('bad gateway', { status: 502 });
      if (reply === 'dropped') throw new TypeError('Failed to fetch');
      return json(result);
    }
    if (operation === 'task/propose' || operation === 'task/comment') {
      if (Number(body['expectedRevision']) !== task.revision) return refusal('VERSION_STALE', 409);
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
  const revisionsOf = (operation: string): readonly unknown[] =>
    (sent[operation] ?? []).map((body) => body['expectedRevision']);
  return { client, idsOf, revisionsOf, task };
}

// A failed assertion skips the test's own unmount, and a page left behind
// breaks the next test's typing, so every page is unmounted here as well.
const live: Mounted[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((page) => page.unmount()));
});

async function open(client: OperationsClient): Promise<Mounted> {
  const page = await mount(
    <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-71" />,
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

const revisionOnPage = (page: Mounted): string | null | undefined =>
  page.find('[data-revision]')?.getAttribute('data-revision');

describe('R2-SURFACE-41: a stale comment or proposal rereads and keeps the text', () => {
  it('comment: VERSION_STALE rereads, keeps the body, and the next press is sent at the new revision', async () => {
    const { client, revisionsOf, task } = server();
    const page = await open(client);
    await typeComment(page, 'A long comment typed with care.');
    await page.choose('#comment-audience', 'client');
    // Somebody else moved the task on after this page read it.
    task.revision = 4;

    await press(page, '[data-comment="post"]');

    expect(revisionOnPage(page)).toBe('4');
    expect((page.find('#comment-body') as HTMLTextAreaElement).value).toBe(
      'A long comment typed with care.',
    );
    expect((page.find('#comment-audience') as HTMLSelectElement).value).toBe('client');
    expect(page.find('[data-comment="stale"]')?.textContent).toContain('VERSION_STALE');

    await press(page, '[data-comment="post"]');
    expect(revisionsOf('task/comment')).toEqual([3, 4]);
    expect((page.find('#comment-body') as HTMLTextAreaElement).value).toBe('');
    expect(page.find('[data-comment="stale"]')).toBeNull();
  });

  it('propose: VERSION_STALE rereads, keeps the fields, and the next press is sent at the new revision', async () => {
    const { client, revisionsOf, task } = server();
    const page = await open(client);
    await page.type('#propose-purpose', 'client_renewal_quote');
    await page.type('#propose-maximum', '500');
    task.revision = 4;

    await press(page, '[data-propose="submit"]');

    expect(revisionOnPage(page)).toBe('4');
    expect((page.find('#propose-purpose') as HTMLInputElement).value).toBe('client_renewal_quote');
    expect((page.find('#propose-maximum') as HTMLInputElement).value).toBe('500');
    expect(page.find('[data-propose="stale"]')?.textContent).toContain('VERSION_STALE');

    await press(page, '[data-propose="submit"]');
    expect(revisionsOf('task/propose')).toEqual([3, 4]);
    expect((page.find('#propose-purpose') as HTMLInputElement).value).toBe('');
    expect(page.find('[data-propose="stale"]')).toBeNull();
  });

  it('an unrelated reread keeps a comment and a proposal that were never sent', async () => {
    const { client } = server();
    const page = await open(client);
    await typeComment(page, 'Half a thought.');
    await page.type('#propose-purpose', 'client_budget');

    await press(page, '[data-refresh="task"]');

    expect((page.find('#comment-body') as HTMLTextAreaElement).value).toBe('Half a thought.');
    expect((page.find('#propose-purpose') as HTMLInputElement).value).toBe('client_budget');
  });

  it('a comment typed for one task is not offered on another', async () => {
    const { client } = server();
    const page = await open(client);
    await typeComment(page, 'Meant for TSK-71 only.');

    await page.render(<TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-72" />);
    await tick();

    expect((page.find('#comment-body') as HTMLTextAreaElement | null)?.value ?? '').toBe('');
  });
});

describe('the details save: a lost answer is retried as the same attempt', () => {
  it("replays the stored save rather than calling it somebody else's change", async () => {
    const { client, idsOf, task } = server({ update: ['lost', 'ok'] });
    const page = await open(client);
    await page.type('#task-title', 'A title saved once');

    await press(page, '[data-draft-resolve="save"]');
    // The save committed; its answer did not arrive.
    expect(task.revision).toBe(4);
    expect(page.find('[data-draft-resolve="choice"]')).not.toBeNull();

    await press(page, '[data-draft-resolve="save"]');

    // At 3eb0cc1 the retry was a new attempt, refused VERSION_STALE and drawn as
    // somebody else's change.
    expect(page.find('[data-conflict="version"]')).toBeNull();
    const [first, second] = idsOf('task/update');
    expect(second).toBe(first);
    expect(page.find('[data-draft-resolve="choice"]')).toBeNull();
    expect(revisionOnPage(page)).toBe('4');
  });

  it('an edit after the lost answer is a new attempt', async () => {
    const { client, idsOf } = server({ update: ['lost', 'ok'] });
    const page = await open(client);
    await page.type('#task-title', 'First wording');
    await press(page, '[data-draft-resolve="save"]');
    await page.type('#task-title', 'Second wording');
    await press(page, '[data-draft-resolve="save"]');

    const [first, second] = idsOf('task/update');
    expect(second).not.toBe(first);
  });
});
