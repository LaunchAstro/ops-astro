// SPDX-License-Identifier: AGPL-3.0-only
// The timing-failure rule's API with no rule behind it (#1857), so its proofs
// go red on behaviour, not on a missing import. The next commit replaces it.

export interface QuarantineEntry {
  readonly test: string;
  readonly owner: string;
  readonly ticket: number;
  readonly timing: readonly number[];
}
export type TicketState = 'open' | 'closed' | 'pull request' | 'missing' | 'unreadable';
export const readQuarantine = (text: string, _suites: unknown, _today: string): QuarantineEntry[] =>
  (JSON.parse(text) as { tests: QuarantineEntry[] }).tests;
export const activeEntries = (
  entries: readonly QuarantineEntry[],
  _today: string,
  _states: unknown,
): { active: QuarantineEntry[]; notes: string[] } => ({ active: [...entries], notes: [] });
export const ticketState = (_response?: unknown): TicketState => 'open';
export const readRulePlan = (text: string): unknown => JSON.parse(text);
export const touchedBy = (_root: string, suite: string, changed: readonly string[]): boolean =>
  changed.includes(suite);
