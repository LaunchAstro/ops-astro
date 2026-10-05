// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-8, the parts a reader can check without a database: the runtime
// transactions are split into named steps short enough to review, and every
// advisory lock goes through one helper.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseSync } from 'vite';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const RUNTIME = join(ROOT, 'packages', 'core-runtime', 'src');

/**
 * Each function in `file` that has a body, with its length in lines from its
 * first line to its closing brace: top-level declarations, and functions held
 * in a top-level `const`. A nested helper counts inside the function holding it.
 */
function functionLengths(file: string): readonly { name: string; lines: number }[] {
  const text = readFileSync(file, 'utf8');
  const lineOf = (at: number) => text.slice(0, at).split('\n').length;
  const found: { name: string; lines: number }[] = [];
  const measure = (name: string, node: { start: number; end: number }) =>
    found.push({ name, lines: lineOf(node.end) - lineOf(node.start) + 1 });
  for (const top of parseSync(file, text, { lang: 'ts' }).program.body) {
    const statement =
      top.type === 'ExportNamedDeclaration' && top.declaration ? top.declaration : top;
    if (statement.type === 'FunctionDeclaration' && statement.body)
      measure(statement.id?.name ?? '(anonymous)', statement);
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) {
        const value = declaration.init;
        if (value?.type === 'ArrowFunctionExpression' || value?.type === 'FunctionExpression')
          measure(
            declaration.id.type === 'Identifier' ? declaration.id.name : '(pattern)',
            declaration,
          );
      }
    }
  }
  return found;
}

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('CQ-8 runtime structure', () => {
  it('CQ-8 function size: no function in decide, pickup, handback or heartbeat is longer than 120 lines', () => {
    const long = ['decide.ts', 'pickup.ts', 'handback.ts', 'heartbeat.ts'].flatMap((name) =>
      functionLengths(join(RUNTIME, name))
        .filter((fn) => fn.lines > 120)
        .map((fn) => `${name} ${fn.name} ${String(fn.lines)}`),
    );
    expect(long).toEqual([]);
    // The measure itself: it finds the transactions it is meant to bound.
    const named = functionLengths(join(RUNTIME, 'handback.ts')).map((fn) => fn.name);
    expect(named).toContain('handback');
  });

  it('CQ-8 function size: recovery is split into the classifier, lease retirement, authority loss and the sweep, none over 600 lines', () => {
    const parts = sourceFiles(join(RUNTIME, 'recovery'));
    expect(parts.map((file) => relative(RUNTIME, file)).toSorted()).toEqual([
      'recovery/authority-loss.ts',
      // AW-10: a broker call as its step's effect: the sweep's, the pass's and a person's half.
      'recovery/broker-effect.ts',
      'recovery/classifier.ts',
      // T3e1: a drop, and the work coming back from it.
      'recovery/drop.ts',
      // The effect register's lookup type, a leaf so broker-effect and reconcile import no cycle.
      'recovery/effect-lookup.ts',
      'recovery/lease-retirement.ts',
      // T3d1: a person's recorded outcome, and the pass's reconciliation phase.
      // T3e2: one report per outage.
      'recovery/outage.ts',
      'recovery/outcome.ts',
      'recovery/reconcile.ts',
      // T3b: the reconciliation pass's lease-expiry phase.
      'recovery/sweep.ts',
      // T3c: a person's write-off of an unknown hold.
      'recovery/write-off.ts',
    ]);
    for (const file of [...parts, join(RUNTIME, 'recovery.ts')]) {
      expect(readFileSync(file, 'utf8').split('\n').length, file).toBeLessThanOrEqual(600);
    }
  });

  it('CQ-8 one lock path: pg_advisory_xact_lock appears once in product code, in the one helper', () => {
    const product = [join(ROOT, 'packages'), join(ROOT, 'apps')].flatMap(sourceFiles);
    const takers = product.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      const hits = text.match(/pg_(?:try_)?advisory(?:_xact)?_lock(?:_shared)?\b/gu) ?? [];
      return hits.map(() => relative(ROOT, file));
    });
    expect(takers).toEqual(['packages/core-records/src/tenancy/database.ts']);
  });
});

