# Manual privacy runbook (C81)

How the operators answer a person's privacy request by hand. It is in force
until all three of these are live: the privacy-request workflows (C61-R), the
scheduled retention purge (C62), and the copy register's erasure fan-out
(C84). Until then, every request below is worked through this page.

The test `C81 manual privacy runbook` (`tests/operations/c81-privacy-runbook.test.ts`)
holds this page to its headings and runs the dry run below against a made-up
person.

## Who acts

- **Owner of every request:** the business owner. The owner decides what is
  given, corrected, deleted or kept, and signs the reply.
- **Assists:** the second operator finds the copies, prepares the export and
  runs the steps the owner has decided. Nothing is sent to the person until the
  owner decides.
- Each request is logged when it arrives, with who it is from, what they asked,
  the day it arrived and the day the reply is due.

## Response times

| Request    | Reply due                       | Basis                                       |
| ---------- | ------------------------------- | ------------------------------------------- |
| Access     | within 30 days of the request   | APP 12                                      |
| Correction | within 30 days of the request   | APP 13                                      |
| Erasure    | within 30 days of the request   | owner's rule                                |
| Export     | within 30 days, with the access | APP 12                                      |
| Legal hold | the same day it is placed       | owner's rule                                |
| Retention  | at each class's retention end   | the class's retention (data-class register) |

## Every copy of a person

For each request, list every copy of the person that exists at that moment,
by kind. A copy not on the list is a copy the reply missed.

- **Records:** the database rows that name the person (people, identifiers,
  memberships, records and their fields, incidents). Found with
  `node scripts/privacy/find-copies.mjs`.
- **Search indexes:** the records' search column (`records.search_tsv`),
  rebuilt from the record's text, so it follows the record. The finder reads it
  with the rest of the row.
- **Exports:** every file an operator exported that names the person, listed by
  hand from the export log.
- **Prompts:** any model prompt that carried the person's details. Client data
  sent to a model follows C60; list each by hand.
- **Traces:** logs and traces that captured the person, listed by hand from the
  trace store for the request's period.
- **Files at outside services:** each service on the overseas-services register
  that received the person's information, and the files there.
- **Backups:** every backup taken while the person was held. A backup is never
  edited: the erasure is re-applied when a backup is restored (see below).

## The requests

### Access

1. Find every copy (above).
2. Export the person's rows: `node scripts/privacy/find-copies.mjs --export`.
3. The owner reviews the export, removes what belongs to other people, and
   replies with it.

### Correction

1. Find every copy.
2. Correct each copy through the product's own commands, so each change is an
   audited operation. A kept copy that cannot change (audit evidence) gets a
   note of the correction beside it.

### Erasure

1. Find every copy and export it for the request's file.
2. Delete each copy, or record the lawful reason it is kept (below). By hand,
   in one transaction on the application's connection for that business:
   - a person: their `person_identifiers` rows, then their `people` row;
   - a record: its `record_unique_values` rows, its `record_links` rows (either
     end), then the `records` row, which takes its search column with it. A
     record other rows still reference (a run's proposals, reservations or
     leases) is refused by the database; keep it, with the reason recorded,
     until the copy register's erasure fan-out (C84) is live.
3. Search every copy again, and a backup restored from before the erasure, for
   the person. Any hit outside a lawfully kept copy means the erasure is not
   done.

### Export

As access, in a portable form (JSON rows from the finder).

### Legal hold

1. Record the hold, who placed it, and what it covers.
2. While it stands, no erasure or retention deletion touches the held copies;
   the finder's list for a later request marks them kept, with the hold as the
   reason.

### Retention

At each data class's retention end (the data-class register, C81), find the
copies of that class and delete them, or record the lawful reason each is kept.

## Lawful reasons a copy is kept

- **Audit evidence:** the audit chain and the operation register are
  append-only by design and never name a person's details in their words; a hit
  there is a defect, not a kept copy.
- **Breach record:** a privacy incident naming the person is kept while the
  incident is open or under assessment, by the owner's decision.
- **Legal hold:** a copy under a hold that still stands.
- **Backup not yet rolled off:** kept until it expires; a restore re-applies
  the erasure before the restored data is used.

## Dry run

Run on made-up data before S0-5 closes, and after any change to what the
product stores:

1. Plant a canary person: their person row, an identifier, a record naming
   them and an incident naming them.
2. Enumerate every copy with the finder.
3. Export them.
4. Delete each copy, or record the lawful reason it is kept.
5. Search every copy that still exists, and a backup restored from before the
   erasure, for the canary. Any hit outside a lawfully kept copy fails the dry
   run.

The backup leg needs the restore from S0-3 and is recorded when that lands.
