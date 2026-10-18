// SPDX-License-Identifier: AGPL-3.0-only
//
// No tracing, inherited or explicit, and no verbose output (#1623 R4, design
// R9). Pinned core adds a handler to a model call in four ways: an
// environment flag, a run tree it inherits, callbacks or verbose output in
// the call's options, its inherited config or the model's own fields, and a
// configure hook, whose registry is itself a
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
//   tracing run tree is there. The guard reads each value once, and passes
//   only plain values core cannot read differently later: a getter, a proxy
//   or a method of a value's own refuses. LangGraph's own internal context
//   passes: it carries a run tree with tracing off, an empty callback
//   manager and no context variable.
// - Isolate. The runner computes the whole step inside a fresh store, so no
//   hook registered outside it is seen inside.
//
// `@langchain/core/context`, where hooks and context variables are written,
// is imported nowhere (`.dependency-cruiser.cjs`).

import { types } from 'node:util';
import { CallbackManager } from '@langchain/core/callbacks/manager';
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

const UNSTEADY = Symbol('unsteady');

/** An own data property's value; an accessor, or no own property, is `UNSTEADY`. */
function own(holder: object, key: PropertyKey): unknown {
  const property = Object.getOwnPropertyDescriptor(holder, key);
  return property !== undefined && 'value' in property ? property.value : UNSTEADY;
}

/** A plain empty list: no proxy, no prototype or property of its own but its length. */
const emptyList = (value: unknown): boolean =>
  Array.isArray(value) &&
  !types.isProxy(value) &&
  Object.getPrototypeOf(value) === Array.prototype &&
  Reflect.ownKeys(value).length === 1 &&
  value.length === 0;

/**
 * Callbacks that hold no handler and read the same each time core reads them
 * (#1925): none, a plain empty list, or core's own callback manager whose
 * fields are plain values and whose lists are empty. A getter, a proxy, a
 * method of its own or any other shape refuses.
 */
export function holdsNoHandler(callbacks: unknown): boolean {
  if (callbacks === undefined || callbacks === null || emptyList(callbacks)) return true;
  if (typeof callbacks !== 'object' || types.isProxy(callbacks)) return false;
  if (Object.getPrototypeOf(callbacks) !== CallbackManager.prototype) return false;
  const fields = Reflect.ownKeys(callbacks).map((key) => own(callbacks, key));
  if (fields.some((field) => field === UNSTEADY || typeof field === 'function')) return false;
  return emptyList(own(callbacks, 'handlers')) && emptyList(own(callbacks, 'inheritableHandlers'));
}

/** The model's own `callbacks` and `verbose`, which core reads at each call: plain, empty and off. */
export function ownRefused(model: object): boolean {
  const callbacks = own(model, 'callbacks');
  const verbose = own(model, 'verbose');
  return callbacks === UNSTEADY || !holdsNoHandler(callbacks) || verbose !== false;
}

const flagged = (env: Readonly<Record<string, string | undefined>>): boolean =>
  TRACING_FLAGS.some((flag) => env[flag] !== undefined);

/** Before the graph is built and before each invoke: a flag set, or any store at all. */
export function runRefused(env: Readonly<Record<string, string | undefined>>): boolean {
  return flagged(env) || store() !== undefined;
}

/**
 * At a model entry, even with no runner: a flag set, explicit or inherited
 * handlers, verbose output, a context
 * variable of any key (the hook registry or a hook's handler), or a run tree
 * that traces.
 */
export function entryRefused(options: unknown, callbacks?: unknown): boolean {
  if (flagged(process.env)) return true;
  const asked = (options ?? {}) as { callbacks?: unknown; verbose?: unknown };
  if (asked.verbose !== undefined && asked.verbose !== false) return true;
  if (!holdsNoHandler(asked.callbacks) || !holdsNoHandler(callbacks)) return true;
  const inherited = AsyncLocalStorageProviderSingleton.getRunnableConfig() as
    { callbacks?: unknown } | undefined;
  if (!holdsNoHandler(inherited?.callbacks)) return true;
  const variables = store()?.[_CONTEXT_VARIABLES_KEY];
  if (variables !== undefined && variables !== null && Reflect.ownKeys(variables).length > 0) {
    return true;
  }
  return LangChainTracer.getTraceableRunTree()?.tracingEnabled === true;
}

/** Runs `step` in a fresh store: no context variable, so no configure hook, reaches inside. */
export const isolated = async <T>(step: () => Promise<T>): Promise<T> =>
  await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, step);
