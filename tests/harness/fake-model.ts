// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12, part one: FP-M, the replay model provider every harness entry shares
// (TEST.md 4.1). Deterministic replay, not a stub and not a small model: a
// request is canonicalised and digested, and the answer is the one a pinned
// script records against that digest. An unscripted digest is a typed
// refusal, never an improvised answer.
//
// It declares the replay provider's window (`REPLAY_MODEL_WINDOW`), counts a
// request in the unit the trigger reads (one per UTF-8 byte), and refuses one
// past the window with the overflow size. Usage is priced by the replay
// provider's own book (`replayCostMinor`). The hostile modes are switched on
// the fixture handle only: the client an entry is handed has no switch, so
// the no-usage mode is never reachable from an entry's configuration.

import { createHash } from 'node:crypto';
import { REPLAY_MODEL_WINDOW, replayCostMinor } from '../../packages/core-connectors/src/index.ts';
import type { FakeClock } from './fake-clock-corpus.ts';

export type FakeModelMode =
  | 'answer'
  | 'no_usage'
  | 'slow'
  | 'silent'
  | 'refuse_with_code'
  | 'refuse_without_code'
  | 'schema_fail';

export interface ModelRequest {
  readonly model: string;
  readonly input: string;
}

export interface Usage {
  readonly inputUnits: number;
  readonly outputUnits: number;
  readonly priceMinor: number;
}

export type ModelReply =
  | { readonly kind: 'answer'; readonly text: string; readonly usage: Usage | null }
  | { readonly kind: 'overflow'; readonly overflowUnits: number }
  | { readonly kind: 'unscripted'; readonly digest: string }
  | { readonly kind: 'provider_refusal'; readonly providerCode: string | null }
  | { readonly kind: 'malformed'; readonly body: unknown };

export interface ScriptLine {
  readonly input: string;
  readonly text: string;
  readonly outputUnits: number;
}

export interface ModelClient {
  readonly window: { readonly model: string; readonly contextUnits: number };
  complete(request: ModelRequest): Promise<ModelReply>;
}

export interface ModelFixture {
  mode(next: FakeModelMode): void;
  readonly seen: readonly string[];
}

/** How long a slow answer takes on the controlled clock. */
export const SLOW_MS = 30_000;

export const unitsOf = (text: string): number => Buffer.byteLength(text, 'utf8');

export const digestOf = (request: ModelRequest): string =>
  createHash('sha256')
    .update(JSON.stringify({ input: request.input, model: request.model }), 'utf8')
    .digest('hex');

function scripted(
  script: ReadonlyMap<string, ScriptLine>,
  request: ModelRequest,
  mode: FakeModelMode,
): ModelReply {
  const digest = digestOf(request);
  const line = script.get(digest);
  if (line === undefined) return { kind: 'unscripted', digest };
  if (mode === 'refuse_with_code') return { kind: 'provider_refusal', providerCode: 'refused' };
  if (mode === 'refuse_without_code') return { kind: 'provider_refusal', providerCode: null };
  if (mode === 'schema_fail') return { kind: 'malformed', body: { text: 7, usage: 'lots' } };
  const inputUnits = unitsOf(request.input);
  const priced = {
    text: line.text,
    model: request.model,
    usage: { inputUnits, outputUnits: line.outputUnits },
    providerCode: null,
  };
  const usage = { ...priced.usage, priceMinor: replayCostMinor(priced) };
  return { kind: 'answer', text: line.text, usage: mode === 'no_usage' ? null : usage };
}

/** FP-M over a pinned script, reading the controlled clock for its slow mode. */
export function fakeModel(
  lines: readonly ScriptLine[],
  clock: FakeClock,
): { readonly client: ModelClient; readonly fixture: ModelFixture } {
  const window = REPLAY_MODEL_WINDOW;
  const script = new Map(lines.map((line) => [digestOf({ model: window.model, ...line }), line]));
  const seen: string[] = [];
  let mode: FakeModelMode = 'answer';
  const client: ModelClient = {
    window,
    complete: async (request) => {
      seen.push(digestOf(request));
      const units = unitsOf(request.input);
      if (units > window.contextUnits) {
        return { kind: 'overflow', overflowUnits: units - window.contextUnits };
      }
      if (mode === 'silent') {
        // Never answers: the promise is never settled.
        return await new Promise<never>(() => {
          /* silence */
        });
      }
      if (mode === 'slow') await clock.until(clock.now() + SLOW_MS);
      return scripted(script, request, mode);
    },
  };
  return {
    client,
    fixture: {
      mode: (next) => {
        mode = next;
      },
      seen,
    },
  };
}
