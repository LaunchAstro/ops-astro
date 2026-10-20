// SPDX-License-Identifier: AGPL-3.0-only
//
// One #1904 P15 hook case, in a fresh process
// (`node agent-definition-hook-case.ts <case>`): the attempt's definition is
// a pinned file holding a planted marker, as `definition.read` answered it,
// kept only in the attempt's store. It plants a content recorder the way an
// inherited hook would, runs the runner, and prints booleans and counts only:
// whether the hook saw the marker, and whether the broker port (the way to
// the provider) was given it. Run by
// `an-inherited-hook-or-tracer-never-sees-a-models-content.test.ts`.

import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { registerConfigureHook, setContextVariable } from '@langchain/core/context';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { attemptState, runAttempt } from '../../packages/core-agent/src/index.ts';
import { final, reads, scripted, TASK } from './agent-ports.ts';

const MARKER = `OA-MARKER-${String(process.pid)}`;
const TEXT = `# Agents\n${MARKER}\n`;
let seen = 0;
let marked = false;

class Recorder extends BaseCallbackHandler {
  name = 'oa_definition_recorder';
  override handleChatModelStart(_llm: unknown, messages: unknown): void {
    seen += 1;
    marked ||= JSON.stringify(messages).includes(MARKER);
  }
  override handleLLMStart(_llm: unknown, prompts: unknown): void {
    seen += 1;
    marked ||= JSON.stringify(prompts).includes(MARKER);
  }
}

function plant(kind: string): void {
  if (kind.includes('context')) {
    registerConfigureHook({ contextVar: 'oa_definition_hook' });
    setContextVariable('oa_definition_hook', new Recorder());
  } else if (kind.includes('env')) {
    process.env['OA_DEFINITION_HOOK_PROBE'] = 'true';
    registerConfigureHook({ envVar: 'OA_DEFINITION_HOOK_PROBE', handlerClass: Recorder as never });
  }
}

async function main(kind: string): Promise<Record<string, unknown>> {
  const run = scripted((n) => (n === 1 ? reads(1) : final(2)));
  const definition = {
    path: 'AGENTS.md',
    digest: createHash('sha256').update(TEXT, 'utf8').digest('hex'),
    text: TEXT,
  };
  const state = attemptState(TASK, 3, ['task.read'], definition);
  plant(kind);
  const attempt = async (): Promise<string> => {
    const end = await runAttempt(state, run.ports, 3, 'Draft the reply.');
    if (kind.includes('tracing')) {
      await awaitAllCallbacks();
      await sleep(1500);
    }
    return end.outcome === 'success' ? 'ran' : end.endCode;
  };
  const result = kind.includes('isolated')
    ? await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, attempt)
    : await attempt();
  // Booleans only: the marker itself is never printed.
  const delivered = run.sent.some((turn) => JSON.stringify(turn.parts).includes(MARKER));
  return { result, seen, marked, sent: run.sent.length, ended: run.ended, delivered };
}

process.stdout.write(`${JSON.stringify(await main(process.argv[2] ?? ''))}\n`);
