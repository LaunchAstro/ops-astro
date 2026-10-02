// SPDX-License-Identifier: AGPL-3.0-only
//
// C81: the documents behind the first-client gate's items 3 to 6
// (`docs/build-safeguards.md`, "The gate before the first real client data"),
// through the real API. Each of those items is recorded with the link to its
// document's published version, and nothing else: the privacy policy with its
// collection notices for item 3 and, as it reads the overseas-services
// register, item 5; the data-handling statement for item 4; the breach runbook
// for item 6, which also has to fit on one page.
//
// The documents here are made up in the owner's shape. The owner's own
// Version 1.0 words never enter this repository: they are drafted on the
// installation through `legal.draft_version`, approved as that exact version
// by the owner and published, like every version.
//
// The world is `c81-legal-documents-world.ts`; Ada is alpha's owner, and alpha
// operates the installation.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, call, personPath, serverUrl, type Answer } from '../acceptance/world.ts';
import { versionLink } from '../acceptance/role-case-gate-bodies.ts';
import { runbookWords } from './c81-breach-drill-world.ts';
import {
  closeLegal,
  digestOf,
  harness,
  openLegal,
  readPublic,
  released,
} from './c81-legal-documents-world.ts';

if (serverUrl === undefined) {
  console.warn('operations/c81-gate-evidence: DATABASE_URL is unset, so nothing below ran.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await openLegal('c81_gate_evidence');
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await closeLegal();
});

/**
 * One page: an A4 page at 10-point type with 2 cm margins holds about 60
 * lines of 100 characters, some 6,000 characters or 1,000 words. The owner's
 * Version 1.0 runbook is 965 words with its sources.
 */
const ONE_PAGE_WORDS = 1000;
const wordsIn = (text: string): number => text.split(/\s+/u).filter(Boolean).length;

/** What item 4 needs the statement to say (owner answer 24). */
const COVERED = 'treated as covered by the Privacy Act';

const statementWords = (marker: string): string =>
  [
    '# Schedule 3: how we handle your data',
    '',
    '## 1. We follow the Privacy Act',
    '',
    `Made-up text: every client's personal information we hold is ${COVERED}.`,
    '',
    `Made-up text ${marker}.`,
    '',
  ].join('\n');

const ITEMS = ['legal-basics', 'privacy-act-statement', 'overseas-register', 'breach-runbook'];

const admin = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await harness.world.db.admin.execute<T & Record<string, unknown>>(sql, params)) as T[];

const gateRows = async (): Promise<{ item: string; evidence: string }[]> =>
  await admin(`select item, evidence from ops.gate_items order by item`);

/** Items 3 to 6 open again, as before any case recorded them. */
const reopen = async (): Promise<void> => {
  await admin(`delete from ops.gate_items where item = any($1::text[])`, [ITEMS]);
};

const recordItem = async (item: string, evidence: string): Promise<Answer> =>
  await call(
    harness.world.api,
    personPath('alpha', '/operations/record_gate_item'),
    { operationId: `c81g-${randomUUID()}`, item, evidence },
    bearer(harness.world.ada.token),
  );

/** Publish `body` as a new version of `document`; answers the link to that version. */
const publishLink = async (document: string, body: string): Promise<string> => {
  const { body: sent } = await released({ document, body });
  return versionLink('alpha', document, String(sent.version), digestOf(body));
};

/** Each attempt refused as an invalid evidence link, and nothing written to the gate. */
async function refusedAlike(attempts: readonly (readonly [string, string])[]): Promise<string[]> {
  const wrong: string[] = [];
  for (const [item, link] of attempts) {
    // oxlint-disable-next-line no-await-in-loop
    const before = await gateRows();
    // oxlint-disable-next-line no-await-in-loop
    const answer = await recordItem(item, link);
    if (answer.code !== 'FIELD_VALUE_INVALID') wrong.push(`${item} ${link}: ${answer.code}`);
    // oxlint-disable-next-line no-await-in-loop
    if (JSON.stringify(await gateRows()) !== JSON.stringify(before)) wrong.push(`${item}: wrote`);
  }
  return wrong;
}

/** A later draft of the statement, never approved, as version 9.0; answers its words. */
async function draftOnly(): Promise<string> {
  const words = statementWords(randomUUID());
  const drafted = await call(
    harness.world.api,
    personPath('alpha', '/legal/draft_version'),
    { operationId: `c81g-${randomUUID()}`, document: 'data-handling', version: '9.0', body: words },
    bearer(harness.world.ada.token),
  );
  expect(drafted.code, 'a later draft, never approved').toBe('ok');
  return words;
}

async function c81DataHandlingStatement(): Promise<void> {
  await reopen();
  const words = statementWords(randomUUID());
  const { body: sent } = await released({ document: 'data-handling', body: words });
  const later = await draftOnly();

  const shown = await readPublic('alpha', 'data-handling');
  expect(shown.status).toBe(200);
  const served = JSON.parse(shown.text) as Record<string, unknown>;
  expect(served['body']).toBe(words);
  expect(String(served['body'])).toContain(COVERED);
  expect(served['version']).toBe(sent.version);

  const unapproved = versionLink('alpha', 'data-handling', '9.0', digestOf(later));
  expect(await refusedAlike([['privacy-act-statement', unapproved]])).toStrictEqual([]);
  const link = versionLink('alpha', 'data-handling', sent.version, digestOf(words));
  expect((await recordItem('privacy-act-statement', link)).code).toBe('ok');
  expect(await gateRows()).toContainEqual({ item: 'privacy-act-statement', evidence: link });
}

