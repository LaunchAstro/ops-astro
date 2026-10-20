// SPDX-License-Identifier: AGPL-3.0-only
//
// `automation.registry` (C33): Settings ▸ Workflow triggers. Each definition
// with its released versions and the activations pinned to them, so the
// screen shows every automation's mode and pinned version from one read. The
// envelope has checked `settings:read` business-wide; row security keeps every
// statement to the caller's business. `automation.history` (#1741), below, is
// one activation's occurrences and changes under the same key.

import {
  activationExists,
  isUuid,
  listActivationHistory,
  listRegistry,
  type ActivationHistoryCursor,
  type ActivationHistoryRow,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type {
  AutomationHistoryEntry,
  AutomationHistoryResult,
  AutomationRegistryResult,
} from '../../../core-wire/src/index.ts';
import { invalid } from '../commands/operands.ts';
import { refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import type { Parsed } from './read-row.ts';
import type { HistoryOperands } from './history-operands.ts';

export async function readAutomationRegistry(tx: TenantQuery): Promise<AutomationRegistryResult> {
  const { definitions, versions, activations } = await listRegistry(tx);
  return {
    ok: true,
    definitions: definitions.map(({ id, kind, name }) => ({
      id,
      kind,
      name,
      versions: versions
        .filter((version) => version.definitionId === id)
        .map(({ definitionId: _definition, ...version }) => version),
      activations: activations
        .filter((activation) => activation.definitionId === id)
        .map(({ definitionId: _definition, ...activation }) => activation),
    })),
  };
}

/** An activation's history comes 50 entries a page (#1741). */
export const HISTORY_PAGE = 50;

const ACTIVATION_FIX = 'Send activationId as the activation’s identifier.';
const CURSOR_FIX = 'Send cursor as the next value a page of this history gave, or leave it out.';

/** A cursor's time: to the microsecond, in UTC, as the history statement writes it. */
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;

/** The cursor naming the page after `last`: its time and id, base64url so it reads as one token. */
function cursorOf(last: ActivationHistoryRow): string {
  return Buffer.from(`${last.atKey}|${last.id}`, 'utf8').toString('base64url');
}

/** A cursor a page gave, or undefined for anything else. */
function cursorFrom(value: string): ActivationHistoryCursor | undefined {
  const [at = '', id = '', ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (rest.length > 0 || !CURSOR_AT.test(at) || Number.isNaN(Date.parse(at)) || !isUuid(id)) {
    return undefined;
  }
  return { at, id };
}

/**
 * `automation.history`'s body: the activation, as a string (whether it is one
 * of this business's is the read's question, so any string is looked up), and
 * a cursor only as a page gave it.
 */
export function parseHistoryOperands(
  body: Readonly<Record<string, unknown>>,
): Parsed<'automation.history'> {
  const { activationId, cursor } = body;
  if (typeof activationId !== 'string') {
    return { ok: false, refusal: invalid('activationId', ACTIVATION_FIX) };
  }
  if (cursor === undefined) return { ok: true, operands: { activationId } };
  const after = typeof cursor === 'string' ? cursorFrom(cursor) : undefined;
  if (after === undefined) return { ok: false, refusal: invalid('cursor', CURSOR_FIX) };
  return { ok: true, operands: { activationId, cursor: after } };
}

function entryOf(row: ActivationHistoryRow): AutomationHistoryEntry {
  const at = row.at.toISOString();
  if (row.kind === 'occurrence') {
    return {
      kind: 'occurrence',
      id: row.id,
      at,
      cause:
        row.dueAt === null
          ? { kind: 'event' }
          : { kind: 'scheduled', dueAt: row.dueAt.toISOString() },
      outcome: String(row.outcome),
      dispatch: row.dispatch,
      runId: row.runId,
    };
  }
  return {
    kind: 'change',
    id: row.id,
    at,
    command: String(row.command),
    actorId: String(row.actorId),
    actorKind: row.actorKind,
    actorName: row.actorName,
  };
}

/**
 * `automation.history` (#1741): one activation's occurrences and changes,
 * newest first, a page at a time. The envelope has checked `settings:read`
 * business-wide; another business's activation, or none, is NOT_FOUND on
 * `activationId` alike, naming nothing.
 */
export async function readAutomationHistory(
  tx: TenantQuery,
  operands: HistoryOperands,
): Promise<AutomationHistoryResult | CommandRefusal> {
  const { activationId, cursor } = operands;
  if (!isUuid(activationId) || !(await activationExists(tx, activationId))) {
    return refuseNotFound(['activationId']);
  }
  const rows = await listActivationHistory(tx, activationId, cursor, HISTORY_PAGE + 1);
  const page = rows.slice(0, HISTORY_PAGE);
  const last = page.at(-1);
  return {
    ok: true,
    entries: page.map((row) => entryOf(row)),
    next: rows.length > HISTORY_PAGE && last !== undefined ? cursorOf(last) : null,
  };
}
