// SPDX-License-Identifier: AGPL-3.0-only
//
// Stub for the red run (#2091): the turn adapter and reader are not built yet.

import {
  CHATGPT_PLAN_CONVERSATION,
  chatgptPlanAdapter,
  readChatgptPlanAnswer,
} from './chatgpt-plan.ts';
import type { AdapterRequest, ModelAnswer, ModelOperationDeclaration } from './operation.ts';

export const AGENT_TURN_KEY = 'model.agent_turn';

export const AGENT_TURN_INSTRUCTIONS = '';

export function chatgptPlanTurnAdapter(
  values: Readonly<Record<string, string>>,
  _operationId?: string,
): AdapterRequest {
  return chatgptPlanAdapter({ message: values['turn'] ?? '' });
}

export function readChatgptPlanTurnAnswer(body: unknown): ModelAnswer | undefined {
  return readChatgptPlanAnswer(body);
}

export const CHATGPT_PLAN_TURN: ModelOperationDeclaration = {
  ...CHATGPT_PLAN_CONVERSATION,
  key: AGENT_TURN_KEY,
};
