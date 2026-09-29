// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { writeBundle } from '../../scripts/local/journey-bundle.ts';

describe('a plain-text failure detail', () => {
  it('a plain-text failure detail cannot disclose client content', () => {
    const clientTitle = 'Client Quokka confidential treatment plan';
    const bundle = writeBundle({
      head: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      clean: true,
      identity: '{}',
      environment: {},
      cases: [
        {
          case: 'task.read',
          status: 'fail',
          detail: `The read failed while handling ${clientTitle}`,
        },
      ],
      budgets: [],
      crashPoints: '',
      approval: {
        taskId: 'task-1',
        decisionId: 'decision-1',
        decision: 'approve',
        action: JSON.stringify({ decision: 'approve', note: 'routine approval' }),
      },
    });
    expect(bundle.json).not.toContain(clientTitle);
    expect(bundle.markdown).not.toContain(clientTitle);
  });
});