/** The callers `advisoryLockCallers` must find, each a decision with its reason. */
const ADVISORY_LOCK_CALLERS: readonly string[] = [
  // The outbox forwarder's one lock, alone in its own transaction: no command order.
  'apps/forwarder/forward.ts',
  // C59: a login's one wrong-code lock, keyed by its subject's digest in
  // every business, taken first in a factor route's check transaction.
  'packages/core-commands/src/commands/account-factor-checks.ts',
  // C52-A: a change's last ask after its session takes the business's audit
  // chain key before `sessionEndedSince`, so no ending commits between them.
  'packages/core-commands/src/commands/automation-approvals.ts',
  'packages/core-commands/src/commands/conversation-lifecycle.ts',
  // #932: the operation identity's key, first in every identified call.
  'packages/core-commands/src/commands/envelope.ts',
  // C80 (#1002 F3-F6): a correction write takes the audit chain's key after
  // its row locks, as tasks-agent.ts does, so its authority re-read comes
  // after every wait.
  'packages/core-commands/src/commands/live-correction-standing.ts',
  'packages/core-commands/src/commands/occurrence-run.ts',
  'packages/core-commands/src/commands/prepare.ts',
  // #413: an agent assignment takes the audit chain's key after its write,
  // where the envelope's audit write would, so its last liveness read
  // comes after every wait.
  'packages/core-commands/src/commands/tasks-agent.ts',
  'packages/core-custody/src/broker-reserve.ts',
  // AW-07b: the mail cap, counted under one lock per business and client or person.
  'packages/core-custody/src/email-class.ts',
  // C32: the business's one access lock, taken first by every change to
  // who may do what (a grant given, a grant revoked, access ended),
  // inside the handler's transaction.
  'packages/core-records/src/authority/access.ts',
  // C52-A (PRV-oa-984-R2.1): the session-ending keys, exclusive for an ending,
  // in one order: the audit chain, the login's subject, each session sorted.
  'packages/core-records/src/identity/ending-keys.ts',
  // #770: a business's lock on one observed identifier, taken by
  // `resolveIdentifier` only when its lookup finds nobody, so two first
  // observations make one person.
  'packages/core-records/src/identity/identifier-resolution.ts',
  // C59: a login's one factor lock (`second-factor-subject:<digest>`), keyed
  // by its subject's digest in every business, taken first in a factor
  // route's record transaction, before the person's row.
  'packages/core-records/src/identity/second-factor.ts',
  // C52-A and C40: a write's last ask takes the subject's and the session's
  // ending keys shared; a reset's window open takes the subject's alone, and a
  // provider sign-out its session's alone, as neither writes an audit event.
  'packages/core-records/src/identity/sessions.ts',
  // C81: the overseas-services register's one lock per business, taken
  // by a change and by a privacy policy's draft, approval and publication
  // before reading the register, inside the handler's transaction.
  'packages/core-records/src/operations/overseas-services.ts',
  // Catalogue #463: the settings install lock (`<business id>:business_settings`),
  // exclusive for the install and shared for the sign-off and four-eyes reads,
  // so a first settings row cannot commit past a decision that found none.
  'packages/core-records/src/records/business-settings.ts',
  'packages/core-records/src/tasks/placement.ts',
  'packages/core-records/src/tenancy/database.ts',
  'packages/core-records/src/tenancy/limit.ts',
  'packages/core-runtime/src/locks.ts',
];

/**
 * The product files that call `advisoryLock`, sorted. A lock taken outside
 * `acquire` or `advisoryLock` fails the scan above; this names the callers, so
 * a new one is a decision rather than a drift.
 */
function advisoryLockCallers(): readonly string[] {
  const product = [join(ROOT, 'packages'), join(ROOT, 'apps')].flatMap(sourceFiles);
  return product
    .filter((file) => /\badvisoryLock\(/u.test(readFileSync(file, 'utf8')))
    .map((file) => relative(ROOT, file))
    .toSorted();
}

describe('CQ-8 runtime structure', () => {
  it('CQ-8 one lock path: the runtime, the envelope and placement take advisory locks only through the helper', () => {
    expect(advisoryLockCallers()).toEqual(ADVISORY_LOCK_CALLERS);
  });

  it('CQ-8 one lock path: locks.ts states where the command-layer locks sit in the order', () => {
    const text = readFileSync(join(RUNTIME, 'locks.ts'), 'utf8');
    expect(text).toMatch(/command-layer locks/iu);
    expect(text).toMatch(/before any lock `acquire` takes/iu);
  });
});
