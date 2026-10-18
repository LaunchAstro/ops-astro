// SPDX-License-Identifier: AGPL-3.0-only
//
// One #1623 R4 hook case, in a fresh process (`node agent-hook-case.ts <case>`).
// It plants a content recorder the way an inherited hook would, then calls
// the owned model or the runner, and prints booleans and counts only, so a
// failure never prints the planted marker. Run by
// `an-inherited-hook-or-tracer-never-sees-a-models-content.test.ts`.

// oxlint-disable max-classes-per-file -- a subclass is the one way to set a model's callbacks before it is built

import { setTimeout as sleep } from 'node:timers/promises';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { registerConfigureHook, setContextVariable } from '@langchain/core/context';
import { HumanMessage } from '@langchain/core/messages';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { tool } from '@langchain/core/tools';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { OpsAstroChatModel, runAttempt } from '../../packages/core-agent/src/index.ts';
import { final, reads, scripted } from './agent-ports.ts';

const MARKER = `OA-MARKER-${String(process.pid)}`;
let seen = 0;
let marked = false;

class Recorder extends BaseCallbackHandler {
  name = 'oa_recorder';
  override handleChatModelStart(_llm: unknown, messages: unknown): void {
    seen += 1;
    marked ||= JSON.stringify(messages).includes(MARKER);
  }
  override handleLLMStart(_llm: unknown, prompts: unknown): void {
    seen += 1;
    marked ||= JSON.stringify(prompts).includes(MARKER);
  }
}

const HOOK = 'oa_hook_handler';
const ENV_FLAG = 'OA_HOOK_PROBE';

function plant(kind: string): void {
  if (kind.startsWith('context')) {
    registerConfigureHook({ contextVar: HOOK });
    setContextVariable(HOOK, new Recorder());
  } else if (kind.startsWith('env')) {
    process.env[ENV_FLAG] = 'true';
    registerConfigureHook({ envVar: ENV_FLAG, handlerClass: Recorder as never });
  }
}

const readTool = tool(async () => await Promise.resolve('read'), {
  name: 'task.read',
  description: 'read',
  schema: { type: 'object' },
});

async function attempt(step: () => Promise<unknown>): Promise<string> {
  try {
    await step();
    return 'ran';
  } catch (error) {
    return (error as { endCode?: string }).endCode ?? 'threw';
  }
}

/** Call options whose callbacks read empty the first time and a recorder after. */
function readLate(): { callbacks?: Recorder[] } {
  let read = 0;
  return Object.defineProperty({}, 'callbacks', {
    enumerable: true,
    get: () => ((read += 1) === 1 ? undefined : [new Recorder()]),
  });
}

type Run = ReturnType<typeof scripted>;
type Cases = Record<string, () => Promise<unknown>>;

/** The runner to its end; anything but success throws its end, so its code is printed. */
async function ran(run: Run, settle: boolean): Promise<void> {
  const end = await runAttempt(run.state, run.ports, 3, undefined, MARKER);
  if (settle) {
    await awaitAllCallbacks();
    await sleep(1500);
  }
  if (end.outcome !== 'success') throw Object.assign(new Error('ended'), end);
}

/** The owned model's own entries, each with empty or hostile options. */
function modelCases(run: Run): Cases {
  const input = [new HumanMessage(MARKER)];
  const model = (): OpsAstroChatModel => new OpsAstroChatModel(run.ports.broker, run.state);
  const bound = async (): Promise<unknown> => await model().bindTools([readTool]).invoke(input, {});
  return {
    'context-direct': async () => await model().invoke(input, {}),
    'context-bound': bound,
    'env-direct': async () => await model().invoke(input, {}),
    'env-bound': bound,
    'none-constructed-with-callbacks': async () =>
      await new OpsAstroChatModel(run.ports.broker, run.state, {
        callbacks: [new Recorder()],
      }).invoke(input),
    'none-bound-with-callbacks': async () =>
      await model()
        .withConfig({ callbacks: [new Recorder()] })
        .invoke(input),
    'none-invoke-verbose': async () => await model().invoke(input, { verbose: true } as never),
    'none-invoke-callbacks': async () =>
      await model().invoke(input, { callbacks: [new Recorder()] }),
    'context-control-outside-the-agent': async () =>
      await new FakeListChatModel({ responses: ['ok'] }).invoke(input, {}),
    'tracing-control-outside-the-agent': async () => {
      await new FakeListChatModel({ responses: ['ok'] }).invoke(input, {});
      await awaitAllCallbacks();
      await sleep(1500);
    },
  };
}

/** Handlers reaching the owned model by its constructor, its call options or its own fields (#1921). */
function ownCases(run: Run): Cases {
  const input = [new HumanMessage(MARKER)];
  const model = (): OpsAstroChatModel => new OpsAstroChatModel(run.ports.broker, run.state);
  return {
    'none-constructed-with-callback-manager': async () =>
      await new OpsAstroChatModel(run.ports.broker, run.state, {
        callbackManager: [new Recorder()],
      }).invoke(input),
    'none-generate-callbacks-read-late': async () => await model().generate([input], readLate()),
    'none-own-callbacks-set-after-construction': async () => {
      const built = model();
      built.callbacks = [new Recorder()];
      return await built.invoke(input, {});
    },
    'none-own-callbacks-set-after-binding': async () => {
      const built = model();
      const binding = built.bindTools([readTool]);
      built.callbacks = [new Recorder()];
      return await binding.invoke(input, {});
    },
    'none-own-callbacks-set-before-construction': async () => {
      class Preset extends OpsAstroChatModel {
        override callbacks = [new Recorder()];
      }
      return await new Preset(run.ports.broker, run.state).invoke(input, {});
    },
    'none-own-verbose-set-after-construction': async () => {
      const built = model();
      built.verbose = true;
      return await built.invoke(input, {});
    },
  };
}

/** The runner, refusing a planted hook, or isolated in a fresh store. */
const runnerCases = (run: Run): Cases => ({
  'context-runner': async () => await ran(run, false),
  'env-runner-isolated': async () =>
    await AsyncLocalStorageProviderSingleton.getInstance().run(
      undefined,
      async () => await ran(run, false),
    ),
  'tracing-runner': async () => await ran(run, true),
  'none-clean-run': async () => await ran(run, true),
});

async function main(kind: string): Promise<Record<string, unknown>> {
  const run = scripted((n) => (n === 1 ? reads(1) : final(2)));
  plant(kind);
  const step = { ...modelCases(run), ...ownCases(run), ...runnerCases(run) }[kind];
  if (step === undefined) throw new Error('no such case');
  const result = await attempt(step);
  return { result, seen, marked, sent: run.sent.length, ended: run.ended };
}

process.stdout.write(`${JSON.stringify(await main(process.argv[2] ?? ''))}\n`);
