// SPDX-License-Identifier: AGPL-3.0-only
//
// The statement log, and the reading of SQL that makes it worth having.
//
// The law is that numbered migrations are the only schema truth and the
// running application issues no DDL of any kind, indexes included. Privilege
// is the barrier: the application role owns nothing and may create nothing.
// This log is the evidence, and it is only evidence if it reads a statement
// the way the server will. A log that splits on `;` cannot tell a semicolon
// inside a dollar-quoted function body from the end of a statement, and a
// gate that can be fooled by a string literal is not a gate.

/**
 * What a statement does, coarsely enough to hold the no-runtime-DDL law.
 *
 * `opaque` is its own answer rather than a guess. `DO`, `CALL` and `EXECUTE`
 * run something this reading cannot see, so they are neither cleared nor
 * accused: the assertion refuses them alongside DDL, and says which it found.
 */
export type StatementKind = 'ddl' | 'opaque' | 'data' | 'transaction' | 'session' | 'other';

export interface Statement {
  readonly text: string;
  readonly kind: StatementKind;
}

export interface RecordedStatement extends Statement {
  /** Where the statement came from: `runtime`, `migration:0001_tenancy`, and so on. */
  readonly source: string;
  readonly at: number;
}

export interface StatementLog {
  /** Record one string as sent to the server. It may hold several statements. */
  record(source: string, sql: string): void;
  readonly entries: readonly RecordedStatement[];
  /** Everything this log cannot clear of changing the schema. */
  schemaChanging(): readonly RecordedStatement[];
}

const DDL_VERBS: ReadonlySet<string> = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'COMMENT',
  'SECURITY',
  'REINDEX',
  'CLUSTER',
  'REFRESH',
  'IMPORT',
]);

const OPAQUE_VERBS: ReadonlySet<string> = new Set(['DO', 'CALL', 'EXECUTE']);

const DATA_VERBS: ReadonlySet<string> = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'WITH',
  'VALUES',
  'TABLE',
  'COPY',
]);

const TRANSACTION_VERBS: ReadonlySet<string> = new Set([
  'BEGIN',
  'START',
  'COMMIT',
  'END',
  'ROLLBACK',
  'ABORT',
  'SAVEPOINT',
  'RELEASE',
]);

const SESSION_VERBS: ReadonlySet<string> = new Set([
  'SET',
  'RESET',
  'DISCARD',
  'SHOW',
  'LISTEN',
  'UNLISTEN',
  'NOTIFY',
]);

// PostgreSQL's own scanner (src/backend/parser/scan.l, REL_18_STABLE) is the
// rule. An unquoted identifier starts with a letter, `_` or any character past
// ASCII and continues with those, digits and `$` (ident_start, ident_cont). A
// dollar-quote tag is the same without `$`, so it cannot hold one, and it can
// never start with a digit, which keeps `$1` a parameter (dolq_start,
// dolq_cont). The scanner takes the longest match, so `$$` straight after an
// identifier continues the identifier and opens nothing: a dollar quote starts
// only where a token does (syntax.sgml, "Dollar-Quoted String Constants").
const IDENTIFIER = /[A-Za-z_\u{80}-\u{10FFFF}][A-Za-z_0-9$\u{80}-\u{10FFFF}]*/uy;
const DECIMAL_DIGITS = /[0-9][0-9_]*/uy;
const DOLLAR_TAG = /\$([A-Za-z_\u{80}-\u{10FFFF}][A-Za-z_0-9\u{80}-\u{10FFFF}]*)?\$/uy;

/** How many characters a sticky pattern matches at `at`, or 0. */
function lengthAt(pattern: RegExp, sql: string, at: number): number {
  pattern.lastIndex = at;
  return pattern.exec(sql)?.[0].length ?? 0;
}

// `SELECT ... INTO new_table` creates a table without saying CREATE. It is the
// one DDL statement whose leading verb reads as a read.
const SELECT_INTO = /^SELECT\b[\s\S]*?\bINTO\b/iu;

function skipLineComment(sql: string, from: number): number {
  const newline = sql.indexOf('\n', from);
  return newline < 0 ? sql.length : newline + 1;
}

// Block comments nest in PostgreSQL, so a depth counter is the only correct
// reading. `/* /* */ */` closes once, not twice.
function skipBlockComment(sql: string, from: number): number {
  let depth = 0;
  let at = from;
  while (at < sql.length) {
    if (sql.startsWith('/*', at)) {
      depth += 1;
      at += 2;
    } else if (sql.startsWith('*/', at)) {
      depth -= 1;
      at += 2;
      if (depth === 0) return at;
    } else {
      at += 1;
    }
  }
  return sql.length;
}

// A quote doubled inside a quoted run is a literal quote, not the end of it.
// A backslash escapes only inside an E'' string, which is why the caller says
// whether one is open.
function skipQuoted(sql: string, from: number, quote: string, backslashEscapes: boolean): number {
  let at = from + 1;
  while (at < sql.length) {
    const ch = sql[at];
    if (backslashEscapes && ch === '\\') {
      at += 2;
      continue;
    }
    if (ch === quote) {
      if (sql[at + 1] === quote) {
        at += 2;
        continue;
      }
      return at + 1;
    }
    at += 1;
  }
  return sql.length;
}

