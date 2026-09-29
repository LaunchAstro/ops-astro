// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3 no recovery figure (roadmap S0-3a, checklist line C7; ADR 0067).
//
// No recovery-time or recovery-point figure is quoted in the product's docs or
// screens until a restore drill has run and left its receipt. No receipt exists
// yet: S0-3c writes the drill and S0-3d its receipt, and the part that lands
// the receipt is the one that may relax this search, naming the receipt it
// read. Until then any figure is an estimate, and ADR 0067 says an estimate is
// not recovery proof.
//
// The matcher is proved first on sentences written for it, so a search that
// matches nothing cannot pass by being blind.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UNIT = String.raw`(?:seconds?|secs?|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?)`;
const FIGURE = String.raw`\d+(?:\.\d+)?\s*${UNIT}\b`;
const RESTORE = String.raw`\b(?:recover(?:y|ies|s|ed|ing)?|restor(?:e|es|ed|ing|ation|ations))\b`;

/**
 * A recovery figure: a number with a time unit in the same sentence as a
 * recovery or restore word, either way round, or RTO and RPO with a number.
 * Broad on purpose (Sol, criterion 11): a figure in any phrasing is still a
 * figure, and a false match costs a rewording.
 */
const RECOVERY_FIGURES: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:RTO|RPO)\b[^.\n]{0,40}?\d`, 'u'),
  new RegExp(String.raw`${RESTORE}[^.\n]{0,60}?${FIGURE}`, 'iu'),
  new RegExp(String.raw`${FIGURE}[^.\n]{0,40}?${RESTORE}`, 'iu'),
  new RegExp(String.raw`${FIGURE}\s+(?:of\s+)?(?:data\s+loss|downtime)`, 'iu'),
];

function recoveryFigures(text: string): readonly string[] {
  const found: string[] = [];
  for (const line of text.split('\n')) {
    if (RECOVERY_FIGURES.some((pattern) => pattern.test(line))) found.push(line.trim());
  }
  return found;
}

/** The product's docs and screens: every Markdown file outside dependencies, and the web app. */
function productText(): readonly string[] {
  const files: string[] = [];
  const walk = (directory: string, keep: (name: string) => boolean): void => {
    for (const name of readdirSync(directory)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path, keep);
      else if (keep(name)) files.push(path);
    }
  };
  for (const name of readdirSync('.')) if (name.endsWith('.md')) files.push(name);
  walk('docs', (name) => name.endsWith('.md'));
  walk('apps/web', (name) => /\.(?:tsx?|html|json|md)$/u.test(name));
  return files;
}

describe('S0-3 no recovery figure', () => {
  it('finds the figures written to be found', () => {
    for (const planted of [
      'Recovery time objective: 4 hours.',
      'Our RPO is 15 minutes.',
      'A full restore completes in about 2 hours.',
      'You can recover within 30 minutes of an outage.',
      'At most 24 hours of data loss.',
      'The recovery point is 1 day behind.',
      'Restoration takes 4h.',
      'Plan for 3 hours to restore the database.',
    ]) {
      expect(recoveryFigures(planted)).toStrictEqual([planted]);
    }
  });

  it('Sol proof, criterion 11: a restoration time quoted in plain English is found', () => {
    const planted = 'The restoration time is 4 hours.';
    expect(recoveryFigures(planted)).toStrictEqual([planted]);
  });

  it('passes sentences that quote no recovery figure', () => {
    for (const neutral of [
      'Publish no recovery-point or recovery-time figure until a restore has been rehearsed.',
      'Backups are kept for 30 days, the retention window.',
      'The drill restores the nightly dump into a throwaway container.',
      'The session expires after 15 minutes.',
    ]) {
      expect(recoveryFigures(neutral)).toStrictEqual([]);
    }
  });

  it('finds no recovery figure in the docs or screens while no drill receipt exists', () => {
    const files = productText();
    expect(files.length).toBeGreaterThan(50);
    const quoted = files.flatMap((file) =>
      recoveryFigures(readFileSync(file, 'utf8')).map((line) => `${file}: ${line}`),
    );
    expect(quoted).toStrictEqual([]);
  });
});
