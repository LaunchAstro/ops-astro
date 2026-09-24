// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 3, lane FR3-DOCS: the correction RUNTIME.md carries for
// the header of migration 0019 (R1-RUNTIME-67). The migration cannot be edited,
// since its applied checksum must not change, so the note is held against the
// file it corrects: a quote that stops matching, or a cite that stops framing,
// fails here. Pass 2 adds migration 0031's doc lines, held against 0031.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** Prose with its line breaks folded, so a phrase is found across a wrap. */
const folded = (text: string): string => text.replaceAll(/\s+/gu, ' ');

const MIGRATION = 'migrations/0019_runtime_active_hold_uniqueness.sql';
const FALSE_LINE =
  '`abandoned`, `actual` and `quarantined` rows are history and do not block a replacement';

/** Lines `from`-`to` of `text`, 1-based and inclusive. */
const lines = (text: string, from: number, to: number): string =>
  text
    .split('\n')
    .slice(from - 1, to)
    .join('\n');

/** The RUNTIME.md paragraph that corrects 0019's header. */
function correction(): string {
  const paragraph = read('docs/local/RUNTIME.md')
    .split('\n\n')
    .find((each) => each.startsWith('**Correction to the header of migration 0019**'));
  if (paragraph === undefined) throw new Error('RUNTIME.md has no 0019 correction');
  return folded(paragraph);
}

describe('the 0019 header correction (R1-RUNTIME-67)', () => {
  const migration = read(MIGRATION);

  it('quotes the header line as it stands at the cited lines', () => {
    const cited = folded(lines(migration, 17, 18).replaceAll(/^-- ?/gmu, ''));
    expect(cited).toContain(FALSE_LINE);
    expect(correction()).toContain(`\`${MIGRATION}\` says, at \`:17-18\`: "${FALSE_LINE}"`);
  });

  it('cites the index definition, which counts a quarantined hold as active', () => {
    const index = lines(migration, 25, 27);
    expect(index).toMatch(/^create unique index reservations_one_active_per_version_idx$/mu);
    expect(index).toContain('on public.reservations (business_id, version_id)');
    expect(index).toMatch(/where state in \('held', 'quarantined'\);$/u);
    const note = correction();
    expect(note).toContain('`reservations_one_active_per_version_idx` (`:25-27`)');
    expect(note).toContain("partial on `state in ('held', 'quarantined')`");
    expect(note).toContain('a quarantined hold blocks a replacement');
    expect(note).toContain('Only `abandoned` and `actual` rows are history');
  });

  it('sits beside the pickup paragraph that refuses a quarantined hold', () => {
    const runtime = read('docs/local/RUNTIME.md');
    const refusal = runtime.indexOf('`RESERVATION_NOT_CLAIMABLE` (`replaceable`)');
    const note = runtime.indexOf('**Correction to the header of migration 0019**');
    expect(refusal).toBeGreaterThan(0);
    expect(note).toBeGreaterThan(refusal);
    expect(runtime.slice(refusal, note)).not.toContain('\n#');
  });
});

describe('migration 0031 in the docs (FR2-P3, SOL-R3-1, SOL-R3-2)', () => {
  const migration = read('migrations/0031_upgrade_guards.sql');

  it('DATA.md says the migrations revoke TEMPORARY, as 0031 does', () => {
    for (const from of ['from public', 'from ops_astro_app', 'from %I'])
      expect(migration).toContain(`revoke temporary on database %I ${from}`);
    const data = folded(read('docs/local/DATA.md'));
    expect(data).toContain(
      'Since migration 0031 the migrations revoke it too, on the current database, from `PUBLIC`, the group and every login in it',
    );
    expect(data).toContain('restart the API after migrating');
  });

  it('RUNTIME.md says an over-ceiling database refuses the upgrade budget_caps_ceiling', () => {
    expect(migration).toContain("constraint = 'budget_caps_ceiling'");
    expect(migration).toContain('limit 1;');
    const runtime = folded(read('docs/local/RUNTIME.md'));
    expect(runtime).toContain(
      'refuses the upgrade `budget_caps_ceiling`, naming one such cap and its business, changes no row, and does not record 0031',
    );
  });

  it('PROOFS.md lists 0031 among the approved migrations, with its proof', () => {
    expect(folded(read('docs/local/PROOFS.md'))).toMatch(
      /Nathan approved 0031 \([^)]*FR2-P3, SOL-R3-2 and SOL-R3-1\) as well, proved by `tests\/runtime\/final-r2-dbtest-upgrade-guards\.test\.ts`/u,
    );
  });
});

describe('RUNTIME.md on the 0030 trigger (R4-SURFACE-2)', () => {
  const migration = read('migrations/0030_gate_pack_bound_to_version.sql');
  const paragraph = (): string => {
    const found = read('docs/local/RUNTIME.md')
      .split('\n\n')
      .find((each) => each.startsWith('Since migration 0030 its evidence pack is bound'));
    if (found === undefined) throw new Error('RUNTIME.md has no 0030 paragraph');
    return folded(found);
  };

  it('fires on a changed version of a gate not pending or named by a decision', () => {
    expect(folded(migration)).toContain(
      'before update of version_id on public.gates for each row when (new.version_id is distinct from old.version_id)',
    );
    expect(folded(migration)).toMatch(
      /if old\.state <> 'pending' or exists \(select 1 from public\.gate_decisions d/u,
    );
    const text = paragraph();
    expect(text).toContain('refuses the change when the stored state is anything but `pending`');
    expect(text).toContain('or when a row in `gate_decisions` names the gate, whatever the gate');
  });

  it('does not claim an expired gate is covered: it is stored pending', () => {
    const proposalsRead = read('packages/core-records/src/reads/proposals.ts');
    expect(proposalsRead).toContain("case when g.state = 'pending' and g.expires_at <= now()");
    const text = paragraph();
    expect(text).not.toMatch(/covers[^.]*expired/u);
    expect(text).toContain('An expired gate is stored as `pending`');
    expect(text).toContain('an undecided gate past its expiry is not covered');
  });

  it('names the lock 0030 takes before its check', () => {
    const lock = migration.indexOf('lock table public.gates in share row exclusive mode;');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(migration.indexOf('do $$'));
    const text = paragraph();
    expect(text).toContain('takes SHARE ROW EXCLUSIVE on `gates` before it checks the rows');
    expect(text).toContain('`tests/runtime/final-r3r-0030-upgrade-race.test.ts`');
  });
});
