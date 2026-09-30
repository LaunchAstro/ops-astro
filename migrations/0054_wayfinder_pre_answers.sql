-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0054 wayfinder pre-answers (WF-6). Charting's breadth-first pass answers
-- the open questions that recorded decisions already settle, and marks the
-- obvious calls "decided, veto open" (CS-15.5). Each pre-answer is a map
-- component of kind `pre_answer`: its question, its answer (the body), and
-- the one source it cites, either a record (a closed ticket) or a written
-- reference. A pre-answer resolves nothing: it is a line on the map, never a
-- ticket's resolution, so Decisions so far still renders from closed tickets.
--
-- The citation is checked by `map.chart` against the charter's own grant
-- before it is written; the table holds the shape. A purged cited record
-- leaves its line with no record, which the map view shows as withheld.
-- Inherits 0053's rules and grants: the new columns sit on a table the
-- application role may already select, insert and update.

alter table public.map_components
  add column question         text,
  add column source_record_id uuid,
  add column source_reference text,
  add column veto_open        boolean not null default false;

alter table public.map_components
  drop constraint map_components_kind_known,
  add constraint map_components_kind_known
    check (kind in ('destination', 'notes', 'fog', 'out_of_scope', 'pre_answer')),
  -- A question and a source belong to a pre-answer and to nothing else.
  add constraint map_components_pre_answer_shape
    check (
      case when kind = 'pre_answer'
        then question is not null
             and not (source_record_id is not null and source_reference is not null)
        else question is null and source_record_id is null and source_reference is null
             and not veto_open
      end
    ),
  add constraint map_components_question_bounded
    check (question is null or char_length(btrim(question)) between 1 and 4000),
  -- A reference is one line: no CR, LF, NEL or Unicode line or paragraph separator.
  add constraint map_components_reference_bounded
    check (source_reference is null
           or (char_length(btrim(source_reference)) between 1 and 400
               and source_reference !~ E'[\\r\\n\\u0085\\u2028\\u2029]')),
  add constraint map_components_source_fkey foreign key (business_id, source_record_id)
    references public.records (business_id, id) on delete set null (source_record_id);

create index map_components_source_idx
  on public.map_components (business_id, source_record_id)
  where source_record_id is not null;
