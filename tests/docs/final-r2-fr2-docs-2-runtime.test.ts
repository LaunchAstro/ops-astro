// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, lane FR2-DOCS-2: the doc lines the FR2 lanes handed
// back for RUNTIME.md, AUTHORITY.md, DATA.md, README.md and PROOFS.md, each
// held against the code, migration or test it names, so a doc line that
// drifts from them fails here.

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const exists = (path: string): boolean => existsSync(new URL(`../../${path}`, import.meta.url));

/** Prose with its line breaks folded, so a phrase is found across a wrap. */
const folded = (text: string): string => text.replaceAll(/\s+/gu, ' ');

/** One `##` section of a markdown file, from its heading to the next one. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`no section "${heading}"`);
  const next = text.indexOf('\n## ', start + heading.length + 4);
  return text.slice(start, next < 0 ? undefined : next);
}

/** The body of the function `name` declares in `source`, to its closing brace. */
function bodyOf(source: string, name: string): string {
  const start = source.search(new RegExp(`function ${name}\\(`, 'u'));
  if (start < 0) throw new Error(`no function ${name}`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end < 0 ? undefined : end);
}

const runtime = folded(read('docs/local/RUNTIME.md'));
const authority = folded(read('docs/local/AUTHORITY.md'));
const data = folded(read('docs/local/DATA.md'));
const readme = folded(read('docs/local/README.md'));
const RUNTIME_SRC = 'packages/core-runtime/src';

