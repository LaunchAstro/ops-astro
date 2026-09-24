// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, lane FR2-DOCS-2: the API.md lines the FR2 lanes handed
// back (trash, api, propose, jsonb, runtime, place), each held against the code
// it describes, so a doc line that drifts from the code fails here.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** Prose with its line breaks folded, so a phrase is found across a wrap. */
const folded = (text: string): string => text.replaceAll(/\s+/gu, ' ');

const API = (): string => read('docs/local/API.md');

const C = 'packages/core-records/src/commands';
const R = 'packages/core-runtime/src';

/** Every table row of `API.md` whose first cell starts with `operation`. */
const rowsOf = (operation: string): string[] =>
  API()
    .split('\n')
    .filter((line) => line.startsWith(`| \`${operation}\``));

/** The refusals cell (the last) of the row whose first cell is `operation` and that names `route`. */
function refusals(operation: string, route: string): string {
  const row = rowsOf(operation).find((line) => line.includes(`\`${route}\``));
  if (row === undefined) throw new Error(`API.md has no ${operation} row naming ${route}`);
  return (
    row
      .split('|')
      .map((cell) => cell.trim())
      .at(-2) ?? ''
  );
}

/** The body of the function `name` declares in `source`, to its closing brace. */
function bodyOf(source: string, name: string): string {
  const start = source.search(new RegExp(`function ${name}\\(`, 'u'));
  if (start < 0) throw new Error(`no function ${name}`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end < 0 ? undefined : end);
}

const fn = (path: string, name: string): string => bodyOf(read(path), name);

