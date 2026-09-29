// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { writeBundle } from '../../scripts/local/journey-bundle.ts';

describe('a client-authored uppercase token in a case detail', () => {
  it('a client-authored uppercase token stays out of case details', () => {
    const clientText = 'CLIENT_QUOKKA_SECRET';
    const bundle = writeBundle({
      head: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      clean: true,
      identity: '{}',
      environment: {},
      cases: [{ case: 'task.read', status: 'fail', detail: `The note ${clientText} was read` }],
      budgets: [],
      crashPoints: '',
      approval: {
        taskId: 'task-1',
        decisionId: 'decision-1',
        decision: 'approve',
        action: JSON.stringify({ decision: 'approve', note: 'routine approval' }),
      },
    });
    expect(bundle.json).not.toContain(clientText);
    expect(bundle.markdown).not.toContain(clientText);
  });
});
