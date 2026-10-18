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
import { CallbackManager } from '@langchain/core/callbacks/manager';
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
const readLate = (): { callbacks?: Recorder[] } =>
  Object.defineProperty({}, 'callbacks', {
    enumerable: true,
    get: lateRead(undefined, [new Recorder()]),
  });

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
    'none-own-callbacks-set-after-construction': async () =>
      await Object.assign(model(), { callbacks: [new Recorder()] }).invoke(input, {}),
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
    'none-own-verbose-set-after-construction': async () =>
      await Object.assign(model(), { verbose: true }).invoke(input, {}),
  };
}

/** Values that read one way to the guard and another to core (#1925). */
function twoReadCases(run: Run): Cases {
  const input = [new HumanMessage(MARKER)];
  const model = (): OpsAstroChatModel => new OpsAstroChatModel(run.ports.broker, run.state);
  return {
    'none-own-verbose-read-late': async () => {
      const built = model();
      Object.defineProperty(built, 'verbose', { get: lateRead(false, true) });
      return await built.invoke(input, {});
    },
    'none-generate-manager-handlers-read-late': async () => {
      const manager = new CallbackManager();
      Object.defineProperty(manager, 'handlers', { get: lateRead([], [new Recorder()], 2) });
      return await model().generate([input], { callbacks: manager });
    },
    'none-invoke-empty-list-with-its-own-map': async () => {
      const list = Object.defineProperty([], 'map', { value: () => [new Recorder()] });
      return await model().invoke(input, { callbacks: list });
    },
    'none-generate-empty-list-behind-a-proxy': async () => {
      let read = 0;
      const list = new Proxy([] as Recorder[], {
        get: (target, key) =>
          key === 'length' && (read += 1) > 1
            ? 1
            : key === '0'
              ? new Recorder()
              : target[key as never],
        has: (target, key) => key === '0' || key in target,
      });
      return await model().generate([input], { callbacks: list });
    },
  };
}

/** Caller code core runs between the guard and its callbacks: a cache getter, a message getter. */
function afterGuardCases(run: Run): Cases {
  const model = (): OpsAstroChatModel => new OpsAstroChatModel(run.ports.broker, run.state);
  const cacheGetter = (key: 'callbacks' | 'verbose', value: unknown) => async () => {
    const built = model();
    Object.defineProperty(built, 'cache', {
      get: () => {
        Object.assign(built, { [key]: value });
        return null;
      },
    });
    return await built.invoke([new HumanMessage(MARKER)], {});
  };
  return {
    'none-own-cache-getter-sets-callbacks-after-the-guard': cacheGetter('callbacks', [
      new Recorder(),
    ]),
    'none-own-cache-getter-sets-verbose-after-the-guard': cacheGetter('verbose', true),
    'none-generate-message-getter-fills-the-list-after-the-guard': async () => {
      const list: Recorder[] = [];
      const message = {
        role: 'user',
        get content() {
          list.push(new Recorder());
          return MARKER;
        },
      };
      return await model().generate([[message as never]], { callbacks: list });
    },
  };
}

/** Caller code core runs after the guard that plants a configure hook. */
function hookAfterGuardCases(run: Run): Cases {
  const model = (): OpsAstroChatModel => new OpsAstroChatModel(run.ports.broker, run.state);
  /** A hook planted at the `nth` read and never again. */
  const plantAt = (nth: number) => {
    let read = 0;
    return (): void => {
      if ((read += 1) !== nth) return;
      registerConfigureHook({ contextVar: HOOK });
      setContextVariable(HOOK, new Recorder());
    };
  };
  /** A message whose own type accessor plants a hook at its `nth` read. */
  const typePlanted = (nth: number) => async () => {
    const plantHook = plantAt(nth);
    const message = new HumanMessage(MARKER);
    const typeKey = '_getType';
    const ownType = message[typeKey].bind(message);
    Object.defineProperty(message, typeKey, {
      get: () => {
        plantHook();
        return ownType;
      },
    });
    return await model().generate([[message]], {});
  };
  return {
    'none-generate-message-type-getter-plants-a-hook': typePlanted(2),
    'none-generate-message-type-getter-plants-a-hook-at-cores-last-read': typePlanted(3),
    'none-invoke-metadata-getter-plants-a-hook': async () =>
      await model().invoke([new HumanMessage(MARKER)], {
        metadata: Object.defineProperty({}, 'x', { enumerable: true, get: plantAt(1) }),
      }),
    'none-inherited-manager-metadata-getter-plants-a-hook': async () => {
      const manager = new CallbackManager();
      manager.metadata = Object.defineProperty({}, 'x', { enumerable: true, get: plantAt(2) });
      return await AsyncLocalStorageProviderSingleton.runWithConfig(
        { callbacks: manager },
        async () => await model().invoke([new HumanMessage(MARKER)]),
      );
    },
    'none-invoke-configurable-getter-plants-a-hook': async () =>
      await model().invoke([new HumanMessage(MARKER)], {
        configurable: Object.defineProperty({}, 'model', { enumerable: true, get: plantAt(1) }),
      }),
  };
}

/** A getter that reads `first` for its first `times` reads and `after` from then on. */
function lateRead<T>(first: T, after: T, times = 1): () => T {
  let read = 0;
  return () => ((read += 1) <= times ? first : after);
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
  const step = {
    ...modelCases(run),
    ...ownCases(run),
    ...twoReadCases(run),
    ...afterGuardCases(run),
    ...hookAfterGuardCases(run),
    ...runnerCases(run),
  }[kind];
  if (step === undefined) throw new Error('no such case');
  const result = await attempt(step);
  return { result, seen, marked, sent: run.sent.length, ended: run.ended };
}

process.stdout.write(`${JSON.stringify(await main(process.argv[2] ?? ''))}\n`);
