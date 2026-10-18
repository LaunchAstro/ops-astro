// SPDX-License-Identifier: AGPL-3.0-only
//
// The column grants the migrations make, read from their text with no
// database, so the column-grant contract (restricted-calls-catalogue.ts) is
// checked on every pull request. The database suites still hold the contract
// against the migrated catalogue in the merge queue; this finds a grant the
// contract does not name before a group is built on it. It reads the way
// PostgreSQL does (scanToken) and fails closed: a column grant it cannot read,
// or one made from quoted SQL, is an error, never skipped. It reads grants
// only, so a column grant a later migration revokes still needs its contract
// line here.

import {
  leadingVerb,
  scanToken,
  splitStatements,
} from '../../packages/core-records/src/tenancy/statements.ts';

interface Token {
  /** `word` is folded to lower case; `name` is a quoted identifier, unquoted. */
  readonly kind: 'word' | 'name' | 'quoted' | 'other';
  readonly text: string;
}

const SPACE = /^[ \t\n\r\f\v]$/u;
const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] as const;

function tokens(sql: string): Token[] {
  const found: Token[] = [];
  for (let at = 0; at < sql.length;) {
    const token = scanToken(sql, at);
    const text = sql.slice(at, token.end);
    at = token.end;
    if (token.unterminated === true) throw new Error('an unterminated block comment');
    if (token.kind === 'comment' || SPACE.test(text)) continue;
    if (token.kind === 'word') found.push({ kind: 'word', text: text.toLowerCase() });
    else if (token.kind === 'quoted' && text.startsWith('"'))
      found.push({ kind: 'name', text: text.slice(1, -1).replaceAll('""', '"') });
    else found.push({ kind: token.kind, text });
  }
  return found;
}

/** The SQL a string or dollar-quoted body holds, as the server would run it from `execute`. */
function inner(quoted: string): string {
  const dollar = /^(\$[^$]*\$)([\s\S]*)\1$/u.exec(quoted);
  if (dollar !== null) return dollar[2] ?? '';
  return quoted.replaceAll(/^[EeBbXxNn]?'|'$/gu, '').replaceAll("''", "'");
}

const isWord = (token: Token | undefined, text: string): boolean =>
  token?.kind === 'word' && token.text === text;

/** Split at top-level commas, refusing an unbalanced parenthesis. */
function commaSeparated(list: readonly Token[]): Token[][] {
  const parts: Token[][] = [[]];
  let depth = 0;
  for (const token of list) {
    if (token.kind === 'other' && token.text === '(') depth += 1;
    if (token.kind === 'other' && token.text === ')') depth -= 1;
    if (depth < 0) throw new Error('an unbalanced parenthesis');
    if (depth === 0 && token.kind === 'other' && token.text === ',') parts.push([]);
    else parts.at(-1)?.push(token);
  }
  if (depth !== 0) throw new Error('an unbalanced parenthesis');
  return parts;
}

function identifier(token: Token | undefined): string {
  if (token?.kind === 'word' || token?.kind === 'name') return token.text;
  throw new Error(`"${token?.text ?? 'nothing'}" where a name should be`);
}

/** `schema.table`, refusing a name without its schema: the search path is not in the text. */
function table(part: readonly Token[]): string {
  const [schema, dot, name, ...rest] = part;
  if (dot?.text !== '.' || rest.length > 0) {
    throw new Error(`a column grant on "${part.map((t) => t.text).join('')}", not schema.table`);
  }
  return `${identifier(schema)}.${identifier(name)}`;
}

function role(part: readonly Token[]): string {
  const [first, second, ...rest] = isWord(part[0], 'group') ? part.slice(1) : part;
  if (second !== undefined || rest.length > 0 || first === undefined)
    throw new Error('a grantee that is not one role name');
  if (first.kind === 'word' && /^(?:current_user|current_role|session_user)$/u.test(first.text))
    throw new Error(`a column grant to ${first.text}, which the text cannot name`);
  return identifier(first);
}

