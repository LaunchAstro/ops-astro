-- SPDX-License-Identifier: AGPL-3.0-only
-- A UTC timestamp ID (docs/local/DATA.md, "What the schema is").
--
-- 20261004072829 a carried drill dates the last tested restore once (OW-063.4).
-- A re-run of the drill's --record holds the stamp-owed note of a run killed
-- after its stamp committed, and stamped again, later. The stamp's adapter
-- (scripts/ops/tested-restore.ts) now notes the carried archive's store id
-- here, as the owner, in the stamp's own transaction; an archive already
-- noted leaves the date as it is. An id alone: no business, person, path,
-- key or record content. The owner writes it, the backup identity reads it
-- as it reads every table (0045), and PUBLIC and the application hold nothing.

create table ops.tested_restore_archives (archive_id uuid primary key);
revoke all on ops.tested_restore_archives from public;
