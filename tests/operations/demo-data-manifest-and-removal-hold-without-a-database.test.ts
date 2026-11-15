// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite: the manifest proof, then the removal stop */
//
// The demo data's seed and removal (scripts/ops/demo-data.ts, #2211) against a
// stand-in transport, for the two cases the database suite cannot stage: the
// manifest keeps every id a step's answer names as made (Sol S2505-2); and the
// removal stops before anything is trashed at a listed task it cannot check
// whole: one that cannot be read (S2505-1, S2505-3), or one with any subtask,
// since task.trash takes the whole subtree and the demo makes none (S2505-3);
// and each trash names its one task in onlyRecords, so a subtask filed after
// the read is refused by the server (#2525, S2505-4), under an operation id
// new to each run, so a refusal is never replayed to the next.

import { describe, expect, it } from 'vitest';
import {
  NEEDED,
  Refusal,
  remove,
  seed,
  type Body,
  type Manifest,
} from '../../scripts/ops/demo-data.ts';

const manifest = (): Manifest => ({
  version: 1,
  batch: 'manifest-proof',
  business: 'test',
  api: 'http://api.test',
  createdAt: '2026-10-20T06:00:00.000Z',
  made: [],
});

const id = (n: number): string => `7d1f2a3b-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('demo data manifest and removal', () => {
  it('the manifest lists every id a proposal and a side chat made', async () => {
    const kept = manifest();
    const returned: string[] = [];
    let serial = 0;
    await seed(
      (verb) => {
        serial += 1;
        const made = id(serial);
        if (verb === 'session.capabilities') {
          const grants = NEEDED.map((pair) => {
            const [collection, action] = pair.split(':');
            return { collection, action };
          });
          return Promise.resolve({ status: 200, body: { grants } });
        }
        const keys: Record<string, readonly string[]> = {
          'client.create': ['clientId'],
          'tag.create': ['tagId'],
          'task.comment': ['commentId'],
          'task.propose': ['lineageId', 'versionId', 'runId', 'stepId', 'evidencePackId', 'gateId'],
          'conversation.start': ['conversationId', 'messageId'],
        };
        const detail: Body = Object.fromEntries(
          (keys[verb] ?? []).map((key, n) => [key, `${made}-${String(n)}`]),
        );
        if (verb === 'task.propose' || verb === 'conversation.start') {
          returned.push(...Object.values(detail).map(String));
        }
        return Promise.resolve({ status: 200, body: { recordId: made, revision: 1, detail } });
      },
      kept,
      () => {},
    );
    const saved = JSON.stringify(kept);
    expect(returned.length, 'the plan has a proposal and a side chat').toBeGreaterThan(0);
    expect(returned.filter((made) => !saved.includes(`"${made}"`))).toStrictEqual([]);
  });

  it('an unreadable demo task its demo title no longer finds stops the removal before any trash', async () => {
    const listed = manifest();
    listed.made.push(
      { step: 'task:0', kind: 'task', id: id(1), name: 'Demo One', revision: 1 },
      { step: 'task:1', kind: 'task', id: id(2), name: 'Demo Two', revision: 1 },
    );
    const sent: string[] = [];
    const removal = remove((verb, body) => {
      sent.push(verb);
      if (verb === 'task.read' && body['recordId'] === id(2)) {
        return Promise.resolve({ status: 500, body: { code: 'DECISION_INTEGRITY' } });
      }
      if (verb === 'task.read') {
        return Promise.resolve({
          status: 200,
          body: { task: { fields: { title: 'Demo One' }, revision: 1 } },
        });
      }
      // Renamed to 'Real work': a search for 'Demo Two' no longer finds it.
      if (verb === 'task.search') return Promise.resolve({ status: 200, body: { hits: [] } });
      return Promise.resolve({ status: 200, body: {} });
    }, listed);
    await expect(removal).rejects.toBeInstanceOf(Refusal);
    expect(sent.filter((verb) => verb === 'task.trash')).toStrictEqual([]);
  });

  it('an unreadable demo task stops the removal even when search still finds its demo title', async () => {
    const listed = manifest();
    listed.made.push({ step: 'task:0', kind: 'task', id: id(1), name: 'Demo One', revision: 1 });
    const sent: string[] = [];
    const removal = remove((verb) => {
      sent.push(verb);
      if (verb === 'task.read') {
        return Promise.resolve({ status: 500, body: { code: 'DECISION_INTEGRITY' } });
      }
      // Search shows the title, but not what sits under the task.
      if (verb === 'task.search') {
        return Promise.resolve({ status: 200, body: { hits: [{ id: id(1), title: 'Demo One' }] } });
      }
      return Promise.resolve({ status: 200, body: {} });
    }, listed);
    await expect(removal).rejects.toThrow('cannot be read');
    expect(sent.filter((verb) => verb === 'task.trash')).toStrictEqual([]);
  });

  it('a listed task with a subtask the manifest does not list stops the removal before any trash', async () => {
    const listed = manifest();
    listed.made.push(
      { step: 'task:0', kind: 'task', id: id(1), name: 'Demo One', revision: 1 },
      { step: 'task:1', kind: 'task', id: id(2), name: 'Demo Two', revision: 1 },
    );
    const sent: string[] = [];
    const removal = remove((verb, body) => {
      sent.push(verb);
      if (verb === 'task.read') {
        const two = body['recordId'] === id(2);
        // Real work filed under Demo Two since the seed: trashing Demo Two would take it too.
        const steps = two ? [{ id: id(9), title: 'Real client work' }] : [];
        const title = two ? 'Demo Two' : 'Demo One';
        return Promise.resolve({ status: 200, body: { fields: { title }, revision: 1, steps } });
      }
      return Promise.resolve({ status: 200, body: {} });
    }, listed);
    await expect(removal).rejects.toThrow('subtask');
    expect(sent.filter((verb) => verb === 'task.trash')).toStrictEqual([]);
  });

  it('a listed task under a listed task stops the removal before any trash: the demo makes no subtask', async () => {
    const listed = manifest();
    listed.made.push(
      { step: 'task:0', kind: 'task', id: id(1), name: 'Demo One', revision: 1 },
      { step: 'task:1', kind: 'task', id: id(2), name: 'Demo Two', revision: 1 },
    );
    const sent: string[] = [];
    const removal = remove((verb, body) => {
      sent.push(verb);
      if (verb === 'task.read') {
        const one = body['recordId'] === id(1);
        // onlyRecords names one task, so trashing Demo One would be refused after other trashes.
        const steps = one ? [{ id: id(2), title: 'Demo Two' }] : [];
        const title = one ? 'Demo One' : 'Demo Two';
        return Promise.resolve({ status: 200, body: { fields: { title }, revision: 1, steps } });
      }
      return Promise.resolve({ status: 200, body: {} });
    }, listed);
    await expect(removal).rejects.toThrow('subtask');
    expect(sent.filter((verb) => verb === 'task.trash')).toStrictEqual([]);
  });

  it('each trash names its one task in onlyRecords', async () => {
    const listed = manifest();
    listed.made.push(
      { step: 'task:0', kind: 'task', id: id(1), name: 'Demo One', revision: 1 },
      { step: 'task:1', kind: 'task', id: id(2), name: 'Demo Two', revision: 3 },
    );
    const trashes: Body[] = [];
    const result = await remove((verb, body) => {
      if (verb === 'task.read') {
        const title = body['recordId'] === id(1) ? 'Demo One' : 'Demo Two';
        const revision = body['recordId'] === id(1) ? 1 : 3;
        return Promise.resolve({ status: 200, body: { fields: { title }, revision, steps: [] } });
      }
      if (verb === 'task.trash') trashes.push(body);
      return Promise.resolve({ status: 200, body: {} });
    }, listed);
    expect(result).toStrictEqual({ trashed: 2, gone: 0 });
    expect(
      trashes.map((body) => [body['recordId'], body['expectedRevision'], body['onlyRecords']]),
    ).toStrictEqual([
      [id(1), 1, [id(1)]],
      [id(2), 3, [id(2)]],
    ]);
  });

  it('each removal run sends its trashes under new operation ids, so a refusal is never replayed', async () => {
    const listed = manifest();
    listed.made.push({ step: 'task:0', kind: 'task', id: id(1), name: 'Demo One', revision: 1 });
    const operations: unknown[] = [];
    const run = async (): Promise<unknown> =>
      await remove((verb, body) => {
        if (verb === 'task.read') {
          const answer = { fields: { title: 'Demo One' }, revision: 1, steps: [] };
          return Promise.resolve({ status: 200, body: answer });
        }
        operations.push(body['operationId']);
        // The register keeps a refusal under its operation id and replays it.
        return Promise.resolve({ status: 409, body: { code: 'TRASH_SUBTREE_CHANGED' } });
      }, listed);
    await expect(run()).rejects.toThrow('TRASH_SUBTREE_CHANGED');
    await expect(run()).rejects.toThrow('TRASH_SUBTREE_CHANGED');
    expect(operations).toHaveLength(2);
    expect(operations[0]).not.toBe(operations[1]);
  });
});
