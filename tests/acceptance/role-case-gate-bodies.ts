// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipes for S0-5's gate commands, split from
// `role-case-positive-body.ts` to keep it under the per-file cap. An item is
// recorded once per installation, so the recipe cycles through them all and,
// where the harness can, has the owner clear the item first so its record
// applies. The mode change needs every item done, so it records them all
// once, and again after any clear.

import { randomUUID } from 'node:crypto';
import { GATE_ITEMS } from '../../packages/core-commands/src/index.ts';
import type { BodyContext, Prepared } from './role-case-bodies.ts';

type GateCommand = 'operations.record_gate_item' | 'operations.change_installation_mode';

const evidence = (item: string): string => `https://evidence.example/${item}/${randomUUID()}`;

/** The OAIC's public Privacy Opt-In Register, which lists its entries on the one page. */
export const OPT_IN_REGISTER =
  'https://www.oaic.gov.au/privacy/privacy-registers/privacy-opt-in-register';

/** Made-up owner's lines for the three closing lines (S0-5); the eight items carry none. */
export const OWNER_LINES: Readonly<Record<string, string>> = {
  'privacy-opt-in': 'The published privacy policy matches the register entry.',
  'cloudflare-rolled': "The new credential is in the vault item's password field only.",
  'training-line': 'Model training switched off on both model accounts, 2026-09-28.',
};

/**
 * The evidence link for a published legal version (C81): the public page for
 * the three public documents, the operations view for the breach runbook,
 * each pinned to the version and its digest.
 */
export function versionLink(
  key: string,
  document: string,
  version: string,
  digest: string,
): string {
  const pin = `digest=${digest}`;
  return document === 'breach-runbook'
    ? `https://evidence.example/settings/operations/?runbook=${version}&${pin}`
    : `https://evidence.example/legal/${key}/${document}/?version=${version}&${pin}`;
}

/** Items 3 to 6 and the document whose published version each links (C81). */
const LEGAL_EVIDENCE: Readonly<Record<string, string>> = {
  'legal-basics': 'privacy-policy',
  'privacy-act-statement': 'data-handling',
  'overseas-register': 'privacy-policy',
  'breach-runbook': 'breach-runbook',
};

/** The owner's connection, which passes row security. */
interface Owner {
  execute<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]>;
}

// A made-up published version of each document the business has none of,
// written as the owner's connection would, past the commands.
const SEED = `insert into public.legal_document_versions
    (business_id, id, document, version, body, body_digest, drafted_by_actor, approved_at,
     approved_by_actor, approved_digest, published_at, published_by_actor, register,
     register_digest, data_classes, data_classes_digest)
  select a.business_id, gen_random_uuid(), d.document, '0.0', d.body, '', a.id, now(), a.id,
         encode(sha256(convert_to(d.body, 'UTF8')), 'hex'), now(), a.id,
         p.listed, p.digest, p.listed, p.digest
    from (select business_id, id from public.actors where business_id = $1 order by id limit 1) a
   cross join (values ('privacy-policy', 'A made-up policy.'), ('data-handling', 'A made-up statement.'),
     ('breach-runbook', 'A made-up runbook.')) d (document, body)
   cross join lateral (select case when d.document = 'privacy-policy' then '[]'::jsonb end,
                              case when d.document = 'privacy-policy' then 'made-up' end)
                    p (listed, digest)
   where not exists (select 1 from public.legal_document_versions v
                      where v.business_id = $1 and v.document = d.document
                        and v.published_at is not null)
  on conflict do nothing`;

/**
 * Items 3 to 6's evidence in the business: the link to each document's
 * published version, publishing a made-up one where it has none. Read fresh
 * each time, since a later publish moves the version a link must name.
 */
export async function legalEvidence(
  owner: Owner,
  businessId: string,
): Promise<Readonly<Record<string, string>>> {
  await owner.execute(SEED, [businessId]);
  const rows = await owner.execute<{
    key: string;
    document: string;
    version: string;
    digest: string;
  }>(
    `select distinct on (v.document) b.key, v.document, v.version, v.body_digest as digest
       from public.legal_document_versions v
       join public.businesses b on b.id = v.business_id
      where v.business_id = $1 and v.published_at is not null
      order by v.document, v.published_at desc, v.drafted_at desc`,
    [businessId],
  );
  const link = new Map(
    rows.map((r) => [r.document, versionLink(r.key, r.document, r.version, r.digest)]),
  );
  return Object.fromEntries(
    Object.entries(LEGAL_EVIDENCE).map(([item, document]) => [item, link.get(document) ?? '']),
  );
}

/**
 * A record that closes this item or line, with made-up evidence; items 3 to 6
 * take theirs from `links` (`legalEvidence`) where the command checks it.
 */
export function gateRecordBody(
  item: string,
  links: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const statement = OWNER_LINES[item];
  if (statement === undefined) return { item, evidence: links[item] ?? evidence(item) };
  const link = item === 'privacy-opt-in' ? `${OPT_IN_REGISTER}?keys=Agency+Astro` : evidence(item);
  return { item, evidence: link, statement };
}

export function createGateBody(context: BodyContext): (name: GateCommand) => Promise<Prepared> {
  let sent = 0;
  let allDone = false;
  return async function gateBody(name: GateCommand): Promise<Prepared> {
    if (name === 'operations.record_gate_item') {
      const item = GATE_ITEMS[sent % GATE_ITEMS.length]!;
      sent += 1;
      if (context.clearGateItem !== undefined) {
        await context.clearGateItem(item);
        allDone = false;
      }
      return { body: gateRecordBody(item, await context.legalEvidence?.()) };
    }
    if (allDone) return { body: { mode: 'real' } };
    const links = await context.legalEvidence?.();
    for (const item of GATE_ITEMS) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await context.asPerson(
        'operations.record_gate_item',
        gateRecordBody(item, links),
      );
      if (answer.code !== 'ok' && answer.code !== 'GATE_ITEM_ALREADY_RECORDED') {
        return { exception: `the gate item ${item} was refused ${String(answer.code)}` };
      }
    }
    allDone = true;
    return { body: { mode: 'real' } };
  };
}