/** One privilege item's privileges and columns: `update (a, b)`, `all privileges (a)`. */
function privilege(item: readonly Token[]): { privileges: string[]; columns: string[] } {
  const open = item.findIndex((t) => t.kind === 'other' && t.text === '(');
  const words = (open < 0 ? item : item.slice(0, open)).map((t) => t.text);
  if (open < 0) return { privileges: words, columns: [] };
  if (item.at(-1)?.text !== ')') throw new Error('text after a column list');
  const columns = commaSeparated(item.slice(open + 1, -1)).map((part) => {
    if (part.length !== 1) throw new Error('a column that is not one name');
    return identifier(part[0]);
  });
  const named = words.join(' ').toUpperCase();
  if (named === 'ALL' || named === 'ALL PRIVILEGES')
    return { privileges: [...COLUMN_PRIVILEGES], columns };
  if (!(COLUMN_PRIVILEGES as readonly string[]).includes(named) || words.length !== 1)
    throw new Error(`"${words.join(' ')}" is not a column privilege`);
  return { privileges: [named], columns };
}

/**
 * The column grants one `grant` statement makes, as `grantee PRIVILEGE
 * schema.table.column`, the catalogue's form. A grant with no column list
 * makes none. A role grant (no `on`) carries no column list either.
 */
function grantLines(list: readonly Token[]): string[] {
  const on = list.findIndex((t) => isWord(t, 'on'));
  const to = list.findIndex((t) => isWord(t, 'to'));
  if (!isWord(list[0], 'grant')) throw new Error('a grant that does not start with GRANT');
  if (on < 0) {
    if (list.some((t) => t.kind === 'other' && t.text === '('))
      throw new Error('a role grant with a parenthesis');
    return [];
  }
  const items = commaSeparated(list.slice(1, on)).map((item) => privilege(item));
  if (items.every((item) => item.columns.length === 0)) return [];
  if (to < on) throw new Error('a column grant with no TO');
  const object = isWord(list[on + 1], 'table') ? on + 2 : on + 1;
  const tables = commaSeparated(list.slice(object, to)).map((part) => table(part));
  const end = list.findIndex((t, at) => at > to && (isWord(t, 'with') || isWord(t, 'granted')));
  const tail = list
    .slice(end < 0 ? list.length : end)
    .map((t) => t.text)
    .join(' ');
  if (!/^(?:with grant option)?(?: ?granted by \S+)?$/u.test(tail))
    throw new Error(`"${tail}" after the grantees`);
  const roles = commaSeparated(list.slice(to + 1, end < 0 ? list.length : end)).map((part) =>
    role(part),
  );
  return items.flatMap(({ privileges, columns }) =>
    roles.flatMap((grantee) =>
      tables.flatMap((name) =>
        privileges.flatMap((act) => columns.map((column) => `${grantee} ${act} ${name}.${column}`)),
      ),
    ),
  );
}

/** Names and commas only, with format's `%I`, which can only ever be one quoted name. */
function onlyNames(list: readonly Token[]): boolean {
  return list.every(
    (t, at) =>
      t.kind === 'word' ||
      t.kind === 'name' ||
      t.text === ',' ||
      (t.text === '%' && isWord(list[at + 1], 'i')),
  );
}

/**
 * Refuse a grant made from quoted SQL (an `execute` of a string, or a function
 * body that runs one) unless the string alone shows it names no column: it
 * reaches TO, and what it grants and to whom are names, commas and `%I`. A
 * column list, a `%s` or `%L`, or a grant cut short for a concatenation, is
 * refused.
 */
function refuseQuoted(sql: string): void {
  for (const piece of splitStatements(sql)) {
    const list = tokens(piece);
    for (const token of list) if (token.kind === 'quoted') refuseQuoted(inner(token.text));
    const grant = list.findIndex((t) => isWord(t, 'grant'));
    if (grant < 0) continue;
    const rest = list.slice(grant + 1);
    const on = rest.findIndex((t) => isWord(t, 'on'));
    const to = rest.findIndex((t) => isWord(t, 'to'));
    if (
      to < 0 ||
      !onlyNames(rest.slice(0, on >= 0 && on < to ? on : to)) ||
      !onlyNames(rest.slice(to + 1))
    )
      throw new Error(
        'a grant made from quoted SQL that may name columns; write it as its own statement',
      );
  }
}

/** Every column grant in one migration's statements, or an error naming the statement. */
export function columnGrants(statements: readonly string[]): string[] {
  return statements.flatMap((statement, at) => {
    try {
      const list = tokens(statement);
      for (const token of list) if (token.kind === 'quoted') refuseQuoted(inner(token.text));
      return leadingVerb(statement) === 'GRANT' ? grantLines(list) : [];
    } catch (error) {
      const head = statement.replaceAll(/\s+/gu, ' ').slice(0, 80);
      throw new Error(`statement ${at + 1} (${head}): ${(error as Error).message}`, {
        cause: error,
      });
    }
  });
}
