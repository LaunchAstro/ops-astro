// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent's plan request check (#1620 P4) refuses a model that is not
// text, even one whose JSON object has no usable `toString`, without throwing.

import { expect, it } from 'vitest';
import { chatOf } from '../../apps/model-agent/request-check.ts';

it('a non-string JSON model is refused without throwing', () => {
  const request = {
    destination: 'chatgpt_plan',
    path: '/v1/responses',
    method: 'POST',
    timeoutMs: 120000,
    maxResponseBytes: 1048576,
    body: JSON.stringify({
      model: { toString: null, valueOf: null },
      instructions: 'A synthetic instruction',
      input: [{ role: 'user', content: 'Synthetic text' }],
      store: false,
      stream: true,
    }),
  };
  expect(chatOf(request)).toBeUndefined();
});
