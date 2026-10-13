// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's one real call that settles the plan's tool shape (#1620,
// `docs/local/chatgpt-plan.md`). Run by the owner on the M5 after the
// sign-in: it starts custody from the model agent's own settings and sends
// one pinned plan request with one function tool named top-level. Only if
// the plan refuses that request (400) does it send one more with the tool
// named under a namespace. It says which shape the plan took, by status
// only: never the answer's words or a token.
//
//   MODEL_AGENT_SETTINGS=<settings file> node apps/model-agent/chatgpt-plan-probe.ts

import { readFileSync } from 'node:fs';
import {
  CHATGPT_PLAN_DESTINATION,
  CHATGPT_PLAN_MODELS,
  CHATGPT_PLAN_TURN,
  chatgptPlanRequest,
  type ToolShape,
} from '../../packages/core-connectors/src/index.ts';
import { startCustody } from '../../packages/core-custody/src/agent.ts';
import { agentCustody, destinationsOf } from './main.ts';
import { chatOf } from './request-check.ts';
import { parseAgentSettings } from './settings.ts';

const TOOL = {
  name: 'task_read',
  description: 'Read the task this run works on.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

/** What the plan said to one shape: a status or a refusal's code, nothing of the answer. */
async function tried(send: ReturnType<typeof agentCustody>, shape: ToolShape): Promise<string> {
  const built = chatgptPlanRequest(
    {
      model: CHATGPT_PLAN_MODELS[0] ?? '',
      instructions: 'Reply with the single word: ready.',
      input: [{ role: 'user', content: 'Are you ready?' }],
      tools: [TOOL],
    },
    shape,
  );
  const request = chatOf({
    destination: CHATGPT_PLAN_DESTINATION,
    path: built.path,
    method: built.method,
    body: built.body,
    timeoutMs: CHATGPT_PLAN_TURN.timeoutMs,
    maxResponseBytes: CHATGPT_PLAN_TURN.maxResponseBytes,
  });
  if (request === undefined) return 'refused by the request check';
  const outcome = await send.dispatch(
    request,
    { deadlineAt: Date.now() + CHATGPT_PLAN_TURN.timeoutMs, onWritten: () => {} },
    () => {},
  );
  if (outcome.kind === 'refused') return outcome.code;
  if (outcome.kind !== 'answered') return outcome.kind;
  return outcome.outbound.ok
    ? `${String(outcome.outbound.status)} accepted`
    : `${String(outcome.outbound.status)} ${outcome.outbound.fault}`;
}

if (import.meta.main) {
  const read = parseAgentSettings(readFileSync(process.env['MODEL_AGENT_SETTINGS'] ?? '', 'utf8'));
  if (!read.ok || read.settings.chatgptCredentialRef === undefined) {
    process.stderr.write('probe: the settings name no ChatGPT plan\n');
    process.exitCode = 2;
  } else {
    const custody = await startCustody({
      credentialsFile: read.settings.credentialsFile,
      destinations: destinationsOf(read.settings),
    });
    try {
      const send = agentCustody(read.settings, custody);
      const top = await tried(send, 'top_level');
      process.stdout.write(`top_level: ${top}\n`);
      if (top.startsWith('400 ')) {
        process.stdout.write(`namespaced: ${await tried(send, 'namespaced')}\n`);
      }
    } finally {
      await custody.stop();
    }
  }
}
