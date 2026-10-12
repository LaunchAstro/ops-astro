// SPDX-License-Identifier: AGPL-3.0-only
//
// The cost reads hand out records like any list: `finance.agent_costs` its
// log's runs, `finance.skill_costs` each skill and attribution split it
// returns. So five full cost logs taken by one reader inside the hour raise
// the export-volume alert (5,000 items in 60 minutes), as five full queues
// would.

import { describe, expect, it } from 'vitest';
import {
  createApi,
  type AgentExecutor,
  type CommandExecutor,
  type ReadExecutor,
} from '../../apps/api/app.ts';
import { createDetector } from '../../apps/api/alerts/detect.ts';
import { recordsIn } from '../../apps/api/records-in.ts';
import type { AlertKind } from '../../apps/api/alerts/catalogue.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { PREFIX, pathOf } from '../../packages/core-wire/src/index.ts';

const row = (index: number) => ({
  runId: `run-${index}`,
  taskId: `task-${index}`,
  agentActorId: null,
  attachment: { kind: 'agency' },
  currency: 'AUD',
  cost: '100',
  unpriced: null,
  startedAt: '2026-10-01T00:00:00.000Z',
  models: { ids: [], unnamedCalls: 0 },
});

/** One full page of the cost log: a thousand runs. */
const fullLog = {
  ok: true,
  period: { from: '2026-10-01', to: '2026-10-31' },
  runs: Array.from({ length: 1000 }, (_, index) => row(index)),
  byAgent: [],
  byAttachment: [],
};

describe('the cost reads and the export-volume alert', () => {
  it('five full cost logs read by one person raise export-volume', async () => {
    const raised: AlertKind[] = [];
    const detector = createDetector((kind) => raised.push(kind));
    const unused = (() => Promise.resolve({ code: 'ok' })) as unknown as CommandExecutor;
    const api = createApi({
      database: {} as Database,
      verify: () => Promise.resolve({ provider: 'test', subject: 'finance-reader' }),
      resolveBusiness: () => Promise.resolve('business-id'),
      executeRead: (() => Promise.resolve(fullLog)) as unknown as ReadExecutor,
      executeCommand: unused,
      executeAgentCommand: unused as unknown as AgentExecutor,
      observe: detector.observe,
    });
    for (let read = 0; read < 5; read += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one read after another, as one reader takes them
      const response = await api.fetch(
        new Request(`http://api.test${PREFIX.person}alpha${pathOf('finance.agent_costs')}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer reader' },
          body: '{}',
        }),
      );
      expect(response.status).toBe(200);
    }
    expect(raised).toStrictEqual(['export-volume']);
  });

  it('the skill costing counts each skill and each attribution split it returns', () => {
    const skill = { skillId: 's', name: 'n' };
    const split = { currency: 'AUD', runs: 1 };
    expect(recordsIn({ ok: true, costing: { skills: [skill, skill], split: [split] } })).toBe(3);
    expect(recordsIn({ ok: true, costing: null })).toBe(0);
  });
});
