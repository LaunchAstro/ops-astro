// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 3, lane FR3-WEB: a comment or proposal whose answer was
// lost is retried as the same attempt even after the task's revision has moved.
//
// - R3-SURFACE-21 = R3-THERMO-24 (and the R2-SURFACE-10 and R2-SURFACE-41
//   residue): the retry resends the held `operationId` with the
//   `expectedRevision` the attempt was first sent with. The register's digest
//   covers every field but the identity (`comparablePayload`,
//   `commands/requests.ts`), so a retry that carried the page's new revision
//   was a different request under the same identity: `OPERATION_ID_REUSED`,
//   the attempt dropped, and the next press stored a second comment or opened a
//   second lineage.
//
// The stand-in server below keeps a register that compares the whole request
// apart from `operationId`, as `replayOrRefuse` (`commands/envelope.ts`) does.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from './mount.tsx';

const TASK_ID = '88888888-8888-4888-8888-888888888888';

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

/**
 * How the server answers one write: stored and answered, stored with the
 * answer lost, or never reached (nothing stored, nothing answered).
 */
type Reply = 'ok' | 'lost' | 'unsent';

interface ServerOptions {
  /** Answers to `task.propose`, in order; the last repeats. */
  readonly propose?: readonly Reply[];
  /** Answers to `task.comment`, in order; the last repeats. */
  readonly comment?: readonly Reply[];
}

const answer = (replies: readonly Reply[] | undefined, index: number): Reply =>
  replies === undefined ? 'ok' : (replies[Math.min(index, replies.length - 1)] ?? 'ok');

function lineage(id: string) {
  return {
    lineageId: id,
    state: 'live',
    versions: [
      {
        versionId: `${id}-v1`,
        version: 1,
        purpose: 'client_renewal_quote',
        maximumMinor: 50_000,
        currency: 'AUD',
        payloadDigest: `digest-${id}`,
        payload: { step: 'client_renewal_quote' },
        supersededAt: null,
        runId: null,
        evidence: null,
        gate: {
          id: `${id}-gate`,
          state: 'pending',
          round: 1,
          expiresAt: '2099-01-01T00:00:00.000Z',
          expired: false,
          payloadDigest: `digest-${id}`,
        },
      },
    ],
    decisions: [],
    reservations: [],
  };
}

function server(options: ServerOptions = {}) {
  const task = {
    id: TASK_ID,
    key: 'TSK-81',
    title: 'A task whose answers go missing',
    description: null,
    state: { id: 's1', key: 'todo', label: 'To do', machineCategory: 'unstarted' },
    assignee: null,
    due: null,
    priority: null,
    completedAt: null,
    revision: 3,
    history: [],
    comments: [] as Record<string, unknown>[],
    proposals: [] as ReturnType<typeof lineage>[],
  };
  const sent: Record<string, Record<string, unknown>[]> = {};
  const answers: Record<string, string[]> = {};
  // The register: identity -> the digest of everything else, and the answer.
  const register = new Map<string, { readonly digest: string; readonly result: unknown }>();
  let minted = 0;

  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const operation = at.slice(at.lastIndexOf('/', at.lastIndexOf('/') - 1) + 1);
    (sent[operation] ??= []).push(body);
    const index = (sent[operation]?.length ?? 1) - 1;
    const said = (what: string): void => {
      (answers[operation] ??= []).push(what);
    };
    if (operation === 'person/list') return json({ ok: true, persons: [] });
    if (operation === 'task/read') return json({ ok: true, task });

    const id = String(body['operationId']);
    const { operationId: _identity, ...rest } = body;
    const digest = JSON.stringify(rest);
    const seen = register.get(id);
    if (seen !== undefined) {
      if (seen.digest !== digest) {
        said('OPERATION_ID_REUSED');
        return refusal('OPERATION_ID_REUSED', 409);
      }
      said('replayed');
      return json(seen.result);
    }

    if (operation === 'task/update') {
      if (Number(body['expectedRevision']) !== task.revision) return refusal('VERSION_STALE', 409);
      const fields = body['fields'] as { title?: string };
      task.title = fields.title ?? task.title;
      task.revision += 1;
      const result = { recordId: TASK_ID, revision: task.revision };
      register.set(id, { digest, result });
      said('stored');
      return json(result);
    }
    if (operation === 'task/propose' || operation === 'task/comment') {
      const reply = answer(operation === 'task/propose' ? options.propose : options.comment, index);
      if (reply === 'unsent') throw new TypeError('Failed to fetch');
      if (Number(body['expectedRevision']) !== task.revision) {
        said('VERSION_STALE');
        return refusal('VERSION_STALE', 409);
      }
      // `task.comment` and `task.propose` leave the task's revision alone.
      if (operation === 'task/comment') {
        task.comments.push({
          id: `comment-${String(task.comments.length + 1)}`,
          audience: body['audience'],
          author: 'ada',
          body: body['body'],
          comment_type: body['commentType'],
          posted_at: '2026-09-24T00:00:00.000Z',
          edited_at: null,
          source: 'web',
        });
      } else {
        task.proposals.push(lineage(`lineage-${String(task.proposals.length + 1)}`));
      }
      const result = { recordId: TASK_ID, revision: task.revision };
      register.set(id, { digest, result });
      said('stored');
      if (reply === 'lost') return new Response('bad gateway', { status: 502 });
      return json(result);
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
  const answersTo = (operation: string): readonly string[] => answers[operation] ?? [];
  return { client, idsOf, revisionsOf, answersTo, task };
}

const live: Mounted[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((page) => page.unmount()));
});

