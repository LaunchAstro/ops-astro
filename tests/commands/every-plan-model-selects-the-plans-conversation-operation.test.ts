// SPDX-License-Identifier: AGPL-3.0-only
//
// Each of the plan's models answers on the plan's own conversation operation,
// though the laptop's local GPT runner names one of the same ids (#2175).

import { expect, it } from 'vitest';
import { operationFor } from '../../packages/core-commands/src/commands/conversation-paid.ts';
import {
  CHATGPT_PLAN_CONVERSATION,
  CHATGPT_PLAN_MODELS,
} from '../../packages/core-connectors/src/index.ts';
it('every plan picker model selects the plan operation', () => {
  expect(CHATGPT_PLAN_MODELS.map((model) => ({ model, operation: operationFor(model) }))).toEqual(
    CHATGPT_PLAN_MODELS.map((model) => ({ model, operation: CHATGPT_PLAN_CONVERSATION.key })),
  );
});
