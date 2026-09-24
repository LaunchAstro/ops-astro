// SPDX-License-Identifier: AGPL-3.0-only
//
// The statement log is the evidence for the no-runtime-DDL law, so these are
// mostly cases where a careless reading would clear something it should not.
// A gate that only ever passes proves nothing.

import { describe, expect, it } from 'vitest';
import {
  classify,
  classifyStatement,
  createStatementLog,
  leadingVerb,
  splitStatements,
} from '../../packages/core-records/src/tenancy/statements.ts';

describe('splitStatements', () => {
  it('splits on the semicolons that end statements', () => {
    expect(splitStatements('select 1; select 2;')).toStrictEqual(['select 1', 'select 2']);
  });

  it('keeps a semicolon inside a string literal', () => {
    expect(splitStatements(`select 'a;b'`)).toStrictEqual([`select 'a;b'`]);
  });

  it('keeps a doubled quote from ending the literal early', () => {
    expect(splitStatements(`select 'it''s; fine'`)).toStrictEqual([`select 'it''s; fine'`]);
  });

  it('keeps a semicolon inside a dollar-quoted body', () => {
    const sql = `create function f() returns int language sql as $$ select 1; $$; select 2`;
    expect(splitStatements(sql)).toHaveLength(2);
  });

  it('keeps a semicolon inside a tagged dollar-quoted body', () => {
    const sql = `do $body$ begin drop table t; end $body$; select 2`;
    expect(splitStatements(sql)).toHaveLength(2);
  });

  it('does not read $1 as a dollar quote', () => {
    expect(splitStatements('select $1; select $2')).toStrictEqual(['select $1', 'select $2']);
  });

  it('drops a piece that is only a comment, and keeps the one that is not', () => {
    const pieces = splitStatements('-- a comment\nselect 1; /* another */ ;');
    expect(pieces).toHaveLength(1);
    expect(classifyStatement(pieces[0] ?? '')).toBe('data');
  });

  it('closes a nested block comment once, so a commented-out drop stays a comment', () => {
    const pieces = splitStatements('/* /* drop table t; */ */ select 1');
    expect(pieces).toHaveLength(1);
    expect(classifyStatement(pieces[0] ?? '')).toBe('data');
  });

  it('honours backslash escapes inside an E string and not outside one', () => {
    expect(splitStatements(`select E'\\'; drop table t'`)).toHaveLength(1);
  });

  // SOL-FR9-1: `$` continues an unquoted identifier, so `$$` straight after
  // one is part of it and opens nothing (PostgreSQL's scan.l, ident_cont).
  it('reads $$ at the end of an identifier as part of it, not as a dollar quote', () => {
    expect(
      splitStatements('create table ops.t$$ (id int); /* a /* b */ c */ commit'),
    ).toStrictEqual(['create table ops.t$$ (id int)', '/* a /* b */ c */ commit']);
  });

  it('reads $a$ inside two identifiers as parts of them, not as one quote', () => {
    expect(
      splitStatements('create table ops.x$a$ (id int);\ncommit;\ncreate table ops.y$a$ (id int);'),
    ).toStrictEqual(['create table ops.x$a$ (id int)', 'commit', 'create table ops.y$a$ (id int)']);
  });

  it('still opens a dollar quote after a parameter or a space', () => {
    expect(splitStatements('select $1$$;$$; select $$;$$')).toStrictEqual([
      'select $1$$;$$',
      'select $$;$$',
    ]);
  });

  // `name'\'` is the type `name` and a plain string: only a lone E opens an
  // escape string, not the last letter of a longer word.
  it('does not read the last e of a word as an E-string prefix', () => {
    expect(splitStatements(`select name'\\'; commit; --'`)).toStrictEqual([
      `select name'\\'`,
      'commit',
    ]);
  });
});

