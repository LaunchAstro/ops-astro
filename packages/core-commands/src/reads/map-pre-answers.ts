// SPDX-License-Identifier: AGPL-3.0-only
//
// A map's charting pre-answers (WF-6) as its view shows them. A cited record
// the reader may not read is withheld, never named by id, key or title
// (standing gate 9); so is one purged since it was cited.

import type { Subject, TenantQuery } from '../../../core-records/src/index.ts';
import type { MapPreAnswerView } from '../../../core-wire/src/index.ts';
import { mayRead } from './detail.ts';

interface PreAnswerRow {
  readonly id: string;
  readonly question: string;
  readonly body: string;
  readonly veto_open: boolean;
  readonly source_record_id: string | null;
  readonly source_reference: string | null;
  readonly source_key: string | null;
}

export async function readPreAnswers(
  tx: TenantQuery,
  subjects: readonly Subject[],
  mapId: string,
): Promise<readonly MapPreAnswerView[]> {
  const rows = await tx.query<PreAnswerRow>(
    `select c.id, c.question, c.body, c.veto_open, c.source_record_id, c.source_reference,
            r.txt_1 as source_key
       from public.map_components c
       left join public.records r on r.business_id = c.business_id and r.id = c.source_record_id
        and r.deleted_at is null
      where c.business_id = $1 and c.map_id = $2 and c.kind = 'pre_answer'
        and c.retired_version is null
      order by c.position`,
    [tx.businessId, mapId],
  );
  const out: MapPreAnswerView[] = [];
  for (const row of rows) {
    const shown = { id: row.id, question: row.question, answer: row.body, vetoOpen: row.veto_open };
    if (row.source_reference !== null) {
      out.push({ ...shown, source: { reference: row.source_reference } });
      continue;
    }
    const id = row.source_record_id;
    // One grant check per cited record, on one transaction.
    // oxlint-disable-next-line no-await-in-loop
    const readable = id !== null && row.source_key !== null && (await mayRead(tx, subjects, id));
    out.push({
      ...shown,
      source: readable ? { recordId: id, key: row.source_key } : { withheld: true },
    });
  }
  return out;
}