/** The breach runbook's version and digest, as the operations view's privacy incidents read it. */
async function runbookOnTheView(): Promise<string> {
  const read = await call(
    harness.world.api,
    personPath('alpha', '/operations/read'),
    { operationId: `c81g-${randomUUID()}` },
    bearer(harness.world.ada.token),
  );
  const runbook = read.body['breachRunbook'] as Record<string, unknown>;
  return versionLink(
    'alpha',
    'breach-runbook',
    String(runbook['version']),
    String(runbook['digest']),
  );
}

async function c81BreachRunbookOnePage(): Promise<void> {
  await reopen();
  const longer = `${runbookWords(randomUUID())}\n${'More made-up steps. '.repeat(400)}\n`;
  expect(wordsIn(longer)).toBeGreaterThan(ONE_PAGE_WORDS);
  const tooLong = await publishLink('breach-runbook', longer);
  expect(await refusedAlike([['breach-runbook', tooLong]])).toStrictEqual([]);

  const words = runbookWords(randomUUID());
  expect(wordsIn(words)).toBeLessThanOrEqual(ONE_PAGE_WORDS);
  expect(words).toMatch(/the owner decides/iu);
  expect(words).toMatch(/the second operator assists/iu);
  expect(words).toMatch(/within 30 calendar days/iu);
  expect(words).toMatch(/^## Template: notice to affected people$/mu);
  const link = await publishLink('breach-runbook', words);
  expect((await recordItem('breach-runbook', link)).code).toBe('ok');
  expect(await gateRows()).toContainEqual({ item: 'breach-runbook', evidence: link });
  expect(await runbookOnTheView()).toBe(link);
}

/** Two policies published in alpha, the first superseded, and one in bravo; answers their links. */
async function policies(): Promise<{ first: string; policy: string; bravo: string }> {
  const first = await publishLink('privacy-policy', `# Privacy policy\n\n${randomUUID()}\n`);
  const policy = await publishLink('privacy-policy', `# Privacy policy\n\n${randomUUID()}\n`);
  const theirs = await released(
    { document: 'privacy-policy', body: 'Bravo.' },
    harness.world.bea.token,
    'bravo',
  );
  const bravo = versionLink('bravo', 'privacy-policy', theirs.body.version, digestOf('Bravo.'));
  return { first, policy, bravo };
}

/**
 * The right path, version and digest behind a user name, a password, a port
 * other than 443 or a fragment: each a link the gate refuses.
 */
const linkParts = (link: string): string[] => [
  link.replace('https://', 'https://ada@'),
  link.replace('https://', 'https://ada:secret@'),
  link.replace('evidence.example', 'evidence.example:8443'),
  `${link}#elsewhere`,
  `${link}#`,
];

async function c81GateEvidenceLinks(): Promise<void> {
  await reopen();
  const statement = await publishLink('data-handling', statementWords(randomUUID()));
  const runbook = await publishLink('breach-runbook', runbookWords(randomUUID()));
  const unpublished = versionLink('alpha', 'privacy-policy', '0.1', digestOf('none'));
  const beforePolicy = await refusedAlike([
    ['legal-basics', unpublished],
    ['overseas-register', unpublished],
    ['legal-basics', 'https://evidence.example/legal-basics'],
  ]);
  expect(beforePolicy).toStrictEqual([]);

  const { first, policy, bravo } = await policies();
  const wrongLinks = await refusedAlike([
    ['legal-basics', first],
    ['legal-basics', statement],
    ['overseas-register', runbook],
    ['privacy-act-statement', policy],
    ['breach-runbook', statement],
    ['legal-basics', bravo],
    ...linkParts(policy).map((link): readonly [string, string] => ['legal-basics', link]),
  ]);
  expect(wrongLinks).toStrictEqual([]);

  const links = {
    'breach-runbook': runbook,
    'legal-basics': policy,
    'overseas-register': policy,
    'privacy-act-statement': statement,
  };
  const answers = await Promise.all(
    Object.entries(links).map(async ([item, link]) => (await recordItem(item, link)).code),
  );
  expect(answers).toStrictEqual(['ok', 'ok', 'ok', 'ok']);
  expect((await gateRows()).filter((row) => ITEMS.includes(row.item))).toStrictEqual(
    Object.entries(links).map(([item, evidence]) => ({ item, evidence })),
  );
}

describe.skipIf(serverUrl === undefined)('C81 the gate evidence', () => {
  it("C81 data-handling statement: it says every client's personal information is treated as covered by the Privacy Act, is served at its public address without sign-in once published, and its published version is item 4's evidence", async () => {
    await c81DataHandlingStatement();
  });

  it('C81 breach runbook one page: the runbook item 6 takes fits on one page and names who decides, who assists, the 30-day assessment clock and the templates; one longer than a page is refused; the privacy incidents on the operations view carry the version it links', async () => {
    await c81BreachRunbookOnePage();
  });

  it("C81 gate evidence links: items 3 to 6 each link their document's published version; a link to no published version, another document's, a superseded one, another business's, or the right one behind a user name, password, port or fragment is refused and writes nothing", async () => {
    await c81GateEvidenceLinks();
  });
});
