// SPDX-License-Identifier: AGPL-3.0-only
//
// The CQ-8 database suite's pure helpers: the wording rule's check and the
// lock classifier. They open no database, so a unit suite may import them;
// the database world is in `cq-8-world.ts`.

import { LEASE_WORDING } from '../../packages/core-runtime/src/lease-ownership.ts';

export const UUID: RegExp = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/** Every string inside `value`, at any depth, with the key it sat under. */
function stringsOf(value: unknown, key = ''): readonly { key: string; text: string }[] {
  if (typeof value === 'string') return [{ key, text: value }];
  if (Array.isArray(value)) return value.flatMap((item) => stringsOf(item, key));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([inner, item]) => stringsOf(item, inner));
  }
  return [];
}

/**
 * The wording rule: a lease refusal carries its code, the fixed lease wording
 * (`lease-ownership.ts`, `LEASE_WORDING`) and nothing else the caller did not
 * send. Every identifier and number must be one the caller sent, and every
 * other text must be a fixed one or a value the caller sent. Returns what the
 * refusal carries that the request did not.
 */
export function unsent(refusal: unknown, request: unknown): readonly string[] {
  const sent = JSON.stringify(request).toLowerCase();
  const text = JSON.stringify(refusal).toLowerCase();
  const ids = text.match(UUID) ?? [];
  const numbers = text.replaceAll(UUID, ' ').match(/\b\d+\b/gu) ?? [];
  const sentNumbers = new Set(sent.replaceAll(UUID, ' ').match(/\b\d+\b/gu) ?? []);
  const sentTexts = new Set(stringsOf(request).map((entry) => entry.text));
  const texts = stringsOf(refusal)
    .filter((entry) => entry.key !== 'code')
    .map((entry) => entry.text)
    .filter((entry) => !LEASE_WORDING.includes(entry) && !sentTexts.has(entry));
  return [
    ...ids.filter((id) => !sent.includes(id)),
    ...numbers.filter((n) => !sentNumbers.has(n)),
    ...texts,
  ];
}

/** One statement a recorded transaction sent, with its parameters. */
export interface Statement {
  readonly text: string;
  readonly parameters: readonly unknown[];
}

const ACQUIRED_ROW =
  /^select 1 from public\.(\w+) where business_id = \$1 and id = \$2 for update$/u;

/**
 * Which side of the order each statement of one transaction locks on, or null
 * when it takes no new lock. `ordered` is a lock `acquire` takes, the chain key
 * included. `command` is a new lock outside `LOCK_ORDER`, which must come
 * first: the command layer's advisory keys and target row, and the grant rows
 * an operation's authority rests on (`holdCoveringGrants`, `grant.revoke`). A
 * target row read `for update` after `acquire` already holds it (task.propose's
 * revision check, F1) is a lock the transaction has, not a new one: null.
 */
export function classifyAll(
  statements: readonly Statement[],
): readonly ('command' | 'ordered' | null)[] {
  const heldTasks = new Set<string>();
  return statements.map((statement) => {
    const key = String(statement.parameters[0]);
    if (statement.text.includes('pg_advisory_xact_lock')) {
      return /^[0-9a-f-]{36}:/u.test(key) ? 'ordered' : 'command';
    }
    const acquired = ACQUIRED_ROW.exec(statement.text);
    if (acquired !== null) {
      if (acquired[1] === 'records') heldTasks.add(String(statement.parameters[1]));
      return 'ordered';
    }
    if (/from records where .*for update/u.test(statement.text)) {
      return heldTasks.has(String(statement.parameters[2])) ? null : 'command';
    }
    if (/from public\.grants .*for (?:share|update)$/u.test(statement.text)) return 'command';
    return null;
  });
}