/** Every code a body answers with directly, by `refuse('X'` or `refuseCommand('X'`. */
const codesIn = (body: string): string[] => [
  ...new Set([...body.matchAll(/refuse(?:Command)?\(\s*'([A-Z_]+)'/gu)].map((m) => m[1] ?? '')),
];

/** The keys of the object literal `return applied(…, …, {` answers in `body`, in order. */
function appliedKeys(body: string): string[] {
  const open = body.indexOf('{', body.indexOf('return applied('));
  const close = body.indexOf('});', open);
  return [...body.slice(open + 1, close).matchAll(/^\s*(\w+)[,:]/gmu)].map((m) => m[1] ?? '');
}

/** The quoted names in the literal that follows `start` in `source`, up to `end`. */
function quotedAfter(source: string, start: string, end: string): string[] {
  const block = source.slice(source.indexOf(start));
  return [...block.slice(0, block.indexOf(end)).matchAll(/'([\w.]+)'/gu)].map((m) => m[1] ?? '');
}

/** The folded paragraph of `API.md` that contains `marker`. */
function paragraphWith(marker: string): string {
  const paragraph = API()
    .split(/\n\s*\n/u)
    .find((block) => folded(block).includes(marker));
  if (paragraph === undefined) throw new Error(`API.md has no paragraph with ${marker}`);
  return folded(paragraph);
}

type Claim = string | RegExp;
const holds = (text: string, claim: Claim): void => {
  if (typeof claim === 'string') expect(text).toContain(claim);
  else expect(text).toMatch(claim);
};

const T = 'packages/core-records/src/tasks';
const E = 'packages/core-records/src/records';

/** Code facts each doc line rests on: [file, function or '' for the whole file, claim]. */
const CODE: readonly (readonly [string, string, Claim])[] = [
  [`${C}/tasks-trash.ts`, '', 'const LONGEST_COMPUTED_WINDOW_DAYS = 2_000_000;'],
  [`${C}/tasks-trash.ts`, 'cutoff', 'if (days > LONGEST_COMPUTED_WINDOW_DAYS) return undefined;'],
  [`${T}/trash.ts`, 'purgeTrashedRecords', /< \$3\s+order by id\s+for update/u],
  [`${T}/trash.ts`, 'restoreBatch', /order by id\s+for share/u],
  [`${E}/business-settings.ts`, 'writeBusinessSetting', /isSafeInteger\(write\.expectedRevision/u],
  [`${E}/business-settings.ts`, 'writeBusinessSetting', "names: ['expectedRevision'],"],
  [`${C}/tasks-propose.ts`, 'proposeOnTask', 'deleted_at !== null) return refused(refuseNotFound'],
  [`${R}/propose.ts`, 'refuseBeyondBudget', /currency !== cap\.currency\)\s+\{\s+return refuse\(/u],
  [`${C}/prepare.ts`, '', "'task.propose': { optional: ['lineageId'] },"],
  [`${C}/prepare.ts`, 'refuseMistypedIdentifier', "refuseCommand('FIELD_VALUE_INVALID'"],
  [`${C}/prepare.ts`, 'prepareCommand', /checkAuthority[\s\S]*refuseMistypedIdentifier\(/u],
  [`${C}/prepare.ts`, 'prepareCommand', /refuseUnstorableOperands\(request\)[\s\S]*lockTask\(/u],
  [`${C}/prepare.ts`, 'refuseOtherTarget', "refuseCommand('COMMAND_BODY_INVALID', other"],
  [`${C}/agent-operations.ts`, 'handbackOperands', "unstorableOperands(request, ['report',"],
  [`${C}/values.ts`, 'isTimestamp', '(zoneHours ?? 0) <= 15'],
  [`${C}/values.ts`, 'isTimestamp', 'hour === 24 && minute === 0 && second === 0'],
  [`${C}/tasks-state.ts`, '', 'const REASON_LIMIT = 500;'],
  [`${C}/tasks-state.ts`, 'setState', /'started' && current\?\.machineCategory === 'completed'/u],
  [`${C}/tasks-state.ts`, 'setState', "reason.trim() === ''"],
  [`${R}/recovery.ts`, 'cancelAndClassify', /checkAuthorityAt\([\s\S]{0,400}'SCOPE_NOT_GRANTED'/u],
  [`${R}/decide.ts`, 'decide', 'if (live[0] === undefined) return gateNotFound();'],
  [`${R}/decide.ts`, 'decide', 'gateId: presented.gateId.toLowerCase()'],
  [`${C}/tasks-controls.ts`, 'lineageOnTask', 'recordId.toLowerCase()'],
  [`${C}/tasks-write.ts`, '', "PLACED_BY_OPERAND: readonly string[] = ['board', 'board_section']"],
  [`${C}/tasks-write.ts`, 'createTask', "['state=task.complete']"],
  [`${T}/placement.ts`, 'planTaskPlacement', "refuse('NOT_FOUND', ['board']"],
  [`${C}/tasks-place.ts`, 'reparentTask', 'refuseUnreachedRecord(tx, context, parentId)'],
  [`${C}/tasks-place.ts`, 'reparentTask', 'refuseUnreachedRecord(tx, context, placement.board)'],
  [`${C}/tasks-place.ts`, 'reparentTask', 'carryBoardToDescendants('],
  [`${C}/tasks-place.ts`, 'moveTask', /'PLACEMENT_IS_DERIVED',\s+\['board'\]/u],
  [`${C}/tasks-place.ts`, 'moveTask', 'carryBoardToDescendants('],
  [`${C}/tasks-place.ts`, 'rankTask', 'refuseUnreachedRecord(tx, context, id)'],
];

/** Refusal cells: [operation, claim]; the route is the operation's name with a slash. */
const ROWS: readonly (readonly [string, Claim])[] = [
  ['settings.set_four_eyes_threshold', /`FIELD_VALUE_INVALID` 422 \([^)]*`expectedRevision`/u],
  ['settings.set_client_sign_off', /`FIELD_VALUE_INVALID` 422 \([^)]*`expectedRevision`/u],
  ['task.propose', /naming `purpose`[^)]*`currency`[^)]*`payload`[^)]*`step`[^)]*`lineageId`/u],
  ['task.propose', /`PROPOSAL_OUT_OF_SCOPE` 403 \([^)]*currency/u],
  ['task.propose', /`NOT_FOUND` 404 \([^)]*trashed/u],
  ['task.rank', /`FIELD_VALUE_INVALID` 422 naming `afterId` or `beforeId`/u],
  ['task.rank', /not a live sibling/u],
  ['task.rank', /no rank left/u],
  ['task.decide', /`FIELD_VALUE_INVALID` 422 naming `gateId`/u],
  ['task.comment', /`body`[^)]*NUL/u],
  ['task.cancel', /`reason`[^)]*NUL/u],
  ['task.handback', /`report` or `successor\.<key>`/u],
  ['grant.revoke', /`COMMAND_BODY_INVALID` 400 \([^)]*`delegationId`/u],
  ['delegation.revoke', /`COMMAND_BODY_INVALID` 400 \([^)]*`grantId`/u],
  ['task.start', /`task\.start` also when the task is completed/u],
  ['task.reopen', /`FIELD_VALUE_INVALID` 422 naming `reason`[^|]*1 to 500/u],
  ['task.create', /`PLACEMENT_IS_DERIVED` 422 \([^)]*`board` or `board_section` in `fields`/u],
  ['task.create', /`NOT_FOUND` 404 \([^)]*`board` for a board not live here/u],
  ['task.create', /`TRANSITION_PROTECTED` 422 \([^)]*`state=task\.complete`/u],
  ['task.reparent', /may not write the new parent[^|]*the board it brings[^|]*descendant/u],
  ['task.move', /`PLACEMENT_IS_DERIVED` 422 \([^)]*naming `board` for a subtask/u],
  ['task.move', /or a live descendant/u],
];

