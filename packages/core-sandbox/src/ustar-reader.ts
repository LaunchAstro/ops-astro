// SPDX-License-Identifier: AGPL-3.0-only
//
// Stub: the run output grammar (docs/plan/sandbox-contract.md, O1 and O2).

import type { Refused } from './refusal.ts';

export type OutputGrammar = 'build' | 'prepare';

export type TarEntry =
  | {
      readonly type: 'file';
      readonly name: string;
      readonly data: Uint8Array;
      readonly executable: boolean;
    }
  | { readonly type: 'directory'; readonly name: string }
  | { readonly type: 'symlink'; readonly name: string; readonly link: string };

export type OutputRead = { readonly ok: true; readonly entries: readonly TarEntry[] } | Refused;

export const OUTPUT_CAP = { S0: 1_000_000, S1: 50_000_000, S2: 1_000_000_000 } as const;

export class UstarReader {
  readonly grammar: OutputGrammar;
  readonly cap: number;

  constructor(grammar: OutputGrammar, cap: number) {
    this.grammar = grammar;
    this.cap = cap;
  }

  push(..._chunks: readonly Uint8Array[]): void {}

  end(): OutputRead {
    return { ok: true, entries: [] };
  }
}

export function readOutput(
  grammar: OutputGrammar,
  cap: number,
  ...chunks: readonly Uint8Array[]
): OutputRead {
  const reader = new UstarReader(grammar, cap);
  reader.push(...chunks);
  return reader.end();
}
