// SPDX-License-Identifier: AGPL-3.0-only
// The dependency licence check.
//
// Finding 21 of the sweep of 6 September: the first version validated JSON
// syntax and nothing else. An empty report, an empty licence expression, a
// wrong package shape and a report describing zero packages all exited 0. It
// also asked the wrong question. OSI approval is not the question.
//
// The question this repository has to answer is narrower: **can this licence
// be distributed inside an AGPL-3.0-only work?** Plenty of OSI-approved
// licences cannot. EPL-2.0, CDDL-1.0, MS-PL and GPL-2.0-only are all OSI
// approved and all incompatible here. So the allowlist below is a
// compatibility list, deliberately short, and every entry is a decision.
//
// This is engineering judgement about what to depend on, not a legal opinion.
// LICENSING.md is subject to counsel and so is this.
//
// Usage:
//   node scripts/licences/check.mjs                 read the tree with pnpm
//   node scripts/licences/check.mjs --report FILE   read a report from a file
//   node scripts/licences/check.mjs --assets FILE   check bundled asset records
//
// The plain run also checks the fonts and icons the visual harness bundles
// (tests/visual/assets/assets.json, T4c). Those are assets, not packages, so
// each carries its own record: licence, source, permitted use, a pinned
// address and digest, with its licence text beside the record. One with no
// compatible licence is refused and reported, and must not be bundled.
//
// The --report form exists so tests/licences/licence-cases.sh can feed it the
// reports it must refuse. A checker with no testable seam cannot be trusted
// to refuse anything.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compatible with distribution inside an AGPL-3.0-only work: permissive,
// weak copyleft that is file or library scoped, and the AGPL family itself.
const ALLOWED = new Set([
  // Permissive
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'Zlib',
  'Python-2.0',
  // Weak copyleft, file or library scoped, one-way compatible with the AGPL
  'MPL-2.0',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  // The project's own licence and its compatible relatives
  'AGPL-3.0-only',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
]);

// OSI approved and still refused here, with the reason. Listed so a reader
// sees that the allowlist is a compatibility decision rather than an
// oversight, and so a future reader does not "helpfully" add one.
const REFUSED_WITH_REASON = new Map([
  ['EPL-2.0', 'reciprocal in a way the AGPL cannot absorb; needs a separate decision'],
  ['EPL-1.0', 'as EPL-2.0'],
  ['CDDL-1.0', 'file-level copyleft that conflicts with the AGPL'],
  ['CDDL-1.1', 'as CDDL-1.0'],
  ['MS-PL', 'not compatible with the GPL family'],
  ['MS-RL', 'not compatible with the GPL family'],
  ['GPL-2.0-only', 'GPL-2.0 without the "or later" option cannot combine with AGPL-3.0'],
  ['OSL-3.0', 'not compatible with the GPL family'],
  ['CPAL-1.0', 'attribution clause; needs a separate decision'],
  ['SSPL-1.0', 'not an open-source licence, whatever it is called'],
  ['BUSL-1.1', 'source available, not open source'],
]);

// The font licence, allowed for the named font packages and nothing else.
//
// The SIL Open Font License 1.1 lets a font be bundled with any software,
// whatever that software's licence, so the interface's three families can ship
// inside this AGPL-3.0-only work (TICKET-PLAN R52: Funnel Display, Funnel Sans
// and Chivo Mono ship with their licence files). It is not a software licence,
// so it is not on ALLOWED: a code package under it is refused. A package is
// allowed here only when its name is one of these exactly and its expression
// is the bare identifier, with no OR, AND or WITH beside it. A new font is a
// new entry, with its reason, in the same change as the record in
// packages/ui/assets/licences.json.
const FONT_LICENCE = 'OFL-1.1';
const FONT_PACKAGES = new Set([
  '@fontsource/funnel-display',
  '@fontsource/funnel-sans',
  '@fontsource/chivo-mono',
]);

const args = process.argv.slice(2);
const reportFlag = args.indexOf('--report');
const reportFile = reportFlag === -1 ? undefined : args[reportFlag + 1];
const assetsFlag = args.indexOf('--assets');
const DEFAULT_ASSETS = fileURLToPath(
  new URL('../../tests/visual/assets/assets.json', import.meta.url),
);

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

