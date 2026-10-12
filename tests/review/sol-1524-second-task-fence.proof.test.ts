// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { readProposal } from '../../packages/core-wire/src/task-proposal.ts';

it('Sol proof, criterion 1: a four-backtick task block before the closing task block draws no actionable proposal', () => {
  const body =
    'Two tasks.\n\n````task\n{"action":"create","title":"First task"}\n````\n\n```task\n{"action":"create","title":"Second task"}\n```';
  expect(readProposal(body)).toStrictEqual({ words: body, proposal: null });
});
