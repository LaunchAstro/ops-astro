// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 3, lane FR3-DOCS: the correction RUNTIME.md carries for
// the header of migration 0019 (R1-RUNTIME-67). The migration cannot be edited,
// since its applied checksum must not change, so the note is held against the
// file it corrects: a quote that stops matching, or a cite that stops framing,
// fails here.

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