// Fonts are distributed beside the software, not linked into it, so the SIL
// Open Font License is compatible for an asset while it is no package licence
// this file has decided on. It is allowed here only.
const ASSET_ALLOWED = new Set([...ALLOWED, 'OFL-1.1']);

/** The problems with one asset manifest; refused assets are printed, not problems. */
const checkAssets = (file) => {
  const found = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return [`${file}: not readable JSON: ${String(error.message ?? error)}`];
  }
  const assets = manifest?.assets;
  if (!Array.isArray(assets) || assets.length === 0) {
    return [`${file}: no assets listed. An empty record is not a clean result.`];
  }
  const dir = dirname(file);
  for (const asset of assets) {
    const name = nonEmpty(asset?.name) ? asset.name : '(unnamed)';
    for (const key of ['name', 'kind', 'licence', 'source']) {
      if (!nonEmpty(asset?.[key])) found.push(`${name}: no ${key} recorded`);
    }
    if (nonEmpty(asset?.refused)) {
      if (asset.file === undefined && asset.url === undefined) {
        console.log(`licences: refused, not bundled: ${name} (${asset.licence}): ${asset.refused}`);
      } else found.push(`${name}: refused, and still bundled`);
      continue;
    }
    if (!ASSET_ALLOWED.has(asset?.licence)) {
      found.push(
        `${name}: ${String(asset?.licence)} is not compatible; refuse it, never bundle it`,
      );
    }
    if (!nonEmpty(asset?.permittedUse)) found.push(`${name}: no permitted use recorded`);
    if (!nonEmpty(asset?.licenceFile) || !existsSync(join(dir, asset.licenceFile))) {
      found.push(`${name}: its licence text is not beside it`);
    }
    // The public tree holds no binary file, so the bytes are pinned rather
    // than committed: a digest, and an address that cannot move under it.
    if (!/^[0-9a-f]{64}$/u.test(String(asset?.sha256))) found.push(`${name}: no sha256 recorded`);
    if (!nonEmpty(asset?.file) || !String(asset?.url).startsWith('https://')) {
      found.push(`${name}: no file name and https address recorded`);
    }
  }
  if (found.length === 0) console.log(`licences: ${assets.length} asset record(s) hold.`);
  return found;
};

if (assetsFlag !== -1) {
  const found = checkAssets(args[assetsFlag + 1] ?? '');
  for (const p of found) console.error(`licences: asset: ${p}`);
  process.exit(found.length === 0 ? 0 : 1);
}

const hasVersion = (pkg) => {
  if (nonEmpty(pkg['version'])) return true;
  const versions = pkg['versions'];
  return (
    Array.isArray(versions) && versions.length > 0 && versions.every((version) => nonEmpty(version))
  );
};

const describeVersion = (pkg) => {
  if (nonEmpty(pkg['version'])) return pkg['version'];
  const versions = pkg['versions'];
  return Array.isArray(versions) ? versions.join(', ') : '?';
};

const fatal = (message, code) => {
  console.error(`licences: ${message}`);
  process.exit(code);
};

// --- get the report --------------------------------------------------------

