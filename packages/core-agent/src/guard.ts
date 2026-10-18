// SPDX-License-Identifier: AGPL-3.0-only
//
// No tracing, inherited or explicit, and no verbose output (#1623 R4, design
// R9). Pinned core adds a handler to a model call in four ways: an
// environment flag, a run tree it inherits, callbacks in the call's options or
// its inherited config, and a configure hook, whose registry is itself a
// context variable in LangChain's async store. A hook installs its handler
// when its context variable holds one, or when its own environment flag is
// "true", so no list of flags is enough on its own.
//
// Two parts, and each model entry relies on neither the network denial nor
// the import ban:
// - Refuse. The runner refuses before it builds the graph when a flag is set
//   or the store is anything but empty, and every model entry refuses at
//   `generate`, which `invoke`, `batch`, `stream` and every binding reach
//   before core configures callbacks, when a handler, a context variable or a
//   tracing run tree is there. LangGraph's own internal context passes: it
//   carries a run tree with tracing off and no context variable.
// - Isolate. The runner computes the whole step inside a fresh store, so no
//   hook registered outside it is seen inside.
//
// `@langchain/core/context`, where hooks and context variables are written,
// is imported nowhere (`.dependency-cruiser.cjs`).

import {
  _CONTEXT_VARIABLES_KEY,
  AsyncLocalStorageProviderSingleton,
} from '@langchain/core/singletons';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';

/** The flags core reads to trace or print a call; any value refuses, not only "true". */
export const TRACING_FLAGS: readonly string[] = [
  'LANGSMITH_TRACING',
  'LANGSMITH_TRACING_V2',
  'LANGCHAIN_TRACING',
  'LANGCHAIN_TRACING_V2',
  'LANGCHAIN_VERBOSE',
];

type Store = Readonly<Record<string | symbol, unknown>> | undefined;

const store = (): Store => AsyncLocalStorageProviderSingleton.getInstance().getStore() as Store;

/** How many handlers a callbacks value carries: a list, or a manager's own and inherited. */
export function handlersIn(callbacks: unknown): number {
  if (callbacks === undefined || callbacks === null) return 0;
  if (Array.isArray(callbacks)) return callbacks.length;
  const manager = callbacks as { handlers?: unknown; inheritableHandlers?: unknown };
  const own = Array.isArray(manager.handlers) ? manager.handlers.length : 1;
  const inherited = Array.isArray(manager.inheritableHandlers)
    ? manager.inheritableHandlers.length
    : 0;
  return own + inherited;
}

/** Before the graph is built and before each invoke: a flag set, or any store at all. */
export function runRefused(env: Readonly<Record<string, string | undefined>>): boolean {
  return TRACING_FLAGS.some((flag) => env[flag] !== undefined) || store() !== undefined;
}

/**
 * At a model entry: explicit or inherited handlers, verbose output, a context
 * variable of any key (the hook registry or a hook's handler), or a run tree
 * that traces.
 */
export function entryRefused(options: unknown, callbacks?: unknown): boolean {
  const asked = (options ?? {}) as { callbacks?: unknown; verbose?: unknown };
  if (asked.verbose !== undefined && asked.verbose !== false) return true;
  if (handlersIn(asked.callbacks) > 0 || handlersIn(callbacks) > 0) return true;
  const inherited = AsyncLocalStorageProviderSingleton.getRunnableConfig() as
    { callbacks?: unknown } | undefined;
  if (handlersIn(inherited?.callbacks) > 0) return true;
  const variables = store()?.[_CONTEXT_VARIABLES_KEY];
  if (variables !== undefined && variables !== null && Reflect.ownKeys(variables).length > 0) {
    return true;
  }
  return LangChainTracer.getTraceableRunTree()?.tracingEnabled === true;
}

/** Runs `step` in a fresh store: no context variable, so no configure hook, reaches inside. */
export const isolated = async <T>(step: () => Promise<T>): Promise<T> =>
  await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, step);
