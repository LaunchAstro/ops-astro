// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { configDefaults, defineConfig } from 'vitest/config';

// With a database, the database-bound suites run. Each file's fresh database
// is a clone of one template the run migrates from empty once
// (tests/support/migrated-template.ts); the few that migrate from empty still
// queue on migration 0008, which comments on a cluster-wide role inside the
// migration transaction, behind every other migration on the server. A loaded
// machine turned that queue into 5 s test timeouts and 60 s hook timeouts that
// passed alone (product issue 56). So a database run uses four workers, the
// hosted runner's cores, and times sized for it. Without a database those
// suites skip and the defaults stand.
const database = (process.env['DATABASE_URL'] ?? '') !== '';
const containerSuites: string[] = (
  JSON.parse(readFileSync('tests/ci/container-suites.json', 'utf8')) as { suites: string[] }
).suites;
// These suites change the backup and lookup identities, which are the cluster's
// and shared by every database on it: one grants them a role, the others drop
// their row-security bypass. Any file migrating beside them reads or repairs
// the same rows (0045, 0046, 20261004102910) and fails with "tuple concurrently
// updated" or finds the membership mid-test. So a whole-suite run with a
// database leaves them out; scripts/db-conformance.mjs, which runs the named
// suites one at a time and sets SUITE_PART for each, runs them.
const clusterRoleSuites = [
  'tests/db/identity-roles-hold-no-membership.test.ts',
  'tests/db/migration-retries-shared-role-race.test.ts',
  'tests/review/role-repair-drops-inherited-access-proof.test.ts',
];
const oneSuiteAtATime = process.env['SUITE_PART'] !== undefined;

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // On CI with a database, fails the run if a proof that must run there
    // skipped (see the file); first, so its teardown runs after the others.
    // Creates the cluster-wide roles once, before any file builds its own
    // database, so files starting side by side on a new cluster do not race
    // on `pg_authid_rolname_index` (see the file).
    // Gives the run a temp folder of its own and fails the run if a test
    // leaves anything in it (issue #103, see the file).
    globalSetup: [
      'tests/support/ci-must-run.ts',
      'tests/support/global-setup.ts',
      'tests/support/temp-guard.ts',
    ],
    // The capture chain's longer timeout, file by file (see the file); a second
    // project would label the `vitest list` lines scripts/db-conformance.mjs reads.
    setupFiles: ['tests/support/capture-chain-timeout.ts'],
    // Hooks are where every database-bound file makes a fresh database
    // (`beforeAll`), a clone or a migration from empty, and drops it
    // (`afterAll`). That is legitimately slow work, and with many files and
    // other runs sharing the machine it ran past the 10 s default while passing
    // alone. The few slow tests name their own timeout, and a hook or test
    // naming its own keeps it.
    hookTimeout: database ? 180_000 : 60_000,
    testTimeout: database ? 30_000 : 5_000,
    ...(database ? { maxWorkers: 4 } : {}),
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      'packages/**/*.test.ts',
      'apps/**/*.test.ts',
    ],
    // The browser proofs build `apps/web/dist`, which other suites rebuild (an
    // emptied folder mid-run), so they run alone: CI's `local checks` step with
    // BROWSER_PROOFS=1. Sol's proofs kept byte for byte (the leaked-client
    // proof, OW-001's two, OW-002's, C33's, and the role, staging-login, copy-finder,
    // scan-login and backup revocation proofs), the OW-002 proofs written beside
    // them, Sol's two PR-345 web proofs and F1-FIX1 other-tab enrolment proof on
    // c59-factor-routes-world (byte for byte but for one cookie-jar split CQ-11
    // asks for), Sol's six F2 lost-answer retry proofs and Sol's two F3
    // save-order proofs open their worlds with no skip, as do Sol's three
    // template lock and clone catalogue proofs and the cases written beside
    // them, C31's Sol proof files and the Keys panel's DB proofs; without a
    // database they are left out here, and the manifests run them where there
    // is one. C31's corrupted audit chain fails by design: only the proof that
    // spawns it from inside a test worker collects it.
    exclude: [
      ...configDefaults.exclude,
      ...(process.env['BROWSER_PROOFS'] === '1' ? [] : ['tests/browser/**']),
      ...(process.env['VITEST_WORKER_ID'] === undefined
        ? ['tests/custody/c31-audit-chain-corrupted.test.ts']
        : []),
      ...(database
        ? []
        : [
            'tests/api/leaked-client-read-isolation-assertion.test.ts',
            'tests/api/server-entry-hosted-sign-in-key.test.ts',
            'tests/review/forwarder-replay-time-order.test.ts',
            'tests/automations/c33-registry-snapshot-and-claim-races.test.ts',
            'tests/custody/c31-audit-chain-test-catches-corruption.test.ts',
            'tests/custody/c31-last-used-moves-forward.test.ts',
            'tests/custody/c31-revoked-list-and-revision-range.test.ts',
            'tests/custody/c31-secret-set-guards.test.ts',
            'tests/custody/c31-two-setters-overlap.test.ts',
            'tests/surfaces/c31-keys-panel-first-set-refused.test.tsx',
            'tests/surfaces/c31-keys-panel-stale-clear-refused.test.tsx',
            'tests/surfaces/c31-keys-panel-stale-set-refused.test.tsx',
            'tests/api/end-others-provider-clock-skew.test.ts',
            'tests/api/end-others-delayed-ending.test.ts',
            'tests/api/end-others-ended-session-leaves-live-list.test.ts',
            'tests/api/end-others-leaves-session-list-in-every-business.test.ts',
            'tests/identity/session-list-subject-wide-ending.test.ts',
            'tests/api/agent-credential-exports-counted.test.ts',
            'tests/review/role-repair-drops-inherited-access-proof.test.ts',
            'tests/review/staging-logins-*-proof.test.ts',
            'tests/operations/find-copies-values-only.proof.test.ts',
            'tests/operations/scan-login-token-and-shared-login.proof.test.ts',
            'tests/operations/scan-login-cleanup-mapping-race.test.ts',
            'tests/review/backup-read-part-appointment-proof.test.ts',
            'tests/review/backup-restore-revocation-proof.test.ts',
            'tests/review/ow066-export-revocation-proof.test.ts',
            'tests/review/revocation-after-part-gate-fetches-no-bytes-proof.test.ts',
            'tests/review/staging-reset-keeps-session-ended-during-reset-proof.test.ts',
            'tests/review/staging-reset-proof-copies-before-competing-ending-proof.test.ts',
            'tests/operations/scan-login-cleanup-subject-race.proof.test.ts',
            'tests/api/function-outbox-before-response.test.ts',
            'tests/api/function-outbox-waits-for-own-events.test.ts',
            'tests/api/conversation-retention-work.test.ts',
            'tests/db/conversation-run-end-retention.test.ts',
            'tests/db/run-end-stamped-after-lock-wait.test.ts',
            'tests/db/run-supersede-stamped-after-lock-wait.test.ts',
            'tests/api/live-presence-remap-and-back-keeps-no-revoked-reader.test.ts',
            'tests/api/live-presence-remap-drops-previous-person.test.ts',
            'tests/api/live-presence-remap-refused-person-gets-no-notification.test.ts',
            'tests/api/live-presence-remap-seats-no-one-on-unreadable-task.test.ts',
            'tests/commands/mention-refusal-replay-name.test.ts',
            'tests/commands/mention-refusal-staff-name.test.ts',
            'tests/broker/counted-call-closes-give-back-once.test.ts',
            'tests/broker/late-answer-after-sweep-gives-back-once.test.ts',
            'tests/broker/late-planning-settlement-keeps-owner-release.test.ts',
            'tests/broker/topped-up-unknown-call-late-answer-gives-back.test.ts',
            'tests/broker/unknown-call-settled-lower-gives-back.test.ts',
            'tests/broker/model-call-concurrent-sends-dispatch-once.test.ts',
            'tests/broker/model-call-retried-send-sends-once.test.ts',
            'tests/broker/model-call-swept-hold-sends-nothing.test.ts',
            'tests/broker/counted-call-release-races-top-up-and-end.test.ts',
            'tests/harness/reserved-model-call-retry-sends-once.test.ts',
            'tests/api/receipt-link-held-credentials-crossings.test.ts',
            'tests/api/receipt-link-keeps-no-credential.test.ts',
            'tests/api/receipt-link-literal-percent-and-held-digests.test.ts',
            'tests/api/held-attempt-calls-provider-once.test.ts',
            'tests/api/held-answer-sign-off.proof.test.ts',
            'tests/api/applied-comment-settles-after-sign-off.proof.test.ts',
            'tests/web/authenticator-cancelled-enrol-lands-late.test.tsx',
            'tests/web/sign-in-code-after-enrolment.test.tsx',
            'tests/surfaces/incident-retry-once-and-task-draft-stays-with-business.test.tsx',
            'tests/web/draft-resume-and-tag-create-replay-their-operation.test.ts',
            'tests/web/duplicate-form-retry-after-lost-answer-creates-one-task.test.tsx',
            'tests/web/duplicate-seam-retry-after-lost-answer-creates-one-task.test.tsx',
            'tests/web/operations-incident-retry-after-lost-answer-records-once.test.tsx',
            'tests/web/time-log-retry-after-lost-answer-stores-once.test.tsx',
            'tests/web/authenticator-other-tab-enrol-lands-late.test.tsx',
            'tests/web/preferences-save-order-api.test.tsx',
            'tests/web/saved-flag-save-order.test.tsx',
            'tests/support/template-lock-and-clone-catalogue.test.ts',
          ]),
      // CI's `local checks` runs the suites that start containers in a step of their own, after
      // the browser captures: a new network interface aborts a page load in flight.
      ...(process.env['CONTAINER_SUITES'] === 'apart' ? containerSuites : []),
      ...(database && !oneSuiteAtATime ? clusterRoleSuites : []),
    ],
  },
});
