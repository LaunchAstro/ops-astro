// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5, the gate's own commands (migration 0059), each a person's under
// `operations:manage` in the business that operates the installation:
// `operations.record_gate_item` ticks one item with its https evidence link
// (`gate item recorded`), a closing line with the owner's one line too (0060),
// and `operations.change_installation_mode` moves the
// installation from made-up to real data while every item is done
// (`installation mode changed`).
//
// Items 3 to 6 take one evidence link only: the link to their document's
// published version in the operator's business (C81), read under the same
// lock, with the breach runbook held to one page.
//
// Both take the installation's row lock first and check the operator under
// it, so a refusal writes nothing. Every field is checked here, before the
// table's own constraint could refuse it as a driver error carrying the
// statement's parameters. The one-way trigger still refuses whatever reaches
// it out of turn.

import {
  legalVersionPath,
  ONE_PAGE_WORDS,
  readPublishedLegal,
  wordsIn,
} from '../../../core-records/src/index.ts';
import type { LegalDocument, TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { GATE_ITEMS } from './first-client-gate.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';
import type { CommandRequest } from './requests.ts';

type RecordRequest = CommandRequest & { readonly command: 'operations.record_gate_item' };
type ChangeRequest = CommandRequest & { readonly command: 'operations.change_installation_mode' };

const ITEMS: ReadonlySet<string> = new Set(GATE_ITEMS);
/** As 0058's `gate_items_evidence_link` reads it. */
const EVIDENCE = /^https:\/\/[^\s]+$/u;
/** The OAIC's public Privacy Opt-In Register lists its entries on this one page (0060). */
const OPT_IN_REGISTER =
  /^https:\/\/www\.oaic\.gov\.au\/privacy\/privacy-registers\/privacy-opt-in-register\/?([?#]\S*)?$/u;
/**
 * Items 3 to 6 and the document whose published version is their evidence:
 * the privacy policy with its collection notices, and as it reads the
 * overseas-services register; the data-handling statement; the breach runbook.
 */
const GATE_EVIDENCE_DOCUMENTS: Readonly<Partial<Record<string, LegalDocument>>> = {
  'legal-basics': 'privacy-policy',
  'privacy-act-statement': 'data-handling',
  'overseas-register': 'privacy-policy',
  'breach-runbook': 'breach-runbook',
};
/** The owner's one line on a closing line, as 0060's `gate_items_statement` reads it. */
const LINE = /^[^\p{Cc}]{1,500}$/u;
const CLOSING_LINES: ReadonlySet<string> = new Set([
  'privacy-opt-in',
  'cloudflare-rolled',
  'training-line',
]);

/** A real calendar date in the line, as the training line must carry. */
function dated(line: string): boolean {
  return (line.match(/\d{4}-\d{2}-\d{2}/gu) ?? []).some((day) => {
    const time = Date.parse(`${day}T00:00:00Z`);
    return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === day;
  });
}

const FIXES: Readonly<Record<string, readonly string[]>> = {
  item: [`Send one of: ${GATE_ITEMS.join(', ')}.`],
  evidence: [
    'Send the evidence as one https link of at most 2000 characters, with no spaces.',
    "For the privacy opt-in, a lodged form or a receipt keeps it shut: link the OAIC's public Privacy Opt-In Register.",
    `For items 3 to 6, link the published version of the item's document, approved by the owner; the breach runbook fits on one page (${String(ONE_PAGE_WORDS)} words).`,
  ],
  statement: [
    "Send the owner's one line (at most 500 characters) on a closing line only; the training line's is dated YYYY-MM-DD.",
  ],
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

/**
 * Whether `evidence` links the published version of `document` in the
 * caller's business, where the breach runbook also fits on one page. The host
 * is the installation's own and is not checked; the path, version and digest
 * are.
 */
async function linksPublished(
  tx: TenantQuery,
  document: LegalDocument,
  evidence: string,
): Promise<boolean> {
  const published = await readPublishedLegal(tx, document);
  if (published === undefined) return false;
  if (document === 'breach-runbook' && wordsIn(published.body) > ONE_PAGE_WORDS) return false;
  const [business] = await tx.query<{ readonly key: string }>(
    'select key from public.businesses where business_id = $1 and id = $1',
    [tx.businessId],
  );
  const url = URL.canParse(evidence) ? new URL(evidence) : undefined;
  return (
    business !== undefined &&
    url !== undefined &&
    `${url.pathname}${url.search}` === legalVersionPath(business.key, published)
  );
}

const isOutcome = (value: Installation | HandlerOutcome): value is HandlerOutcome =>
  !('operator_business_id' in value);

export async function recordGateItem(
  tx: TenantQuery,
  context: CommandContext,
  request: RecordRequest,
): Promise<HandlerOutcome> {
  const { item, evidence, statement } = request;
  if (typeof item !== 'string' || !ITEMS.has(item)) return invalid('item');
  if (typeof evidence !== 'string' || evidence.length > 2000 || !EVIDENCE.test(evidence)) {
    return invalid('evidence');
  }
  if (item === 'privacy-opt-in' && !OPT_IN_REGISTER.test(evidence)) return invalid('evidence');
  const closing = CLOSING_LINES.has(item);
  if (closing ? typeof statement !== 'string' || !LINE.test(statement) : statement !== undefined) {
    return invalid('statement');
  }
  if (item === 'training-line' && !dated(statement as string)) return invalid('statement');
  const installation = await lockedForOperator(tx, context);
  if (isOutcome(installation)) return installation;
  const document = GATE_EVIDENCE_DOCUMENTS[item];
  if (document !== undefined && !(await linksPublished(tx, document, evidence))) {
    return invalid('evidence');
  }
  const inserted = await tx.query<{ readonly item: string }>(
    `insert into ops.gate_items (item, evidence, statement) values ($1, $2, $3)
       on conflict (item) do nothing returning item`,
    [item, evidence, closing ? statement : null],
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
