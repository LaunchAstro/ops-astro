# Inspect Langfuse on the M5

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

Ticket #1622 is partly met by the existing M5 installation. Do not start a
second stack or change the existing containers. The inspection on 14 October
2026 found a healthy Langfuse 4.30.0 service at `http://127.0.0.1:3400`.
The [installation inventory](../../deploy/m5/langfuse.md) records its Compose
files, images, ports, and volumes.

## Inspect the existing service

Read the health response without credentials:

```sh
curl --max-time 10 --silent --show-error \
  http://127.0.0.1:3400/api/public/health
```

Inspect only the container fields needed for the inventory:

```sh
docker inspect langfuse-langfuse-web-1 --format \
  'image={{.Config.Image}} restart={{.HostConfig.RestartPolicy.Name}} ports={{json .HostConfig.PortBindings}}'
```

Do not print a complete `docker inspect`, Compose rendering, or environment
file. Those outputs can contain credentials. Do not run `trace-target.ts up`
or `down` against this installation. That helper manages a separate,
disposable test stack and destroys its own volumes on shutdown.

## Stage the exporter configuration

The built exporter is in `apps/api/trace-exporter.ts`. It runs through its
own custody process, uses a fixed trace destination, and exports only the
allowlisted run measurements. No LangChain callback handler is needed.

The exporter also projects a closed event outcome and bounded model-call
counts at the event's time, scoped to its business, run, lease, and reservation.
Non-terminal events carry no outcome or invented zero usage. A terminal
event with an unrecognised outcome is `unknown`. These are call counts,
not token counts. The broker ledger has `input_units` and `output_units`,
but this projection does not export them as token usage.

The extra OTLP attributes are `ops-astro.outcome`,
`ops-astro.usage.model_calls`, and `ops-astro.usage.settled_calls`. Langfuse
documents unmapped attributes under `metadata.attributes`; its generation
usage fields are for token counts. See the
[vendor's attribute mapping](https://langfuse.com/integrations/native/opentelemetry#attribute-mapping).
The current M5 installation has not been exercised with this projection.

The [configuration example](../../deploy/m5/trace-export.env.example) leaves
`TRACE_EXPORT=off`. It names the existing loopback origin and leaves both
file paths empty. Copying the example does not activate tracing.

Before an authorised activation, the operator must prepare these settings:

- `TRACE_EXPORT_ORIGIN=http://127.0.0.1:3400`. This origin works only from a
  process on the M5 host. Container loopback refers to that container.
- `TRACE_EXPORT_CREDENTIALS_FILE`, an owner-only JSON file containing the
  Langfuse project's key pair for custody. The entry uses `ref: trace_key`,
  `kind: api_key`, `destination: trace_target`, `header: authorization`,
  `scheme: basic`, an account label, and `value: <public key>:<secret key>`.
- `TRACE_EXPORT_KEY_FILE`, an owner-only file containing at least 32 random
  bytes encoded as hexadecimal. Preserve this HMAC key across restarts.
  Changing it changes the derived trace and span identifiers.

Keep the credential and HMAC files outside Git. Use mode `0600` and an
owner-only parent directory. Never place the project secret in a shell
argument, run record, model context, or committed configuration.

The exporter requires HTTP Basic and sets
`x-langfuse-ingestion-version: 4`. The repository's real-target proof uses
4.33.0. Compatibility with the existing 4.30.0 target remains unverified.
Do not claim this installation is connected until the operator retrieves
a replay-fake run exported through custody from that target.

Only the operator may apply `TRACE_EXPORT=on` to the running deployment.
Production API changes and the parked worker's switch-on remain owner steps.
See [the API composition root](API.md#the-composition-root) and
[the diagnostic trace export](RUNTIME.md#the-diagnostic-trace-export).

## Retrieve an existing replay proof

After an authorised operator has produced a replay-fake trace, stage its
source settings in an owner-only environment file. The proof command needs
`DATABASE_URL` for an isolated test database and `TRACE_TARGET_ENV_FILE` for
the target's staged exporter settings. Those settings must contain the
loopback origin, credential-file path, and HMAC-key-file path. Set `TRACE_EXPORT=on` in that staged proof file. The proof validates the
settings but does not start the exporter or apply them to the running API.

Set `TRACE_PROOF_TRACE_ID`, `TRACE_PROOF_OUTCOME`,
`TRACE_PROOF_MODEL_CALLS`, and `TRACE_PROOF_SETTLED_CALLS` to that replay's
derived trace identifier and known expected measurements. Set
`TRACE_PROOF_MESSAGE_CANARY`, `TRACE_PROOF_PAGE_CANARY`, and
`TRACE_PROOF_TOOL_CANARY` to its planted synthetic text. Never use real
message text for these proof inputs.

Run the proof from the repository root:

```sh
node scripts/local/m5-trace-acceptance.ts
```

The command runs the isolated database export cases and read-only M5 target
cases. It rejects missing prerequisites, load above 35, failed cases, and
skipped cases. It checks both Langfuse versions and all image digests, retrieves the
specified observations, and checks their timings, outcome, call counts, and
absence of content. It never ingests or deletes traces, changes containers,
or starts the parked worker. Passing these cases does not close the separate
cold-boot, owner-machine access, and live stopped-target completion gates.

## Verify the remaining criteria

Record evidence for these checks before closing #1622:

1. Confirm the person responsible for the September installation. File
   ownership identifies the `agencyastro` account, not the installer.
2. Obtain owner approval for a pinned version and digest in the existing
   deployment. The current Compose image references are floating tags.
3. Confirm Docker Desktop startup after a machine restart and user login.
   `unless-stopped` is a container restart policy, not a cold-boot proof.
4. Confirm the existing Tailscale Serve mapping on HTTPS port 8449 restricts
   access to the owner's machines. Its target is loopback port 3400, and
   Funnel is disabled. The owner-machine ACL and an actual remote connection
   remain unverified. Do not add a public listener or proxy.
5. Review the existing target's telemetry, content-related options, and
   project-key custody before activating the exporter.
6. Export a replay-fake run through the built exporter. Retrieve its
   observations and check timings, outcome, and usage. Assert that planted
   message, page, and tool-output canaries appear in neither export bytes
   nor retrieved observations. No model call or paid service is needed.
7. Run the existing exporter outage tests against an isolated test fixture.
   A live stop-and-recovery proof requires separate permission to change
   the existing containers. Until then, leave that acceptance criterion
   unverified. A run must still finish, with a recorded gap or later catch-up.

The unit and database tests under `tests/runtime/aw-13-*.test.ts` cover the
allowlist, export, isolation, and gaps. Their existence does not prove that
the current M5 target receives agent traces. The real-target test
`aw-13-local-target.test.ts` assumes its disposable 4.33.0 stack. Do not point
it at the existing installation because it deletes test traces and runs
ClickHouse optimisation commands.

While the M5 five-minute load exceeds 35, hold dependency installation,
typechecking, database suites, builds, and other heavy work. Before any
container change, log `BLOCKER` and stop for the orchestrator.
