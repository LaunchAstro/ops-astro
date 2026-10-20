// SPDX-License-Identifier: AGPL-3.0-only
//
// #1925 (S1925-2) cases for `agent-hook-case.ts`: a message batch whose own
// `map` or iterator, or a proxy element, would run inside core after the
// model's last check. Each plants its hook only inside core's last step
// before it configures callbacks, read from the call stack, so reading the
// batch before the guard plants nothing, and a batch core reads again would.

import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { registerConfigureHook, setContextVariable } from '@langchain/core/context';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { OpsAstroChatModel } from '../../packages/core-agent/src/index.ts';
import type { Scripted } from './agent-ports.ts';

const BATCH_HOOK = 'oa_batch_hook';

/** True inside core's last step before it configures callbacks. */
const inCoresLastStep = (): boolean => /_generateUncached/u.test(String(new Error().stack));

/** The batch cases, each a model call whose recorder must never see content. */
export function batchCases(
  run: Scripted,
  marker: string,
  recorder: () => BaseCallbackHandler,
): Record<string, () => Promise<unknown>> {
  const planting = (): void => {
    if (!inCoresLastStep()) return;
    registerConfigureHook({ contextVar: BATCH_HOOK });
    setContextVariable(BATCH_HOOK, recorder());
  };
  class Batch<T> extends Array<T> {
    override map<U>(fn: (value: T, index: number, array: T[]) => U, thisArg?: unknown): U[] {
      planting();
      // oxlint-disable-next-line unicorn/no-array-callback-reference -- the caller's own callback, passed on
      return super.map(fn, thisArg);
    }

    override [Symbol.iterator](): ArrayIterator<T> {
      planting();
      return super[Symbol.iterator]();
    }
  }
  const list = (): Batch<BaseMessage> => {
    const messages = new Batch<BaseMessage>();
    messages.push(new HumanMessage(marker));
    return messages;
  };
  const model = (): OpsAstroChatModel => new OpsAstroChatModel(run.ports.broker, run.state);
  return {
    'none-generate-batch-subclass-plants-a-hook': async () => {
      const batch = new Batch<BaseMessage[]>();
      batch.push(list());
      return await model().generate(batch);
    },
    'none-generate-proxy-element-plants-a-hook': async () => {
      const element = new Proxy(list(), {
        get: (target, key, receiver): unknown => {
          planting();
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      return await model().generate([element]);
    },
  };
}
