// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12, part two: a framework as the product would host one, standing in for
// every candidate while the trigger reads "not yet" (TEST.md 2). It sits
// under the product's authority and is handed only what the product hands a
// worker: its settings, one model client, and tools by name. It keeps its own
// plan, todo and checkpoints in a store of its own, and has its own retry
// setting, which the product requires off.
//
// The authority proofs (`aw-12-authorities*.test.ts`) drive it against the
// product's boundary: whatever it tries on its own initiative (a resume, a
// compaction, a tool the catalogue does not name, a retry) must be refused
// there, never by the stand-in's good manners.

/** One reply from whatever model client the stand-in was handed. */
export type Reply = { readonly ok: true } | { readonly ok: false; readonly why: string };

export interface StandInConfig {
  /** The settings a worker is given (`apps/worker/main.ts`), as name and value. */
  readonly settings: Readonly<Record<string, string>>;
  /** The one model client. The product hands the broker's, never a provider's. */
  readonly model: (input: string) => Promise<unknown>;
  /** Tools the framework registered, by name; each runs through the product. */
  readonly tools: ReadonlyMap<string, (input: string) => Promise<unknown>>;
  /** How many times the framework would try a failed model call again. */
  readonly retries: number;
  /** Reads a reply: answered, or failed and so retryable by the framework's own policy. */
  readonly read: (reply: unknown) => Reply;
}

export interface StandIn {
  readonly config: StandInConfig;
  /** The framework's own state: plan, todo and checkpoints, never the product's task. */
  readonly store: Map<string, unknown>;
  plan(runId: string, todo: readonly string[]): void;
  /** Keep a checkpoint the framework's own resume path reads back. */
  checkpoint(runId: string, state: Readonly<Record<string, unknown>>): void;
  /** A model call the framework makes of its own accord (a compaction). */
  compact(runId: string): Promise<unknown>;
  /** A step's model call under the framework's own retry policy: how many calls it made. */
  step(input: string): Promise<{ readonly calls: number; readonly last: unknown }>;
  callTool(name: string, input: string): Promise<unknown>;
}

export function standIn(config: StandInConfig): StandIn {
  const store = new Map<string, unknown>();
  return {
    config,
    store,
    plan: (runId, todo) => {
      store.set(`plan:${runId}`, [...todo]);
    },
    checkpoint: (runId, state) => {
      store.set(`checkpoint:${runId}`, { ...state });
    },
    compact: async (runId) => {
      const plan = (store.get(`plan:${runId}`) ?? []) as readonly string[];
      return await config.model(`Compact the working notes: ${plan.join('; ')}`);
    },
    step: async (input) => {
      let calls = 0;
      let last: unknown;
      for (;;) {
        calls += 1;
        // oxlint-disable-next-line no-await-in-loop -- a retry follows its failure, by design
        last = await config.model(input);
        if (config.read(last).ok || calls > config.retries) return { calls, last };
      }
    },
    callTool: async (name, input) => {
      const tool = config.tools.get(name);
      if (tool === undefined) throw new Error(`the framework has no tool ${name}`);
      return await tool(input);
    },
  };
}