let raw;
if (reportFile !== undefined) {
  try {
    raw = readFileSync(reportFile, 'utf8');
  } catch (error) {
    fatal(`could not read ${reportFile}: ${String(error)}`, 2);
  }
} else {
  // Run the pnpm that is running this script, not whatever "pnpm" resolves to
  // on PATH. Under corepack there may be no pnpm on PATH at all.
  const execPath = process.env['npm_execpath'];
  const isScript = execPath !== undefined && /\.[cm]?js$/u.test(execPath);
  const command = execPath === undefined ? 'pnpm' : isScript ? process.execPath : execPath;
  const listArgs = ['licenses', 'list', '--json', '--long'];
  const argv = isScript && execPath !== undefined ? [execPath, ...listArgs] : listArgs;
  try {
    raw = execFileSync(command, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    console.error('licences: could not read the licence list from pnpm.');
    console.error('licences: run `pnpm install` first.');
    console.error(String(error.stderr ?? error.message ?? error));
    process.exit(2);
  }
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  fatal('the licence report is not JSON.', 2);
}

// --- validate its shape ----------------------------------------------------
//
// Every one of these was an exit 0 before. A checker that cannot tell a
// report from a shrug is worse than no checker, because the build goes green.

const problems = [];

if (report === null || typeof report !== 'object' || Array.isArray(report)) {
  fatal('the licence report is not an object of licence to packages.', 1);
}

let packageCount = 0;
const offenders = [];

for (const [licence, packages] of Object.entries(report)) {
  if (typeof licence !== 'string' || licence.trim() === '') {
    problems.push('a licence key is empty. An unnamed licence is not a permission.');
    continue;
  }
  if (!Array.isArray(packages)) {
    problems.push(`${licence}: the value is not an array of packages.`);
    continue;
  }
  if (packages.length === 0) {
    problems.push(`${licence}: no packages listed under it. The report is malformed.`);
    continue;
  }
  for (const pkg of packages) {
    packageCount += 1;
    if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
      problems.push(`${licence}: a package entry is not an object.`);
      continue;
    }
    const name = pkg['name'];
    if (typeof name !== 'string' || name.trim() === '') {
      problems.push(`${licence}: a package entry has no name.`);
    }
    // pnpm reports `versions` as an array; a hand-written or older report may
    // carry a single `version`. Either is fine, neither is not.
    if (!hasVersion(pkg)) {
      problems.push(`${licence}: ${String(name)} has no version.`);
    }
  }
}

if (packageCount === 0) {
  problems.push(
    'the report describes zero packages. That is not a clean result, it is an\n' +
      '           empty one, and the first version of this check called it success.',
  );
}

// --- compatibility ---------------------------------------------------------
//
// Every part of an expression must be allowed. That is stricter than an OR
// expression strictly requires, and it is the right way round for a gate: a
// dual-licensed dependency with one unusable half is a decision for a person.
//
// The expression is validated as a grammar before any policy is applied.
// Round four found the pass two parser discarding parentheses and empty
// tokens, so `()`, `( )`, `MIT OR ` and `MIT WITH Apache-2.0` all passed with
// exit 0. An expression with no licence in it is not a permission.
//
// The grammar is SPDX's, kept deliberately small:
//   expression := term (("AND" | "OR") term)*
//   term       := "(" expression ")" | identifier ["WITH" exception]
//
// WITH takes an exception, not a licence. `MIT WITH Apache-2.0` is malformed,
// and treating the right-hand side as a second licence to check was the bug.

// Exceptions are an allowlist, not a spelling.
//
// Round five found the pass three parser recognising an exception by its
// shape and then consuming it without a policy lookup, so
// `MIT WITH Invented-Exception` received a compatibility declaration. An
// exception changes what a licence permits, so an unknown one is an unknown
// grant, and an unknown grant is not a permission.
//
// Short on purpose. Each entry is a decision, and the way to add one is to
// read the exception and write down why, not to widen a pattern.
const ALLOWED_EXCEPTIONS = new Map([
  ['LLVM-exception', 'the Apache-2.0 exception used across the LLVM toolchain'],
  ['Classpath-exception-2.0', 'linking exception; the reason a GPL runtime can be linked'],
  ['GCC-exception-3.1', 'the GCC runtime library exception'],
  ['Autoconf-exception-3.0', 'generated-file exception'],
  ['Bison-exception-2.2', 'generated-parser exception'],
  ['Font-exception-2.0', 'the GPL font exception'],
]);

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/u;