function skipDollarQuoted(sql: string, from: number): number {
  const length = lengthAt(DOLLAR_TAG, sql, from);
  if (length === 0) return from;
  const tag = sql.slice(from, from + length);
  const close = sql.indexOf(tag, from + tag.length);
  return close < 0 ? sql.length : close + tag.length;
}

export interface Token {
  /**
   * `comment` is either comment form, nested block comments included;
   * `quoted` is a string, an E'' string, a quoted identifier or a
   * dollar-quoted body; `word` is an identifier, keyword or number, which
   * may run through `$`; `other` is one character of anything else.
   */
  readonly kind: 'comment' | 'quoted' | 'word' | 'other';
  readonly end: number;
}

/**
 * The token that starts at `from`, read as PostgreSQL's scanner reads it as
 * far as finding statements needs. A word is taken whole, so that a `$` or a
 * quote after it is read where the server reads it.
 */
export function scanToken(sql: string, from: number): Token {
  const rest = sql.slice(from, from + 2);
  if (rest === '--') return { kind: 'comment', end: skipLineComment(sql, from) };
  if (rest === '/*') return { kind: 'comment', end: skipBlockComment(sql, from) };
  const ch = sql[from] ?? '';
  // Only a lone E opens an escape string (xestart). The e that ends a longer
  // word is part of the word, and the quote after it opens a plain string.
  if (rest === "e'" || rest === "E'") {
    return { kind: 'quoted', end: skipQuoted(sql, from + 1, "'", true) };
  }
  if (ch === "'" || ch === '"') return { kind: 'quoted', end: skipQuoted(sql, from, ch, false) };
  if (ch === '$') {
    const after = skipDollarQuoted(sql, from);
    return after === from ? { kind: 'other', end: from + 1 } : { kind: 'quoted', end: after };
  }
  const word = lengthAt(IDENTIFIER, sql, from);
  if (word > 0) return { kind: 'word', end: from + word };
  // A number ends before a `$`, which may then open a dollar quote; letters
  // straight after its digits are PostgreSQL's trailing junk, one token.
  const digits = lengthAt(DECIMAL_DIGITS, sql, from);
  if (digits > 0) {
    return { kind: 'word', end: from + digits + lengthAt(IDENTIFIER, sql, from + digits) };
  }
  return { kind: 'other', end: from + 1 };
}

/**
 * Split one string into the statements the server would see, respecting
 * quoting, dollar quoting and both comment forms. Empty pieces are dropped.
 */
export function splitStatements(sql: string): readonly string[] {
  const found: string[] = [];
  let start = 0;
  let at = 0;
  // The text kept is what was sent, comments and all, because this is an
  // evidence log and a scrubbed copy is not what the server saw. A piece with
  // no verb in it is not a statement, though: a trailing `;` after a comment
  // would otherwise be recorded as one, and a log full of those is a log
  // nobody reads.
  const take = (end: number): void => {
    const piece = sql.slice(start, end).trim();
    if (piece !== '' && leadingVerb(piece) !== '') found.push(piece);
  };
  while (at < sql.length) {
    const token = scanToken(sql, at);
    if (token.kind === 'other' && sql[at] === ';') {
      take(at);
      start = token.end;
    }
    at = token.end;
  }
  take(sql.length);
  return found;
}

/** The leading word of a statement, with comments and leading noise removed. */
export function leadingVerb(statement: string): string {
  let at = 0;
  while (at < statement.length) {
    if (statement.startsWith('--', at)) {
      at = skipLineComment(statement, at);
    } else if (statement.startsWith('/*', at)) {
      at = skipBlockComment(statement, at);
    } else if (/\s/u.test(statement[at] ?? '') || statement[at] === '(') {
      at += 1;
    } else {
      break;
    }
  }
  const word = /^[A-Za-z_]+/u.exec(statement.slice(at));
  return word === null ? '' : word[0].toUpperCase();
}

export function classifyStatement(statement: string): StatementKind {
  const verb = leadingVerb(statement);
  if (DDL_VERBS.has(verb)) return 'ddl';
  if (OPAQUE_VERBS.has(verb)) return 'opaque';
  if (DATA_VERBS.has(verb)) {
    return verb === 'SELECT' && SELECT_INTO.test(statement.trimStart()) ? 'ddl' : 'data';
  }
  if (TRANSACTION_VERBS.has(verb)) return 'transaction';
  if (SESSION_VERBS.has(verb)) return 'session';
  return 'other';
}

export function classify(sql: string): readonly Statement[] {
  return splitStatements(sql).map((text) => ({ text, kind: classifyStatement(text) }));
}

export function createStatementLog(): StatementLog {
  const entries: RecordedStatement[] = [];
  return {
    record(source: string, sql: string): void {
      const at = Date.now();
      for (const statement of classify(sql)) entries.push({ ...statement, source, at });
    },
    entries,
    schemaChanging(): readonly RecordedStatement[] {
      return entries.filter((entry) => entry.kind === 'ddl' || entry.kind === 'opaque');
    },
  };
}
