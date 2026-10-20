// SPDX-License-Identifier: AGPL-3.0-only
//
// Proof by Sol (GPT-6.1-Sol), review of #1940 at f00e5a4d71, finding S1940-1;
// assertions unchanged.
// An authority probe gets past body validation, so what answers is authority.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { probeOperands } from '../acceptance/role-case-fixed-bodies.ts';
import { definitionReadOperands } from '../../packages/core-commands/src/commands/definition-read-agent.ts';
import type { AgentRequest } from '../../packages/core-commands/src/commands/agent-call.ts';

it('a definition read authority probe has valid operands', () => {
  const request = {
    command: 'definition.read',
    operationId: randomUUID(),
    ...probeOperands('definition.read'),
  } as AgentRequest;
  expect(
    definitionReadOperands(request),
    'an authority probe must get past body validation',
  ).not.toHaveProperty('refusal');
});
