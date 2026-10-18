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
//
// Quoted SQL is read as the server reads it: escapes in E'' and U&'' strings
// are decoded first. SQL built at run time cannot be read from text, so it is
// refused: every EXECUTE in a function or DO body takes a literal, or format()
// of a literal whose only placeholder is %I, with nothing joined to it; and a
// function body is SQL or PL/pgSQL. The database suites stay the gate in the
// merge queue.

import {
  splitStatements,
  leadingVerb,
} from '../../packages/core-records/src/tenancy/statements.ts';
import { isWord, tokens, type Token } from './sql-tokens.ts';

const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] as const;

/**
 * Migrations whose format() strings carry %s, read by hand: none makes a
 * column grant. Migrations never change once on main
 * (scripts/migrations-unchanged.mjs), so a version names fixed text.
 */
const FORMATS_READ_BY_HAND: ReadonlySet<string> = new Set([
  // Revokes each identity role membership it reads from pg_auth_members.
  '20261004102910_identity_roles_hold_no_membership',
]);

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

/** Where the parenthesis opened at `open` closes, or -1. */
function closing(list: readonly Token[], open: number): number {
  let depth = 0;
  for (let at = open; at < list.length; at += 1) {
    if (list[at]?.text === '(') depth += 1;
    if (list[at]?.text === ')') depth -= 1;
    if (depth === 0) return at;
  }
  return -1;
}

/** A format() string's placeholders: %I and %% alone, or any for a migration read by hand. */
function refuseFormat(text: string, anyFormat: boolean): void {
  for (const [, type] of text.matchAll(/%(?:\d+\$)?-?(?:\d+|\*(?:\d+\$)?)?([\s\S]?)/gu)) {
    if (type !== 'I' && type !== '%' && !anyFormat)
      throw new Error(`a format() placeholder %${type ?? ''}, which can carry any SQL`);
  }
}

/**
 * Refuse SQL built at run time: a PL/pgSQL EXECUTE takes a literal, or
 * format() of a literal, and nothing is joined to it before USING or INTO.
 * EXECUTE as a privilege (GRANT EXECUTE ON) or a trigger's EXECUTE FUNCTION
 * runs nothing.
 */
function refuseDynamic(list: readonly Token[], anyFormat: boolean): void {
  for (const [at, token] of list.entries()) {
    const before = list[at - 1];
    if (!isWord(token, 'execute') || isWord(before, 'grant') || isWord(before, 'revoke')) continue;
    if (
      before?.text === ',' ||
      ['on', 'function', 'procedure'].some((w) => isWord(list[at + 1], w))
    )
      continue;
    let next = isWord(list[at + 1], 'pg_catalog') && list[at + 2]?.text === '.' ? at + 3 : at + 1;
    if (isWord(list[next], 'format') && list[next + 1]?.text === '(') {
      const literal = list[next + 2];
      if (literal?.kind !== 'quoted') throw new Error('an EXECUTE of format() with no literal');
      refuseFormat(literal.text, anyFormat);
      next = closing(list, next + 1);
      if (next < 0) throw new Error('an unbalanced parenthesis');
    } else if (list[next]?.kind !== 'quoted') {
      throw new Error('an EXECUTE of SQL built at run time, which text cannot read');
    }
    const follow = list[next + 1];
    if (follow !== undefined && !isWord(follow, 'using') && !isWord(follow, 'into'))
      throw new Error('an EXECUTE with SQL joined to its literal, which text cannot read');
  }
}

/** A function or DO body in a language other than SQL or PL/pgSQL, which this reader cannot read. */
function refuseLanguage(list: readonly Token[]): void {
  const body =
    isWord(list[0], 'do') || list.some((t) => isWord(t, 'function') || isWord(t, 'procedure'));
  if (!body) return;
  for (const [at, token] of list.entries()) {
    const language = list[at + 1]?.text.toLowerCase();
    if (isWord(token, 'language') && language !== 'sql' && language !== 'plpgsql')
      throw new Error(`a body in language ${language ?? 'unnamed'}, which this reader cannot read`);
  }
}

/**
 * Refuse a grant made from quoted SQL (an `execute` of a string, or a function
 * body that runs one) unless the string alone shows it names no column: it
 * reaches TO, and what it grants and to whom are names, commas and `%I`. A
 * column list, a `%s` or `%L`, or a grant cut short for a concatenation, is
 * refused, as is SQL built at run time.
 */
function refuseQuoted(sql: string, anyFormat: boolean): void {
  for (const piece of splitStatements(sql)) {
    const list = tokens(piece);
    refuseLanguage(list);
    refuseDynamic(list, anyFormat);
    for (const token of list) if (token.kind === 'quoted') refuseQuoted(token.text, anyFormat);
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

/**
 * Every column grant in one migration's statements, or an error naming the
 * statement. `anyFormat` lets format() carry %s and %L, for a migration read by hand.
 */
export function columnGrants(
  statements: readonly string[],
  options: { readonly anyFormat?: boolean } = {},
): string[] {
  return statements.flatMap((statement, at) => {
    try {
      const list = tokens(statement);
      refuseLanguage(list);
      for (const token of list)
        if (token.kind === 'quoted') refuseQuoted(token.text, options.anyFormat === true);
      return leadingVerb(statement) === 'GRANT' ? grantLines(list) : [];
    } catch (error) {
      const head = statement.replaceAll(/\s+/gu, ' ').slice(0, 80);
      throw new Error(`statement ${at + 1} (${head}): ${(error as Error).message}`, {
        cause: error,
      });
    }
  });
}

/** Every column grant one migration makes. */
export function migrationColumnGrants(migration: {
  readonly version: string;
  readonly statements: readonly string[];
}): string[] {
  return columnGrants(migration.statements, {
    anyFormat: FORMATS_READ_BY_HAND.has(migration.version),
  });
}