// FR11-SCANNER: scan.l (REL_18_STABLE) read rule by rule. Each row is a text
// and the pieces PostgreSQL's lexer finds in it; the rows marked red failed at
// b17d8cf, the rest pin a rule the scanner already followed.
describe('splitStatements against scan.l', () => {
  it.each([
    // R8-AUTHORITY-5, R8-SURFACE-6 (red): newline is [\n\r], so a lone CR ends
    // a line comment and the statement after it is read, not dropped.
    [
      'create table a (id int);\n-- c\rcreate table b (id int);',
      ['create table a (id int)', '-- c\rcreate table b (id int)'],
    ],
    ['select 1; -- c\rselect 2;', ['select 1', '-- c\rselect 2']],
    [
      'create table a (id int);\n-- b follows\rcreate table b (id int);',
      ['create table a (id int)', '-- b follows\rcreate table b (id int)'],
    ],
    ['select 1 -- n\r; drop table t', ['select 1 -- n', 'drop table t']],
    // R8-THERMO-7 (red): a closing quote, whitespace holding a newline (or a
    // line comment and a newline), and a quote continue the string in the
    // state it was in (<xqs>{quotecontinue}), so an E string stays an E string.
    [`select E'a'\n'\\'' ; commit; --'`, [`select E'a'\n'\\''`, 'commit']],
    [`select e'a'\r'\\'' ; commit; --'`, [`select e'a'\r'\\''`, 'commit']],
    [`select E'a' -- c\n'\\'' ; commit; --'`, [`select E'a' -- c\n'\\''`, 'commit']],
    [`select E'a'\n-- c\n  '\\'' ; commit; --'`, [`select E'a'\n-- c\n  '\\''`, 'commit']],
    [`select E'a'\n'b'\n'\\'' ; commit; --'`, [`select E'a'\n'b'\n'\\''`, 'commit']],
    // No newline, or a block comment in the gap, is no continuation: the next
    // quote opens a plain string, where a backslash is a plain character.
    [`select E'a' '\\'' ; commit; --'`, [`select E'a' '\\'' ; commit; --'`]],
    [`select E'a' /* c */\n'\\'' ; commit; --'`, [`select E'a' /* c */\n'\\'' ; commit; --'`]],
    // Every other string form continues in its own state, none with escapes:
    // plain, N'', B'', X'' and U&''.
    [`select 'a'\n'\\'' ; commit; --'`, [`select 'a'\n'\\'' ; commit; --'`]],
    [`select N'a'\n'\\'' ; commit; --'`, [`select N'a'\n'\\'' ; commit; --'`]],
    [`select B'1'\n'\\'' ; commit; --'`, [`select B'1'\n'\\'' ; commit; --'`]],
    [`select X'1'\n'\\'' ; commit; --'`, [`select X'1'\n'\\'' ; commit; --'`]],
    [
      `select U&'a'\n'\\'' UESCAPE '!' ; commit; --'`,
      [`select U&'a'\n'\\'' UESCAPE '!' ; commit; --'`],
    ],
    // A quoted identifier never continues (only xb, xh, xq, xe and xus do).
    [`select "a"\n"b"; commit`, [`select "a"\n"b"`, 'commit']],
    [`select U&"a"\n"b"; commit`, [`select U&"a"\n"b"`, 'commit']],
    // A piece is dropped only when PostgreSQL's grammar drops it: nothing in it
    // but comments and whitespace (red: a piece with no verb was dropped).
    ['select 1;  ', ['select 1', ' ']],
    ['create table a (id int); 1', ['create table a (id int)', '1']],
    ['select 1; "x"', ['select 1', '"x"']],
    ['-- c\n; /* d */ ;\t\f\v\r\n;', []],
    // SOL-FR11-1 (red): text that ends inside a block comment is scan.l's
    // lexical error (<xc><<EOF>>), so the piece is kept for the server to
    // refuse. Every other state the text can end inside is kept already: a
    // string of any form, a quoted identifier, a dollar quote. A line comment
    // may end the text; that is no error, and the piece is dropped.
    [
      'create table ops.fr11_a (id int); /* unfinished',
      ['create table ops.fr11_a (id int)', '/* unfinished'],
    ],
    ['select 1; /* a /* b */', ['select 1', '/* a /* b */']],
    ["select 1; 'x", ['select 1', "'x"]],
    ["select 1; E'x\\'", ['select 1', "E'x\\'"]],
    ["select 1; B'1", ['select 1', "B'1"]],
    ["select 1; X'1", ['select 1', "X'1"]],
    ["select 1; U&'x", ['select 1', "U&'x"]],
    ['select 1; "x', ['select 1', '"x']],
    ['select 1; U&"x', ['select 1', 'U&"x']],
    ['select 1; $a$x', ['select 1', '$a$x']],
    ['select 1; -- fine', ['select 1']],
    // Numbers: a real ends before `$$` only with a signed exponent; 1e3$$ and
    // 0x1F$$ are trailing junk that PostgreSQL refuses, one token here too.
    ['select 1e-3$$;$$; commit', ['select 1e-3$$;$$', 'commit']],
    ['select 1.5$$;$$; commit', ['select 1.5$$;$$', 'commit']],
    ['select 1e3$$; commit', ['select 1e3$$', 'commit']],
    // An operator stops before `--` or `/*` inside it.
    ['select 1 +-- c\n; commit', ['select 1 +-- c', 'commit']],
    ['select 1 @/* ; */; commit', ['select 1 @/* ; */', 'commit']],
  ])('reads %j as scan.l does', (sql, pieces) => {
    expect(splitStatements(sql)).toStrictEqual(pieces);
  });

  // R8-RUNTIME-1 (red): the server reads `commit work` after the CR, one command.
  it('reads the verb after a comment a lone CR ends', () => {
    expect(classify('-- x\rcommit\nwork')).toStrictEqual([
      { text: '-- x\rcommit\nwork', kind: 'transaction' },
    ]);
    expect(classify('select 1 -- n\r; drop table t').map((s) => s.kind)).toStrictEqual([
      'data',
      'ddl',
    ]);
  });

  // A character past ASCII starts an identifier (ident_start), so a no-break
  // space before a verb makes one word PostgreSQL refuses, not a space.
  it('reads whitespace as scan.l does, [ \\t\\n\\r\\f\\v] and no more', () => {
    expect(leadingVerb(' commit')).toBe('');
    expect(leadingVerb('\r\f\v(select 1)')).toBe('SELECT');
  });
});