async function open(client: OperationsClient): Promise<Mounted> {
  const page = await mount(
    <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-81" />,
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

describe('R3-SURFACE-21: a lost comment or proposal is the same attempt after a reread', () => {
  it('comment: a title save moves the revision, and the retry replays the stored comment', async () => {
    const { client, idsOf, revisionsOf, answersTo, task } = server({ comment: ['lost', 'ok'] });
    const page = await open(client);
    await typeComment(page, 'Said once, answered never.');

    await press(page, '[data-comment="post"]');
    expect(task.comments).toHaveLength(1);
    expect(page.find('[data-comment="unresolved"]')).not.toBeNull();

    // The person saves the title: the task moves to revision 4 and is reread.
    await page.type('#task-title', 'A title saved in between');
    await press(page, '[data-draft-resolve="save"]');
    expect(revisionOnPage(page)).toBe('4');
    expect((page.find('#comment-body') as HTMLTextAreaElement).value).toBe(
      'Said once, answered never.',
    );

    await press(page, '[data-comment="post"]');
    const bodyAfterRetry = (page.find('#comment-body') as HTMLTextAreaElement).value;
    const refusedAfterRetry = page.find('[data-comment="refusal"]')?.textContent ?? null;
    // A third press: after a replay the box is empty and required, so nothing
    // is sent. At 61c167a the retry carried revision 4 and was refused
    // OPERATION_ID_REUSED, the attempt was dropped with the text kept, and this
    // press stored the comment a second time under a new identity.
    await press(page, '[data-comment="post"]');

    expect(answersTo('task/comment')).toEqual(['stored', 'replayed']);
    expect(task.comments).toHaveLength(1);
    const [first, second] = idsOf('task/comment');
    expect(second).toBe(first);
    expect(revisionsOf('task/comment')).toEqual([3, 3]);
    expect(refusedAfterRetry).toBeNull();
    expect(bodyAfterRetry).toBe('');
  });

  it('propose: another writer moves the task, a refresh rereads, and the retry replays the lineage', async () => {
    const { client, idsOf, revisionsOf, answersTo, task } = server({ propose: ['lost', 'ok'] });
    const page = await open(client);
    await page.type('#propose-purpose', 'client_renewal_quote');
    await page.type('#propose-maximum', '500');

    await press(page, '[data-propose="submit"]');
    expect(task.proposals).toHaveLength(1);
    expect(page.find('[data-propose="unresolved"]')).not.toBeNull();

    task.revision = 4;
    await press(page, '[data-refresh="task"]');
    expect(revisionOnPage(page)).toBe('4');

    await press(page, '[data-propose="submit"]');

    expect(answersTo('task/propose')).toEqual(['stored', 'replayed']);
    const [first, second] = idsOf('task/propose');
    expect(second).toBe(first);
    expect(revisionsOf('task/propose')).toEqual([3, 3]);
    expect(page.find('[data-propose="refusal"]')).toBeNull();
    expect((page.find('#propose-purpose') as HTMLInputElement).value).toBe('');
    expect(task.proposals).toHaveLength(1);
  });

  it('comment: an attempt that never arrived is refused stale on retry, keeps the text, and is stored once', async () => {
    const { client, idsOf, revisionsOf, answersTo, task } = server({ comment: ['unsent', 'ok'] });
    const page = await open(client);
    await typeComment(page, 'Never left the building.');

    await press(page, '[data-comment="post"]');
    expect(task.comments).toHaveLength(0);

    task.revision = 4;
    await press(page, '[data-refresh="task"]');

    // The retry is the same attempt, so it is sent at the revision it was made
    // against, and the server says the task has moved on.
    await press(page, '[data-comment="post"]');
    expect(page.find('[data-comment="stale"]')?.textContent).toContain('VERSION_STALE');
    expect((page.find('#comment-body') as HTMLTextAreaElement).value).toBe(
      'Never left the building.',
    );

    // The next press is a new attempt at the revision the page now shows.
    await press(page, '[data-comment="post"]');
    const [first, second, third] = idsOf('task/comment');
    expect(second).toBe(first);
    expect(third).not.toBe(first);
    expect(revisionsOf('task/comment')).toEqual([3, 3, 4]);
    expect(answersTo('task/comment')).toEqual(['VERSION_STALE', 'stored']);
    expect(task.comments).toHaveLength(1);
    expect((page.find('#comment-body') as HTMLTextAreaElement).value).toBe('');
  });

  it('propose: an edit after the lost answer and the reread is a new attempt at the new revision', async () => {
    const { client, idsOf, revisionsOf } = server({ propose: ['lost', 'ok'] });
    const page = await open(client);
    await page.type('#propose-purpose', 'client_renewal_quote');
    await page.type('#propose-maximum', '500');
    await press(page, '[data-propose="submit"]');

    await page.type('#task-title', 'A title saved in between');
    await press(page, '[data-draft-resolve="save"]');
    await page.type('#propose-maximum', '600');
    await press(page, '[data-propose="submit"]');

    const [first, second] = idsOf('task/propose');
    expect(second).not.toBe(first);
    expect(revisionsOf('task/propose')).toEqual([3, 4]);
  });
});