/** Paragraphs: [marker, claim]. */
const PROSE: readonly (readonly [string, Claim])[] = [
  ['`detail` is `{ purged', /removes the purged tasks' comments/u],
  ['`detail` is `{ purged', /record-scoped grants/u],
  ['`detail` is `{ purged', /restore that commits first keeps its task/u],
  ['`LONGEST_COMPUTED_WINDOW_DAYS`', /longer than 2,000,000 days[^.]*purges nothing/u],
  ['`LONGEST_COMPUTED_WINDOW_DAYS`', /answered, not refused/u],
  ['`{ batchId, restored, restoredIds }`', /locked `for share`[\s\S]*`PARENT_TRASHED`/u],
  ['last-writer-wins write', /is `FIELD_VALUE_INVALID` 422 naming `expectedRevision`/u],
  ['`TYPED_IDENTIFIERS`', /`task\.propose`[^.]*`FIELD_VALUE_INVALID` naming `lineageId`/u],
  ['**Cancellation**', /`task\.restart` and `task\.propose` on a trashed task/u],
  ['**Cancellation**', /checked again under the runtime locks[^.]*`SCOPE_NOT_GRANTED`/u],
  ['`CAP_BINDING_MISMATCH` 409 is', /second barrier, and no command reaches it/u],
  ['`CAP_BINDING_MISMATCH` 409 is', /another one `PROPOSAL_OUT_OF_SCOPE`/u],
  ['`FREE_OPERANDS`', /`successor\.<key>`/u],
  ['`FREE_OPERANDS`', /after authority and before the target is read/u],
  ["The request's shape is checked", /`successor`[^.]*NUL[^.]*`FIELD_VALUE_INVALID` 422/u],
  ["The request's shape is checked", /nothing is retained/u],
  ['`timestamptz` value', /from year 1[^.]*24:00:00[^.]*15:59/u],
  ['`timestamptz` value', /`key=timestamptz`/u],
  ['`GATE_NOT_VISIBLE`', /trashed task[^.]*waits on its locks/u],
  ['sharedTask: { id', /`revision` is the record's version[^.]*`expectedRevision`/u],
  ['A uuid is one identifier however it is cased', /compare the lower-case form/u],
];

describe('FR2 handback lines in API.md', () => {
  it.each(CODE)('%s %s holds %s', (path, name, claim) => {
    holds(name === '' ? read(path) : fn(path, name), claim);
  });

  it.each(ROWS)('the %s row holds %s', (operation, claim) => {
    holds(refusals(operation, `/${operation.replace('.', '/')}`), claim);
  });

  it.each(PROSE)('the paragraph with %s holds %s', (marker, claim) => {
    holds(paragraphWith(marker), claim);
  });
});

describe('API.md lines derived from the code', () => {
  it('gives the purge and restore details the code answers', () => {
    const trash = read(`${C}/tasks-trash.ts`);
    const purge = appliedKeys(bodyOf(trash, 'purgeTasks'));
    expect(purge).toEqual(['purged', 'purgedIds', 'retained', 'commentsPurged', 'grantsRevoked']);
    expect(folded(API())).toContain(`\`detail\` is \`{ ${purge.join(', ')} }\``);
    const restore = appliedKeys(bodyOf(trash, 'restoreTasks'));
    expect(restore).toEqual(['batchId', 'restored', 'restoredIds']);
    expect(folded(API())).toContain(`\`{ ${restore.join(', ')} }\``);
  });

  it('gives sharedTask the keys SharedTaskView declares', () => {
    const requests = read('packages/core-records/src/reads/requests.ts');
    const view = requests.slice(requests.indexOf('export interface SharedTaskView'));
    const keys = [...view.slice(0, view.indexOf('\n}')).matchAll(/^ {2}readonly (\w+)/gmu)].map(
      (m) => m[1] ?? '',
    );
    expect(keys).toEqual(['id', 'revision', 'fields', 'comments']);
    expect(folded(API())).toContain(`sharedTask: { ${keys.join(', ')} }`);
  });
});

describe('API.md operands and codes derived from the code', () => {
  it('lists each typed identifier in the operand table, and every free operand', () => {
    const prepare = read(`${C}/prepare.ts`);
    const typed = quotedAfter(prepare, 'const TYPED_IDENTIFIERS', '};');
    expect(typed).toEqual([
      'task.rank',
      'afterId',
      'beforeId',
      'task.propose',
      'lineageId',
      'task.create',
      'parentId',
      'board',
      'boardSection',
      'task.decide',
      'gateId',
      'versionId',
    ]);
    let operation = '';
    for (const name of typed) {
      if (name.startsWith('task.')) operation = name;
      else {
        const row = rowsOf(operation).find((line) => line.includes('refuseMistypedIdentifier'));
        expect(row, `${operation} ${name}`).toContain(`\`${name}\``);
      }
    }
    const free = quotedAfter(prepare, 'const FREE_OPERANDS', '];');
    expect(free.length).toBeGreaterThan(0);
    const paragraph = paragraphWith('`FREE_OPERANDS`');
    for (const operand of free) expect(paragraph, operand).toContain(`\`${operand}\``);
  });

  it('names every code proposeOnTask answers through a command, and not the unreached one', () => {
    const codes = new Set([...codesIn(fn(`${C}/tasks-propose.ts`, 'proposeOnTask')), 'NOT_FOUND']);
    // Unreached: `prepareCommand` refuses a mistyped `lineageId` first (CODE above).
    codes.delete('COMMAND_BODY_INVALID');
    const cell = refusals('task.propose', '/task/propose');
    for (const code of codes) expect(cell, code).toContain(`\`${code}\``);
    expect(cell).not.toMatch(/`COMMAND_BODY_INVALID`[^,]*`lineageId`/u);
    const register = read(`${C}/register.ts`).replaceAll(/\n\s*\/\/ ?/gu, ' ');
    expect(register).toContain(
      'second barrier behind the proposal, and no command case reaches it',
    );
  });

  it('names every code rankTask answers, and says whether it lower-cases', () => {
    const body = fn(`${C}/tasks-place.ts`, 'rankTask');
    const codes = [...codesIn(body), 'SCOPE_NOT_GRANTED', 'FIELD_VALUE_INVALID'];
    expect(codes).toEqual(expect.arrayContaining(['PLACEMENT_IS_DERIVED', 'NOT_FOUND']));
    const cell = refusals('task.rank', '/task/rank');
    for (const code of codes) expect(cell, code).toContain(`\`${code}\``);
    const uuid = paragraphWith('A uuid is one identifier however it is cased');
    expect(/`task\.rank` does not yet/u.test(uuid)).toBe(!body.includes('toLowerCase()'));
  });
});