describe('RUNTIME.md on migration 0029 (R2-RUNTIME-6, R2-AUTHORITY-20)', () => {
  const migration = 'migrations/0029_cap_ceiling_fails_closed.sql';

  it('names 0029 beside 0025 and says a hidden cap is refused budget_caps_ceiling', () => {
    expect(runtime).toMatch(
      /Since migration 0029 the backstop also fails closed\.[^#]{0,400}?cannot be read at commit, the commit is refused `budget_caps_ceiling`/u,
    );
    expect(runtime).toContain('(`budget_caps_ceiling`, migrations 0025 and 0029');
    expect(runtime).toContain('`tests/runtime/final-r2-dbtest-cap-fails-closed.test.ts`');
    expect(exists('tests/runtime/final-r2-dbtest-cap-fails-closed.test.ts')).toBe(true);
    const sql = read(migration);
    expect(sql).toContain('cannot be read at commit');
    expect(sql).toContain("constraint = 'budget_caps_ceiling'");
    expect(sql).toContain('Nathan approved this migration');
  });

  it('is listed among the approved migrations in PROOFS.md', () => {
    const open = folded(section(read('docs/local/PROOFS.md'), 'Open for the owner'));
    expect(open).toMatch(/0029 \(/u);
  });
});

describe('RUNTIME.md on grants judged at the locked instant (R2-RUNTIME-4, -5)', () => {
  it('names checkAuthorityAt and lockedAt, which the cited handlers call', () => {
    expect(read(`${RUNTIME_SRC}/recovery.ts`)).toContain('export async function checkAuthorityAt(');
    for (const file of ['decide.ts', 'pickup.ts', 'heartbeat.ts', 'handback.ts']) {
      const source = read(`${RUNTIME_SRC}/${file}`);
      expect(source, file).toContain('const lockedAt = await lockedInstant(tx);');
      expect(source, file).toMatch(/checkAuthorityAt\([\s\S]{0,300}?lockedAt,/u);
    }
    expect(runtime).toMatch(/decide grant again[^.]*\(`checkAuthorityAt`, `lockedAt`\)/u);
    expect(runtime).toMatch(
      /pickup, heartbeat and handback[^.]*at the locked instant \(`checkAuthorityAt`, `lockedAt`\)/u,
    );
  });

  it('says an agent pickup refused this way answers DELEGATION_WIDENS', () => {
    expect(runtime).toMatch(/agent pickup refused this way answers `DELEGATION_WIDENS`/u);
    expect(read(`${RUNTIME_SRC}/pickup.ts`)).toMatch(
      /checkAuthorityAt\([\s\S]{0,300}?code: 'DELEGATION_WIDENS'/u,
    );
  });

  it('says task.cancel holds its grants before the runtime set and re-reads write', () => {
    const cancel = bodyOf(read(`${RUNTIME_SRC}/recovery.ts`), 'cancelAndClassify');
    expect(cancel.indexOf('holdCoveringGrants(')).toBeGreaterThan(0);
    expect(cancel.indexOf('holdCoveringGrants(')).toBeLessThan(cancel.indexOf('lockRediscovered('));
    expect(cancel).toMatch(/checkAuthorityAt\([\s\S]{0,200}?action: 'write'/u);
    expect(runtime).toMatch(/`task\.cancel` holds the canceller's covering grants for share/u);
  });
});

describe('RUNTIME.md on the proposal read binding evidence (R2-THERMO-17)', () => {
  it('says each decision is bound to its version and pack, and rows stay mutable', () => {
    const source = read('packages/core-records/src/reads/verified-decisions.ts');
    expect(source).toContain('function unboundEvidence(');
    const limits = runtime.slice(runtime.indexOf('Its limits:'));
    expect(limits).toMatch(
      /signed evidence digest to what it shows\.[^#]{0,400}?`DECISION_INTEGRITY` \(`unboundEvidence`/u,
    );
    expect(limits).toMatch(/stay mutable/u);
  });
});

describe('RUNTIME.md on task.propose (R2-RUNTIME-24, -25, -26, -52)', () => {
  const propose = read(`${RUNTIME_SRC}/propose.ts`);

  it('T1 checks cap currency and room under the locks before the first write', () => {
    expect(propose).toContain('async function refuseBeyondBudget(');
    const t1 = read('docs/local/RUNTIME.md')
      .split('\n')
      .find((line) => line.startsWith('| T1 '));
    expect(t1).toBeDefined();
    expect(runtime).toMatch(
      /`task\.propose` checks the cap's currency and room[^.]*`refuseBeyondBudget`/u,
    );
  });

  it('rediscovers the live version and the task envelope', () => {
    expect(propose).toContain(
      'the live version itself or the task envelope changed under discovery',
    );
    expect(runtime).toMatch(/recheck also covers the live version and the task envelope/u);
  });

  it('answers NOT_FOUND on a trashed task, as task.restart does', () => {
    expect(read('packages/core-records/src/commands/tasks-propose.ts')).toContain(
      'if (target.deleted_at !== null) return refused(refuseNotFound());',
    );
    expect(runtime).toMatch(
      /`task\.restart` and `task\.propose` on a trashed task stay `NOT_FOUND`/u,
    );
  });
});

describe('a uuid in any case (R2-AUTHORITY-33)', () => {
  it('is said once, with the handlers that lower-case it', () => {
    expect(runtime).toContain(
      'A uuid is one identifier however it is cased; handlers compare the lower-case form.',
    );
    expect(read(`${RUNTIME_SRC}/decide.ts`)).toContain('gateId: presented.gateId.toLowerCase(),');
    expect(read('packages/core-records/src/commands/tasks-controls.ts')).toContain(
      'const taskId = recordId.toLowerCase();',
    );
  });
});

describe('the delegation key file (R2-AUTHORITY-69)', () => {
  it('says a named key file stops the server reading .local/delegation.env', () => {
    expect(read('packages/core-records/src/authority/credential-keys.ts')).toContain(
      "export const KEY_FILE_VARIABLE = 'DELEGATION_CREDENTIAL_KEY_FILE';",
    );
    expect(read('apps/api/server.ts')).toContain(
      "...(keyFileNamed ? {} : readEnvFile(join(ROOT, '.local', 'delegation.env'))),",
    );
    for (const [name, doc] of [
      ['RUNTIME.md', runtime],
      ['README.md', readme],
    ] as const) {
      expect(doc, name).toMatch(
        /`DELEGATION_CREDENTIAL_KEY_FILE`[^.]*server does not read `\.local\/delegation\.env`/u,
      );
    }
  });
});

describe('AUTHORITY.md on the external party (R2-AUTHORITY-56, -57, -60)', () => {
  it('cites the suite that proves session.capabilities, not one that never calls it', () => {
    const test = 'tests/authority/final-r2-fr2-api-capabilities.test.ts';
    expect(exists(test)).toBe(true);
    expect(read(test)).toContain("'session.capabilities'");
    expect(read('tests/acceptance/external-party.test.ts')).not.toContain('session.capabilities');
    expect(authority).toMatch(
      /`session\.capabilities`\*\* shows[^*]*`tests\/authority\/final-r2-fr2-api-capabilities\.test\.ts`/u,
    );
    expect(authority).not.toMatch(
      /Proved\*\* over HTTP by `tests\/acceptance\/external-party\.test\.ts` and as rows in the matrix's case \(g\)\. /u,
    );
  });

  it('says revokeShare reaches a trashed record and shareRecord a live one', () => {
    const shares = read('packages/core-records/src/authority/shares.ts');
    expect(bodyOf(shares, 'shareRecord')).toContain("refuseShare(tx, sharer, request, 'live')");
    expect(bodyOf(shares, 'revokeShare')).toContain(
      "refuseShare(tx, sharer, request, 'live or trashed')",
    );
    expect(authority).toMatch(/`revokeShare`[^.]*live or in the trash/u);
    expect(authority).toMatch(/`shareRecord` shares live records only/u);
  });
});

describe('DATA.md on TEMPORARY and ranks (R2-AUTHORITY-61, placement)', () => {
  it('lists TEMPORARY in the default-deny set, revoked where the database is made', () => {
    expect(read('packages/core-records/src/tenancy/privileges.ts')).toContain(
      "'TEMPORARY') as temporary",
    );
    expect(read('scripts/local/db-up.sh')).toContain(
      'revoke temporary on database $DATABASE from public;',
    );
    expect(read('packages/core-records/src/tenancy/testing/fresh-database.ts')).toContain(
      'revoke temporary on database',
    );
    expect(data).toMatch(/no `TEMPORARY` on the database for `PUBLIC`/u);
    expect(data).toContain('`scripts/local/db-up.sh`');
    expect(data).toContain('`createEmptyDatabase`');
  });

  it('says a new task ranks after its trashed siblings too', () => {
    const rank = bodyOf(read('packages/core-records/src/tasks/placement.ts'), 'rankAfterSiblings');
    expect(rank).toContain('rows.trashed');
    expect(data).toMatch(/Trashed siblings count[^.]*`rankAfterSiblings`/u);
  });
});
