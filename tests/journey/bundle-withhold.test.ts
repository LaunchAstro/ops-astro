// SPDX-License-Identifier: AGPL-3.0-only
//
// T4d (Sol, reviews 1 and 2 on #164; orchestrator ORCH23-T4-R2): the evidence
// bundle carries only identifiers and digests wherever a decision's note, or
// any person's words, could reach it: a case detail quoting an answer or a
// failed comparison, the open items built from those details, the identity
// line, the environment and the budgets. Hostile quoting included.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { writeBundle } from '../../scripts/local/journey-bundle.ts';

const NOTE = 'Client Quokka confidential treatment plan';
const BODY = 'Client Wombat private message';
const DECISION = '6407cf7e-e3c0-4300-b2c0-007d8fce42ee';
const TREE = 'bfcf6b28d6785cc18c95fcfaf1586f2bdd1c4998';

function bundleWith(details: readonly string[], extra: Record<string, string> = {}) {
  return writeBundle({
    head: 'a'.repeat(40),
    tree: TREE,
    clean: true,
    identity: `{"apiTree":"${TREE}","clean":true,"defects":[]}`,
    environment: { node: 'v26', note: extra['environment'] ?? 'none' },
    cases: details.map((detail, index) => ({
      case: `case ${String(index)}`,
      status: 'fail',
      detail,
    })),
    budgets: [
      {
        operation: 'x',
        budget: '1 ms',
        measured: extra['budget'] ?? '2 ms',
        status: 'fail',
        against: 'y',
        load: 'z',
      },
    ],
    crashPoints: '',
    approval: {
      taskId: '874004a1-df51-4a88-9b2c-dfce337bec13',
      decisionId: DECISION,
      decision: 'approve',
      action: JSON.stringify({ id: DECISION, decision: 'approve', note: NOTE }),
    },
  });
}

const both = (bundle: { json: string; markdown: string }): string =>
  `${bundle.json}\n${bundle.markdown}`;

// eslint-disable-next-line max-lines-per-function -- one bundle shape, the hostile cases that share it
describe('the bundle withholds what a person wrote, wherever it arrives', () => {
  it('withholds a body quoted in a separation leak, and keeps the identifiers it holds elsewhere', () => {
    const text = both(
      bundleWith([
        `app client: {"refused":true,"code":"NOT_FOUND","body":"${BODY}","recordId":"${DECISION}"}`,
      ]),
    );
    expect(text).not.toContain(BODY);
    expect(text).not.toContain('NOT_FOUND');
    expect(text).toContain(DECISION);
    expect(text).toContain(TREE);
  });

  it('withholds a note inside escaped JSON, and a copy of it with no quotes at all', () => {
    const escaped = JSON.stringify({ answer: JSON.stringify({ note: NOTE }) });
    const text = both(bundleWith([escaped, `decide refused after the note ${NOTE} was read`]));
    expect(text).not.toContain(NOTE);
  });

  it('withholds a note written with unicode escapes, and its plain copy elsewhere', () => {
    // Not the approval's note: this one reaches the bundle only through case details.
    const other = 'Client Numbat second opinion';
    const encoded = other.replaceAll('C', '\\u0043');
    const text = both(bundleWith([`{"note":"${encoded}"}`, `and later, unquoted: ${other}`]));
    expect(text).not.toContain(other);
    expect(text).not.toContain(encoded);
  });

  it('withholds a note reaching the environment or the budgets', () => {
    const text = both(
      bundleWith([], { environment: `{"note":"${BODY}"}`, budget: `{"body":"${BODY}"}` }),
    );
    expect(text).not.toContain(BODY);
  });

  it('keeps a case detail as its digest alone, whatever its words are spelled like', () => {
    const title = 'Client ACME defaced plan for the decade';
    const detail = `task.read refused NOT_FOUND for ${DECISION} while handling ${title}, CLIENT_X_SECRET, 106 ms, see tests/journey/run.ts and T2g (#136)`;
    const bundle = bundleWith([detail]);
    const text = both(bundle);
    for (const word of [
      'Client',
      'ACME',
      'CLIENT_X_SECRET',
      'NOT_FOUND',
      '106 ms',
      'run.ts',
      '#136',
      title,
    ]) {
      expect(text).not.toContain(word);
    }
    const [line] = (JSON.parse(bundle.json) as { behaviour: { detail: string }[] }).behaviour;
    const digest = createHash('sha256').update(detail, 'utf8').digest('hex').slice(0, 16);
    expect(line?.detail).toBe(`detail sha256 ${digest}`);
  });

  it('shows the typed facts the command set beside a case, and takes the owner from them', () => {
    const bundle = writeBundle({
      head: 'a'.repeat(40),
      tree: TREE,
      clean: true,
      identity: '{}',
      environment: {},
      cases: [
        {
          case: 'T2g: request changes',
          status: 'unrun',
          detail: 'owned by CLIENT_X_SECRET',
          facts: { owner: 'T2g', pr: '#136', ms: 106, clean: true },
        },
      ],
      budgets: [],
      crashPoints: '',
      approval: {
        taskId: 'task-1',
        decisionId: DECISION,
        decision: 'approve',
        action: JSON.stringify({ decision: 'approve', note: 'routine' }),
      },
    });
    const parsed = JSON.parse(bundle.json) as {
      behaviour: { facts?: Record<string, unknown> }[];
      openItems: { owner: string }[];
    };
    expect(parsed.behaviour[0]?.facts).toStrictEqual({
      owner: 'T2g',
      pr: '#136',
      ms: 106,
      clean: true,
    });
    expect(parsed.openItems[0]?.owner).toBe('T2g');
    expect(`${bundle.json}${bundle.markdown}`).not.toContain('CLIENT_X_SECRET');
  });
});
