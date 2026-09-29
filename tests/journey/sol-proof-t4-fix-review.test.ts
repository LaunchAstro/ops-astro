// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { commandBudgets, writeBundle } from '../../scripts/local/journey-bundle.ts';
import { compareFacts, type JourneyFacts } from './facts.ts';

describe('Sol proofs for the T4 fix head', () => {
  it('Sol proof, criterion 2: an aborted journey cannot pass the end-to-end budget', () => {
    const [, wholeCommand] = commandBudgets(undefined, 1000, undefined);
    expect(wholeCommand?.['status']).not.toBe('pass');
  });

  it('Sol proof, criterion 3: a failed comparison cannot put client content in the bundle', () => {
    const clientNote = 'Client Quokka confidential treatment plan';
    const facts: JourneyFacts = {
      decisions: [{ payload: { note: clientNote } }],
      receipt: { decision: 'approve' },
      reservations: [{ state: 'settled' }],
      attempts: [],
      events: [{ kind: 'picked_up' }],
      audit: [],
      alerts: [],
    };
    const compared = compareFacts(facts, {
      ...facts,
      decisions: [{ payload: { note: 'different note' } }],
    });
    expect(compared.ok).toBe(false);
    expect(compared.failures.join(' | ')).toContain(clientNote);
    const bundle = writeBundle({
      head: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      clean: true,
      identity: '{}',
      environment: {},
      cases: [
        { case: 'journey_twice_same_facts', status: 'fail', detail: compared.failures.join(' | ') },
      ],
      budgets: [],
      crashPoints: '',
      approval: {
        taskId: 'task-1',
        decisionId: 'decision-1',
        decision: 'approve',
        action: JSON.stringify({ decision: 'approve', note: clientNote }),
      },
    });
    expect(bundle.json).not.toContain(clientNote);
    expect(bundle.markdown).not.toContain(clientNote);
  });
});
