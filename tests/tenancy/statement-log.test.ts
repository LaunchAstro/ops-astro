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
