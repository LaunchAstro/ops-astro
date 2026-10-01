// SPDX-License-Identifier: AGPL-3.0-only
//
// The local ledger (LA-1, addendum 2): one JSON line per call, appended, with
// the API-equivalent cost Claude Code reports for it. A personal subscription
// spends no money, so this is what stands in for spend: the total is checked
// against the cap before every call, and the cap stops the run.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Seat } from './settings.ts';

export interface LedgerRow {
  readonly at: string;
  readonly seat: Seat;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

const ledgerFile = (home: string): string => join(home, 'ledger.jsonl');

/** Every call's cost so far. An unreadable line counts as the whole cap would: never as nothing. */
export function ledgerTotal(home: string, capUsd: number): number {
  let text: string;
  try {
    text = readFileSync(ledgerFile(home), 'utf8');
  } catch {
    return 0;
  }
  let total = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let cost: unknown;
    try {
      cost = (JSON.parse(line) as Record<string, unknown>)['costUsd'];
    } catch {
      return capUsd;
    }
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return capUsd;
    total += cost;
  }
  return total;
}

export function appendLedger(home: string, row: LedgerRow): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(ledgerFile(home), `${JSON.stringify(row)}\n`);
}
