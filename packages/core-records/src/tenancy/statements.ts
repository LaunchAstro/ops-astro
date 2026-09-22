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

// A dollar-quote tag is an identifier or nothing. It can never start with a
// digit, which is what keeps `$1` a parameter placeholder rather than the
// opening of a quoted run.
const DOLLAR_TAG = /^\$([\p{L}_][\p{L}\p{N}_]*)?\$/u;

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
  const opener = DOLLAR_TAG.exec(sql.slice(from));
  if (opener === null) return from;
  const tag = opener[0];
  const close = sql.indexOf(tag, from + tag.length);
  return close < 0 ? sql.length : close + tag.length;
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
    const ch = sql[at];
    if (ch === undefined) break;
    if (sql.startsWith('--', at)) {
      at = skipLineComment(sql, at);
    } else if (sql.startsWith('/*', at)) {
      at = skipBlockComment(sql, at);
    } else if (ch === "'" || ch === '"') {
      const previous = at > 0 ? sql[at - 1] : undefined;
      const escapes = ch === "'" && (previous === 'e' || previous === 'E');
      at = skipQuoted(sql, at, ch, escapes);
    } else if (ch === '$') {
      const after = skipDollarQuoted(sql, at);
      at = after === at ? at + 1 : after;
    } else if (ch === ';') {
      take(at);
      at += 1;
      start = at;
    } else {
      at += 1;
    }
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
