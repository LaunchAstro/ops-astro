// SPDX-License-Identifier: AGPL-3.0-only
//
// The demo data's seed and removal (scripts/ops/demo-data.ts, #2211) against a
// stand-in transport, for the two cases the database suite cannot stage: the
// manifest keeps every id a step's answer names as made (Sol S2505-2), and an
// unreadable demo task that search no longer finds by its demo title stops the
// removal before anything is trashed (Sol S2505-1).

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
      () => undefined,
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
});
