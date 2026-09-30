// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5, the gate's own commands (migration 0060), each a person's under
// `operations:manage` in the business that operates the installation:
// `operations.record_gate_item` ticks one item with its https evidence link
// (`gate item recorded`), and `operations.change_installation_mode` moves the
// installation from made-up to real data while every item is done
// (`installation mode changed`).
//
// Both take the installation's row lock first and check the operator under
// it, so a refusal writes nothing. Every field is checked here, before the
// table's own constraint could refuse it as a driver error carrying the
// statement's parameters. The one-way trigger still refuses whatever reaches
// it out of turn.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { GATE_ITEMS } from './first-client-gate.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';
import type { CommandRequest } from './requests.ts';

type RecordRequest = CommandRequest & { readonly command: 'operations.record_gate_item' };
type ChangeRequest = CommandRequest & { readonly command: 'operations.change_installation_mode' };

const ITEMS: ReadonlySet<string> = new Set(GATE_ITEMS);
/** As 0056's `gate_items_evidence_link` reads it. */
const EVIDENCE = /^https:\/\/[^\s]+$/u;

const FIXES: Readonly<Record<string, readonly string[]>> = {
  item: [`Send one of: ${GATE_ITEMS.join(', ')}.`],
  evidence: ['Send the evidence as one https link of at most 2000 characters, with no spaces.'],
  mode: ["Send mode 'real': the only change an installation makes is from made-up to real data."],
};

const invalid = (field: string): HandlerOutcome =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [field], FIXES[field] ?? []));

interface Installation {
  readonly mode: string;
  readonly operator_business_id: string | null;
}

/** The installation under its row lock, or a refusal when the caller's business does not operate it. */
async function lockedForOperator(
  tx: TenantQuery,
  context: CommandContext,
): Promise<Installation | HandlerOutcome> {
  const [installation] = await tx.query<Installation>(
    'select mode, operator_business_id from ops.installation for update',
  );
  if (installation?.operator_business_id !== context.session.businessId) {
    return refused(
      refuseCommand(
        'SCOPE_NOT_GRANTED',
        ['operations:manage'],
        ['Only the business that operates this installation moves its first-client gate.'],
      ),
    );
  }
  return installation;
}

const isOutcome = (value: Installation | HandlerOutcome): value is HandlerOutcome =>
  !('operator_business_id' in value);

export async function recordGateItem(
  tx: TenantQuery,
  context: CommandContext,
  request: RecordRequest,
): Promise<HandlerOutcome> {
  const { item, evidence } = request;
  if (typeof item !== 'string' || !ITEMS.has(item)) return invalid('item');
  if (typeof evidence !== 'string' || evidence.length > 2000 || !EVIDENCE.test(evidence)) {
    return invalid('evidence');
  }
  const installation = await lockedForOperator(tx, context);
  if (isOutcome(installation)) return installation;
  const inserted = await tx.query<{ readonly item: string }>(
    `insert into ops.gate_items (item, evidence) values ($1, $2)
       on conflict (item) do nothing returning item`,
    [item, evidence],
  );
  if (inserted.length === 0) {
    return refused(
      refuseCommand(
        'GATE_ITEM_ALREADY_RECORDED',
        [item],
        ['This item is already done; its evidence stays as first recorded.'],
      ),
    );
  }
  return applied(null, null, { item });
}

export async function changeInstallationMode(
  tx: TenantQuery,
  context: CommandContext,
  request: ChangeRequest,
): Promise<HandlerOutcome> {
  const { mode } = request;
  if (mode !== 'real' && mode !== 'made-up') return invalid('mode');
  const installation = await lockedForOperator(tx, context);
  if (isOutcome(installation)) return installation;
  if (mode === 'made-up') {
    return refused(
      refuseCommand(
        'INSTALLATION_MODE_ONE_WAY',
        ['mode'],
        ['An installation moves one way only, from made-up to real data, and never back.'],
      ),
    );
  }
  if (installation.mode === 'real') return applied(null, null, { mode: 'real' });
  const [readiness] = await tx.query<{ readonly open_items: readonly string[] }>(
    'select open_items from public.first_client_readiness()',
  );
  const open = readiness?.open_items ?? GATE_ITEMS;
  if (open.length > 0) {
    return refused(
      refuseCommand('INSTALLATION_NOT_READY', open, [
        'Record every open item named here, each with its evidence link, then change the mode.',
      ]),
    );
  }
  await tx.query(`update ops.installation set mode = 'real'`);
  return applied(null, null, { mode: 'real' });
}
