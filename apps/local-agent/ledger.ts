// SPDX-License-Identifier: AGPL-3.0-only
//
// The local ledger (LA-1): one JSON line per call, appended, with the tokens
// Codex reports for it. The ChatGPT plan spends no money, so this is what
// stands in for spend: the total is checked against the cap before every
// call, and the cap stops the run.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LedgerRow {
  readonly at: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const ledgerFile = (home: string): string => join(home, 'ledger.jsonl');

const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Every call's tokens so far. An unreadable line counts as the whole cap would: never as nothing. */
export function ledgerTotal(home: string, capTokens: number): number {
  let text: string;
  try {
    text = readFileSync(ledgerFile(home), 'utf8');
  } catch (error) {
    // No ledger yet is nothing used; a ledger that cannot be read is the cap.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : capTokens;
  }
  let total = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return capTokens;
    }
    if (row === null || typeof row !== 'object') return capTokens;
    const { inputTokens, outputTokens } = row as Record<string, unknown>;
    if (!whole(inputTokens) || !whole(outputTokens)) return capTokens;
    total += inputTokens + outputTokens;
  }
  return total;
}

export function appendLedger(home: string, row: LedgerRow): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(ledgerFile(home), `${JSON.stringify(row)}\n`, { mode: 0o600 });
}
