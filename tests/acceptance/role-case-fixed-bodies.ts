// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's fixed recipes: the declarations whose minimal valid
// body is the same literal every time. `role-case-positive-body.ts` answers
// these before its switch; every body that needs a record made first stays
// there. The probe body's operands are here too.

import { randomUUID } from 'node:crypto';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { breachDrillBody } from './role-case-bodies.ts';

type Body = Readonly<Record<string, unknown>>;

// An empty body, and no `expectedRevision`: `business_settings` has no revision column,
// and `session.capabilities` reports the caller's own grants. The admin holds what each
// asks: `settings:read`, `access:manage` and `operations:read` (C55, INB-1e), and a live
// grant of any kind for `session.capabilities`, `client.list` (C32) and the inbox (INB-1d).
// The person menu's two (C23) and the caller's own preferences (MP-2-11a) are its own.
// The caller's own inbox (INB-1d) needs a live grant of any kind, as above;
// `inbox.unattended` needs `operations:read`, which the seed grants the admin (INB-1e, C55).
const EMPTY: readonly CommandName[] = [
  'task.queue',
  'person.list',
  'team.list',
  'settings.read',
  'session.capabilities',
  'session.person',
  'session.end',
  'preference.read',
  'access.read',
  'operations.read',
  'client.list',
  'inbox.read',
  'inbox.count',
  'inbox.unattended',
  // The reader's own to-dos (MP-7-1): no operand.
  'task.todos',
];

export const FIXED_BODIES: Readonly<Partial<Record<CommandName, Body>>> = {
  ...Object.fromEntries(EMPTY.map((name) => [name, {}])),
  'task.board': { board: null },
  'task.ledger': { timeZone: 'UTC' },
  'preference.save': { preference: 'appearance', value: 'dark' },
  'preference.dismiss_tip': { page: 'agency:inbox', tip: 'triage', version: 1 },
  // A word no audit row carries, so digest-only is checked on it.
  'task.search': { query: 'brochure' },
  // Self-scoped (INB-1e): in-app is always on, the one mode it takes.
  'notifications.set_channel': { channel: 'in_app', mode: 'on' },
  'preset.plan': { recordTypeKey: 'task', presetKey: 'acceptance', fields: [] },
  'settings.set_four_eyes_threshold': { value: 1200 },
  'settings.set_client_sign_off': { value: true },
  'settings.set_money_step_up': { value: true },
  // Inside C122-1's bounds whichever runs first: seven or more, and the
  // retention window never below the conversation window.
  'settings.set_conversation_window': { value: 14 },
  'settings.set_retention_window': { value: 90 },
};

/** The reads' own operands, which the probe body sends as the positive body does. */
const READ_OPERANDS: readonly CommandName[] = [
  'task.board',
  'task.search',
  'task.ledger',
  'preset.plan',
];

/**
 * The operands the probe body (`role-case-harness.ts`) adds beyond its record
 * and revision, so a refusal it measures is authority's and not the body's.
 */
export function probeOperands(name: CommandName): Body {
  if (READ_OPERANDS.includes(name)) return FIXED_BODIES[name] ?? {};
  if (name === 'task.receipt') return { attemptId: randomUUID() };
  if (name === 'task.set_state') return { stateId: randomUUID() };
  if (name === 'privacy.draft_breach_notices') return breachDrillBody();
  return {};
}
