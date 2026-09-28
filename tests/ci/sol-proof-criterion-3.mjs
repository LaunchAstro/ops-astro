// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';

const repo = 'LaunchAstro/ops-astro';
const name =
  'Sol proof, criterion 3: an edited description leaves a planted required check red and the branch is deleted';
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' });
const api = (path) => JSON.parse(gh('api', `repos/${repo}/${path}`));

try {
  const body = JSON.parse(gh('pr', 'view', '87', '-R', repo, '--json', 'body')).body;
  const runId = body.match(
    /https:\/\/github\.com\/LaunchAstro\/ops-astro\/actions\/runs\/(\d+)/u,
  )?.[1];
  const plantedPr = body.match(/https:\/\/github\.com\/LaunchAstro\/ops-astro\/pull\/(\d+)/u)?.[1];
  assert.ok(runId, 'PR 87 has no link to the planted description-edit run');
  assert.ok(plantedPr, 'PR 87 has no link to the planted pull request');

  const run = api(`actions/runs/${runId}`);
  assert.match(run.path, /^\.github\/workflows\/review-evidence-on-edit\.yml(?:@.*)?$/u);
  assert.equal(run.event, 'pull_request');
  assert.ok(run.pull_requests.some((pr) => String(pr.number) === plantedPr));

  const { jobs } = api(`actions/runs/${runId}/jobs?per_page=100`);
  assert.deepEqual(
    jobs.map((job) => job.name),
    ['review evidence for this revision'],
  );

  const { check_runs: checks } = api(`commits/${run.head_sha}/check-runs?per_page=100`);
  assert.ok(
    checks.some((check) => check.name === 'pull request size' && check.conclusion === 'failure'),
    'The planted head has no failed pull request size check after the edit run',
  );

  const planted = JSON.parse(
    gh('pr', 'view', plantedPr, '-R', repo, '--json', 'baseRefName,headRefName,state'),
  );
  const rules = api(`rules/branches/${encodeURIComponent(planted.baseRefName)}`);
  assert.ok(
    rules.some(
      (rule) =>
        rule.type === 'required_status_checks' &&
        rule.parameters.required_status_checks.some(
          (check) => check.context === 'pull request size',
        ),
    ),
    `pull request size is not required on the planted PR's base ${planted.baseRefName}`,
  );
  assert.equal(planted.state, 'CLOSED', 'The planted pull request is still open');
  const ref = spawnSync('gh', ['api', `repos/${repo}/git/ref/heads/${planted.headRefName}`], {
    encoding: 'utf8',
  });
  assert.equal(ref.status, 1, 'The planted branch still exists');
  assert.match(ref.stderr, /HTTP 404/u, 'Could not confirm that the planted branch is deleted');
  console.log(`PASS ${name}`);
} catch (error) {
  console.error(`FAIL ${name}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
