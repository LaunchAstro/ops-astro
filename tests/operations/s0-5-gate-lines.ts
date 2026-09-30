// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5's three closing lines (migration 0062) as `s0-5-gate-commands.test.ts`
// runs them: each try that must keep a line shut, the record that closes it,
// and the rows the table refuses by itself.

import { OPT_IN_REGISTER, OWNER_LINES } from '../acceptance/role-case-gate-bodies.ts';
import {
  admin,
  evidence,
  fingerprint,
  names,
  readiness,
  RECORD,
  send,
  type GateWorld,
} from './s0-5-gate-world.ts';

const line = (item: string): string => OWNER_LINES[item]!;

/** A lodged form or a receipt keeps it shut; only the register entry, with the owner's line. */
const OPT_IN_TRIES: readonly Try[] = [
  ['no evidence', { statement: line('privacy-opt-in') }, 'evidence'],
  [
    'a receipt',
    { evidence: 'https://mail.example/oaic/receipt-1', statement: line('privacy-opt-in') },
    'evidence',
  ],
  [
    'an OAIC page past the register',
    { evidence: `${OPT_IN_REGISTER}/lodge`, statement: line('privacy-opt-in') },
    'evidence',
  ],
  [
    'a look-alike host',
    {
      evidence: OPT_IN_REGISTER.replace('oaic.gov.au', 'oaic.gov.au.example'),
      statement: line('privacy-opt-in'),
    },
    'evidence',
  ],
  ["the register entry, no owner's line", { evidence: OPT_IN_REGISTER }, 'statement'],
  ["an empty owner's line", { evidence: OPT_IN_REGISTER, statement: '' }, 'statement'],
];

const CLOUDFLARE_TRIES: readonly Try[] = [
  ['no evidence', {}, 'evidence'],
  [
    'the new in custody, the old not shown refused',
    { statement: line('cloudflare-rolled') },
    'evidence',
  ],
  ['the old refused, no custody line', { evidence: evidence('cf') }, 'statement'],
  [
    'a custody note of two lines',
    { evidence: evidence('cf'), statement: 'In custody.\nDone.' },
    'statement',
  ],
];

const TRAINING_TRIES: readonly Try[] = [
  ['the dated line, no evidence link', { statement: line('training-line') }, 'evidence'],
  [
    'an undated line',
    { evidence: evidence('t'), statement: 'Training is off on both.' },
    'statement',
  ],
  [
    'an impossible date',
    { evidence: evidence('t'), statement: 'Off since 2026-02-30.' },
    'statement',
  ],
];

/** Each named test: its title, the line, what keeps it shut, and the record that closes it. */
export const CLOSING_LINES: readonly (readonly [string, string, readonly Try[], () => object])[] = [
  [
    "S0-5 privacy opt-in: no evidence, a receipt only and a register entry each tried; only the register entry, with the owner's line that the published policy matches it, closes it",
    'privacy-opt-in',
    OPT_IN_TRIES,
    () => ({ evidence: `${OPT_IN_REGISTER}?keys=Agency+Astro`, statement: line('privacy-opt-in') }),
  ],
  [
    'S0-5 Cloudflare credential rolled: with no evidence, with the new credential in custody but the old not shown refused, and with the old refused but no custody line, the gate stays shut; with both it may close',
    'cloudflare-rolled',
    CLOUDFLARE_TRIES,
    () => ({ evidence: evidence('cf'), statement: line('cloudflare-rolled') }),
  ],
  [
    'S0-5 training line evidence: the gate refuses to close while the dated model-training line has no evidence link, or no real date',
    'training-line',
    TRAINING_TRIES,
    () => ({ evidence: evidence('t'), statement: line('training-line') }),
  ],
];

export type Try = readonly [label: string, body: object, field: string];

/**
 * A closing line (S0-5): each try refused on its named field, writing nothing
 * and leaving the line open; then the right record closes it.
 */
export async function closingLine(
  w: GateWorld,
  item: string,
  tries: readonly Try[],
  good: object,
): Promise<string[]> {
  const wrong: string[] = [];
  for (const [label, body, field] of tries) {
    // oxlint-disable-next-line no-await-in-loop
    const before = await fingerprint(w);
    // oxlint-disable-next-line no-await-in-loop
    const answer = await send(w, RECORD, { item, ...body });
    // oxlint-disable-next-line no-await-in-loop
    const after = await fingerprint(w);
    const got = `${String(answer.status)} ${String(answer.code)} ${JSON.stringify(names(answer))}`;
    if (got !== `422 FIELD_VALUE_INVALID ["${field}"]`) wrong.push(`${label}: ${got}`);
    if (before !== after) wrong.push(`${label}: wrote`);
    // oxlint-disable-next-line no-await-in-loop
    if (!(await readiness(w)).open_items.includes(item)) wrong.push(`${label}: closed it`);
  }
  const answer = await send(w, RECORD, { item, ...good });
  if (answer.status !== 200)
    wrong.push(`the record: ${String(answer.status)} ${String(answer.code)}`);
  if ((await readiness(w)).open_items.includes(item)) wrong.push('the record left it open');
  return wrong;
}

/**
 * Rows the table refuses by itself, whatever writes them: a receipt for the
 * opt-in, a line with no owner's line or no date, and a line on one of the
 * eight. The check fires before the key, so a recorded item still answers it.
 */
export async function tableRefusals(w: GateWorld): Promise<string[]> {
  const rows: readonly (readonly [string, string, string | null])[] = [
    ['privacy-opt-in', 'https://mail.example/receipt', line('privacy-opt-in')],
    ['training-line', evidence('t'), null],
    ['training-line', evidence('t'), 'Training is off.'],
    ['phone-alerts', evidence('p'), 'a line on one of the eight'],
  ];
  const answers: string[] = [];
  for (const row of rows) {
    // oxlint-disable-next-line no-await-in-loop
    const answer = await admin(
      w,
      'insert into ops.gate_items (item, evidence, statement) values ($1, $2, $3)',
      [...row],
    ).then(
      () => 'stored',
      (error: unknown) =>
        /violates check constraint/u.test(String(error)) ? 'refused' : String(error),
    );
    answers.push(answer);
  }
  return answers;
}