describe('classifyStatement', () => {
  it.each([
    ['create index concurrently i on t (c)', 'ddl'],
    ['ALTER TABLE t ADD COLUMN c int', 'ddl'],
    ['grant select on t to r', 'ddl'],
    ['revoke all on t from r', 'ddl'],
    ['comment on table t is $$x$$', 'ddl'],
    ['refresh materialized view v', 'ddl'],
    ['select * into new_table from t', 'ddl'],
    ['do $$ begin end $$', 'opaque'],
    ['call some_procedure()', 'opaque'],
    ['execute a_prepared_statement', 'opaque'],
    ['select 1', 'data'],
    ['with x as (insert into t values (1) returning *) select * from x', 'data'],
    ['begin', 'transaction'],
    ['commit', 'transaction'],
    [`select set_config('app.business_id', $1, true)`, 'data'],
    ['set local app.business_id = $1', 'session'],
    ['', 'other'],
  ])('reads %j as %s', (statement, kind) => {
    expect(classifyStatement(statement)).toBe(kind);
  });

  it('reads past a leading comment to the verb', () => {
    expect(leadingVerb('-- set the schema up\n  create table t ()')).toBe('CREATE');
    expect(classifyStatement('/* quiet */ drop table t')).toBe('ddl');
  });
});

describe('the log', () => {
  it('classifies every statement in one string, not just the first', () => {
    const log = createStatementLog();
    log.record('runtime', 'select 1; create table sneaky (id int)');
    expect(log.entries).toHaveLength(2);
    expect(log.schemaChanging().map((entry) => entry.kind)).toStrictEqual(['ddl']);
  });

  it('keeps the source, so a migration is not read as runtime', () => {
    const log = createStatementLog();
    log.record('migration:0001', 'create table t (id int)');
    log.record('runtime', 'select 1');
    expect(log.schemaChanging().every((entry) => entry.source === 'migration:0001')).toBe(true);
    expect(log.entries.filter((entry) => entry.source === 'runtime')).toHaveLength(1);
  });

  it('is empty of schema changes for a plain read and write', () => {
    const log = createStatementLog();
    log.record('runtime', 'begin');
    log.record('runtime', `select set_config('app.business_id', $1, true)`);
    log.record('runtime', 'insert into businesses (id) values ($1)');
    log.record('runtime', 'commit');
    expect(log.schemaChanging()).toStrictEqual([]);
    expect(classify('select 1').map((s) => s.kind)).toStrictEqual(['data']);
  });
});
