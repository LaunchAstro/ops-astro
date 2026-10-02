// SPDX-License-Identifier: AGPL-3.0-only
//
// The security pass's findings table and severity gate (ticket S0-5 item 7,
// `docs/build-safeguards.md` gate item 7). It reads the JSON reports ZAP writes
// (`-J`, ZAP 2.17) and judges every alert by the closing rule's mapping: a high
// is a blocker, a medium a major, a low a minor. Blockers and majors fail the
// run; minors are listed for the owner, who closes each in one line or has it
// fixed (the S0-5 gate's own closing rule). Informational alerts are listed
// apart and never fail the run (ORCH65, 2 Oct 2026). A blank or unknown risk
// code is a blocker, so a report this file cannot read never passes quietly.
// The decisions are here; `findings.mjs` runs them.

export type Severity = 'blocker' | 'major' | 'minor';

/** ZAP's `riskcode` to the closing rule's severity, or to the info list. One table. */
export const SEVERITY_BY_RISK_CODE: Readonly<Record<string, Severity | 'info'>> = {
  '3': 'blocker',
  '2': 'major',
  '1': 'minor',
  '0': 'info',
};

const RANK: Readonly<Record<Severity, number>> = { blocker: 0, major: 1, minor: 2 };
const EVIDENCE_LIMIT = 200;
/** A value shorter than this is too common to replace without mangling the table. */
const SHORTEST_SECRET = 8;

export class ReportRefused extends Error {}

export interface Finding {
  readonly severity: Severity;
  readonly scan: string;
  readonly method: string;
  readonly url: string;
  readonly param: string;
  readonly rule: string;
  readonly evidence: string;
}

export interface Listed {
  readonly scan: string;
  readonly url: string;
  readonly rule: string;
}

export interface ScanFindings {
  readonly scan: string;
  readonly findings: readonly Finding[];
  readonly info: readonly Listed[];
}

export interface GateResult {
  readonly fails: boolean;
  readonly blocker: number;
  readonly major: number;
  readonly minor: number;
  readonly info: number;
}

type Json = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function redactor(secrets: readonly string[]): (value: string) => string {
  const kept = secrets.filter((secret) => secret.length >= SHORTEST_SECRET);
  return (value) => kept.reduce((out, secret) => out.replaceAll(secret, '[redacted]'), value);
}

/** Every alert of one scan's report, one row per instance; refuses a report that reached nothing. */
export function findingsOf(
  scan: string,
  report: unknown,
  secrets: readonly string[] = [],
): ScanFindings {
  if (!isObject(report) || !Array.isArray(report['site']))
    throw new ReportRefused(`the ${scan} report is not a ZAP report`);
  if (report['site'].length === 0)
    throw new ReportRefused(`the ${scan} report names no site: the scan reached nothing`);
  const redact = redactor(secrets);
  const findings: Finding[] = [];
  const info: Listed[] = [];
  for (const site of report['site'] as readonly unknown[]) {
    if (!isObject(site) || !Array.isArray(site['alerts']))
      throw new ReportRefused(`the ${scan} report has a site with no alert list`);
    for (const alert of site['alerts'] as readonly unknown[]) {
      if (!isObject(alert))
        throw new ReportRefused(`the ${scan} report has an alert that is not an object`);
      readAlert(scan, alert, redact, findings, info);
    }
  }
  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return { scan, findings, info };
}

/** One alert's rows: a finding per instance, or an info line per instance. */
function readAlert(
  scan: string,
  alert: Json,
  redact: (value: string) => string,
  findings: Finding[],
  info: Listed[],
): void {
  const code = alert['riskcode'];
  const mapped = typeof code === 'string' ? SEVERITY_BY_RISK_CODE[code] : undefined;
  const name = text(alert['name']) || text(alert['alert']) || '(no name given)';
  const read = typeof code === 'string' ? JSON.stringify(code) : 'none';
  const rule = redact(
    mapped === undefined
      ? `${text(alert['pluginid'])} ${name} (unmapped risk code: ${read})`
      : `${text(alert['pluginid'])} ${name}`,
  );
  const instances = Array.isArray(alert['instances'])
    ? (alert['instances'] as readonly unknown[]).filter((each) => isObject(each))
    : [];
  for (const instance of instances.length > 0 ? instances : [{}]) {
    const url = redact(text(instance['uri'])) || '(no URL given)';
    if (mapped === 'info') {
      info.push({ scan, url, rule });
      continue;
    }
    const evidence = redact(text(instance['evidence']));
    findings.push({
      severity: mapped ?? 'blocker',
      scan,
      method: redact(text(instance['method'])),
      url,
      param: redact(text(instance['param'])),
      rule,
      evidence:
        evidence.length > EVIDENCE_LIMIT ? `${evidence.slice(0, EVIDENCE_LIMIT)}…` : evidence,
    });
  }
}

/** Blockers and majors fail the run; minors and info do not. */
export function severityGate(scans: readonly ScanFindings[]): GateResult {
  const all = scans.flatMap((each) => each.findings);
  const count = (severity: Severity) => all.filter((each) => each.severity === severity).length;
  const blocker = count('blocker');
  const major = count('major');
  return {
    fails: blocker + major > 0,
    blocker,
    major,
    minor: count('minor'),
    info: scans.reduce((sum, each) => sum + each.info.length, 0),
  };
}

/** One table cell: no pipe, line break or markup can leave it. */
function cell(value: string): string {
  return value
    .replaceAll(/\s+/gu, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|')
    .trim();
}

/** The findings table the run keeps as its artefact, in Markdown. */
export function findingsTable(scans: readonly ScanFindings[]): string {
  const gate = severityGate(scans);
  const findings = scans
    .flatMap((each) => each.findings)
    .toSorted((a, b) => RANK[a.severity] - RANK[b.severity]);
  const lines = [
    '# Security pass findings',
    '',
    `Scans: ${scans.map((each) => each.scan).join(', ')}. ` +
      `Blockers ${String(gate.blocker)}, majors ${String(gate.major)}, ` +
      `minors ${String(gate.minor)}, informational ${String(gate.info)}. ` +
      (gate.fails ? 'The run fails: every blocker and major is fixed first.' : 'The run passes.'),
    '',
  ];
  if (findings.length === 0) lines.push('No findings.');
  else {
    lines.push('| Severity | Scan | URL | Rule | Evidence |', '| --- | --- | --- | --- | --- |');
    for (const each of findings) {
      const where = each.method === '' ? each.url : `${each.method} ${each.url}`;
      lines.push(
        `| ${each.severity} | ${cell(each.scan)} | ${cell(where)} | ${cell(each.rule)} | ${cell(each.evidence)} |`,
      );
    }
  }
  if (gate.minor > 0)
    lines.push(
      '',
      "Each minor is the owner's: fix it, or accept it in one line naming its impact, a compensating control and an expiry date after the day it is accepted (S0-5, closing rule).",
    );
  const info = scans.flatMap((each) => each.info);
  if (info.length > 0) {
    lines.push('', '## Informational (listed only)', '');
    for (const each of info)
      lines.push(`- ${cell(each.scan)}: ${cell(each.rule)}, ${cell(each.url)}`);
  }
  return `${lines.join('\n')}\n`;
}