/** Tokenise, then parse. Returns the licence identifiers, or throws a reason. */
const parseExpression = (expression) => {
  const tokens = expression.match(/\(|\)|[^\s()]+/gu) ?? [];
  if (tokens.length === 0) throw new Error('the expression is empty');
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];
  const licences = [];

  const parseTerm = () => {
    const token = take();
    if (token === undefined) throw new Error('it ends where a licence was expected');
    if (token === ')') throw new Error('a closing bracket where a licence was expected');
    if (token === '(') {
      parseExpr();
      if (take() !== ')') throw new Error('an unclosed bracket');
      return;
    }
    if (/^(?:AND|OR|WITH)$/iu.test(token)) {
      throw new Error(`"${token}" where a licence was expected`);
    }
    if (!IDENTIFIER.test(token)) throw new Error(`"${token}" is not a licence identifier`);
    licences.push(token);
    const next = peek();
    if (next !== undefined && /^WITH$/iu.test(next)) {
      take();
      const exception = take();
      if (exception === undefined) throw new Error('WITH with no exception after it');
      if (ALLOWED.has(exception)) {
        throw new Error(
          `"${exception}" is a licence; WITH takes an exception, not a second licence`,
        );
      }
      if (!ALLOWED_EXCEPTIONS.has(exception)) {
        throw new Error(
          `"${exception}" is not a known licence exception. An exception changes\n` +
            '                what the licence permits, so an unknown one is an unknown\n' +
            '                grant. Read it, decide, and add it to ALLOWED_EXCEPTIONS\n' +
            '                with the reason, or remove the dependency.',
        );
      }
    }
  };

  const parseExpr = () => {
    parseTerm();
    let next = peek();
    while (next !== undefined && /^(?:AND|OR)$/iu.test(next)) {
      take();
      parseTerm();
      next = peek();
    }
  };

  parseExpr();
  if (i !== tokens.length) throw new Error(`unexpected "${tokens[i]}"`);
  return licences;
};

for (const [licence, packages] of Object.entries(report)) {
  if (typeof licence !== 'string' || licence.trim() === '' || !Array.isArray(packages)) {
    continue;
  }
  let pieces;
  try {
    pieces = parseExpression(licence);
  } catch (error) {
    for (const pkg of packages) {
      const name = nonEmpty(pkg?.['name']) ? pkg['name'] : '(unnamed)';
      const version = pkg === null || typeof pkg !== 'object' ? '?' : describeVersion(pkg);
      offenders.push({
        name,
        version,
        licence,
        reasons: [`the expression is malformed: ${String(error.message ?? error)}`],
      });
    }
    continue;
  }
  const bad = pieces.filter((p) => !ALLOWED.has(p));
  if (bad.length === 0) continue;
  const reasons = bad.map((p) => {
    if (p === FONT_LICENCE) {
      return `${p}: a font licence, allowed only as the whole expression of a named font package`;
    }
    const why = REFUSED_WITH_REASON.get(p);
    return why === undefined ? `${p}: not on the compatibility allowlist` : `${p}: ${why}`;
  });
  for (const pkg of packages) {
    const name = nonEmpty(pkg?.['name']) ? pkg['name'] : '(unnamed)';
    if (licence === FONT_LICENCE && FONT_PACKAGES.has(name)) continue;
    const version = pkg === null || typeof pkg !== 'object' ? '?' : describeVersion(pkg);
    offenders.push({ name, version, licence, reasons });
  }
}

// --- report ----------------------------------------------------------------

console.log(
  `licences: checked ${packageCount} package(s) across ${Object.keys(report).length} licence expression(s).`,
);

if (problems.length > 0) {
  console.error(`\nlicences: ${problems.length} problem(s) with the report itself:`);
  for (const p of problems) console.error(`  ${p}`);
}

if (offenders.length > 0) {
  console.error(`\nlicences: ${offenders.length} package(s) are not compatible:`);
  for (const o of offenders) {
    console.error(`  ${o.name}@${o.version}: ${o.licence}`);
    for (const r of o.reasons) console.error(`      ${r}`);
  }
  console.error(
    '\nlicences: OSI approval is not the question. The question is whether this\n' +
      'licences: can be distributed inside an AGPL-3.0-only work. Remove the\n' +
      'licences: dependency, or add the licence to the allowlist deliberately and\n' +
      'licences: record why. Do not widen the list to make a build go green.',
  );
}

const assetProblems = reportFile === undefined ? checkAssets(DEFAULT_ASSETS) : [];
for (const p of assetProblems) console.error(`licences: asset: ${p}`);

if (problems.length > 0 || offenders.length > 0 || assetProblems.length > 0) {
  process.exit(1);
}

console.log('licences: every dependency is compatible with AGPL-3.0-only distribution.');
