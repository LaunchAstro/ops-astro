#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# A6, the agent loop reaches no network (#1623 R8), confined by the kernel.
#
#   VITEST_MAX_WORKERS=1 pnpm run agent:egress:conformance
#
# Linux only, as root or through sudo. It starts the supervisor's fixtures
# (agent-egress-fixtures.ts) in a network namespace of their own, joined to
# this one by a veth pair, and runs the healthy control
# (agent-egress-control.ts) from this namespace as the dropped identity: every
# way out reaches its fixture and raises its counter. Then, under
# `unshare --net`, it brings loopback up, starts the labelled doubles
# (agent-egress-doubles.ts), closes inherited descriptors, writes the
# confinement receipt (agent-egress-receipt.ts) and execs the suite through
# `setpriv`, which drops uid, gid, groups, every capability and privilege
# escalation before the pinned stack is imported. It passes only when the
# suite's report has every test passed and none skipped, and the fixture
# counters stand where the control left them.
#
# It refuses (exit 2) on a missing tool, a privilege drop that did not drop,
# a missing loopback, a missing receipt, any skip, or a lost inner exit
# status. A failing suite or a risen counter exits 1.

set -euo pipefail

say() { printf 'agent-egress: %s\n' "$1"; }
refuse() { say "refused: $1" >&2; exit 2; }

# Builtins only until the tools are known to be there.
for tool in unshare setpriv ip node pnpm git sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || refuse "missing $tool"
done
[ "$(uname -s)" = Linux ] || refuse "Linux only"

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

NOBODY=65534
DROP=(--reuid="$NOBODY" --regid="$NOBODY" --clear-groups --inh-caps=-all --ambient-caps=-all
  --bounding-set=-all --no-new-privs)
BROKER_PORT=8807
RECORDER_PORT=8808
VITEST_WORKERS=${VITEST_MAX_WORKERS:-1}

# The dropped identity as /proc/self/status shows it: every id, no capability, no escalation.
drop_holds() {
  awk -F'\t' -v id="$NOBODY" '
    $1 == "Uid:" || $1 == "Gid:" { if ($2 == id && $3 == id && $4 == id && $5 == id) ids++ }
    $1 ~ /^Cap(Inh|Prm|Eff|Bnd|Amb):$/ { if ($2 == "0000000000000000") caps++ }
    $1 == "NoNewPrivs:" { nnp = ($2 == 1) }
    END { exit !(ids == 2 && caps == 5 && nnp) }' "$1"
}

waited_for() {
  for _ in $(seq 100); do
    [ -s "$1" ] && return 0
    sleep 0.1
  done
  return 1
}

# Inside `unshare --net`, as root: loopback, the doubles, the receipt, then the suite.
inner() {
  local work=$1 fd
  [ "$(readlink /proc/self/ns/net)" != "${A6_OUTER_NAMESPACE:-}" ] ||
    refuse "not in a network namespace of its own"
  ip link set lo up || refuse "missing loopback"
  ip -o addr show dev lo | grep -q 'inet 127\.0\.0\.1/' || refuse "missing loopback"
  setpriv "${DROP[@]}" -- cat /proc/self/status >"$work/drop-inner.txt" ||
    refuse "the privilege drop failed"
  drop_holds "$work/drop-inner.txt" || refuse "the privilege drop failed"

  install -d -m 0755 -o "$NOBODY" -g "$NOBODY" "$work/doubles" "$work/out"
  setpriv "${DROP[@]}" -- env -i PATH="$PATH" \
    node scripts/proofs/agent-egress-doubles.ts "$work/doubles" "$BROKER_PORT" "$RECORDER_PORT" \
    </dev/null >"$work/doubles.log" 2>&1 &
  echo "$!" >"$work/doubles.pid"
  waited_for "$work/doubles/listeners.json" || refuse "the doubles did not start"

  # Bash keeps its own script descriptor (255) close-on-exec; every other one goes.
  exec </dev/null
  for fd in /proc/$$/fd/*; do
    fd=${fd##*/}
    if [ "$fd" -gt 2 ] && [ "$fd" -ne 255 ]; then eval "exec $fd>&-"; fi
  done

  install -d -m 0755 "$work/receipt"
  A6_COUNTERS="$work/fixtures/counters.json" node scripts/proofs/agent-egress-receipt.ts \
    "$work/receipt/receipt.json" "$$" "$work/drop-inner.txt" "$work/doubles/listeners.json" ||
    refuse "no receipt was written"
  [ -s "$work/receipt/receipt.json" ] || refuse "no receipt was written"

  exec setpriv "${DROP[@]}" -- env -i PATH="$PATH" HOME="$work/out" TMPDIR="$work/out" \
    A6_RECEIPT="$work/receipt/receipt.json" \
    LANGSMITH_ENDPOINT="http://127.0.0.1:$RECORDER_PORT" \
    VITEST_MAX_WORKERS="$VITEST_WORKERS" \
    node node_modules/vitest/vitest.mjs run --config scripts/proofs/agent-egress.vitest.config.ts --configLoader runner \
    --reporter=default --reporter=json --outputFile.json="$work/out/report.json"
}

if [ "${1:-}" = --inner ]; then
  inner "$2"
fi

SUDO=()
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || refuse "missing sudo"
  SUDO=(sudo)
fi

head=$(git rev-parse HEAD 2>/dev/null) || refuse "no product head"
lockfile=$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)
FACTS=(A6_IPV4=10.250.6.1 A6_IPV6=fd00:a6::1 A6_TCP_PORT=8806 A6_DNS_PORT=5300
  A6_NAME=fixture.a6.test A6_HEAD="$head" A6_LOCKFILE="$lockfile" A6_PNPM="$(pnpm --version)")

ns=a6-fixtures-$$
host_link=a6h-$$
fixture_link=a6f-$$
fixtures_pid=
work=$(mktemp -d /tmp/agent-egress.XXXXXX)
chmod 0755 "$work"
cleanup() {
  if [ -n "$fixtures_pid" ]; then "${SUDO[@]}" kill "$fixtures_pid" 2>/dev/null || true; fi
  if [ -s "$work/doubles.pid" ]; then "${SUDO[@]}" kill "$(cat "$work/doubles.pid")" 2>/dev/null || true; fi
  "${SUDO[@]}" ip netns del "$ns" 2>/dev/null || true
  "${SUDO[@]}" ip link del "$host_link" 2>/dev/null || true
  "${SUDO[@]}" rm -rf "$work"
}
trap cleanup EXIT

"${SUDO[@]}" setpriv "${DROP[@]}" -- cat /proc/self/status >"$work/drop-outer.txt" ||
  refuse "the privilege drop failed"
drop_holds "$work/drop-outer.txt" || refuse "the privilege drop failed"

say "fixtures in $ns on 10.250.6.1 and fd00:a6::1"
"${SUDO[@]}" ip netns add "$ns"
"${SUDO[@]}" ip link add "$host_link" type veth peer name "$fixture_link"
"${SUDO[@]}" ip link set "$fixture_link" netns "$ns"
"${SUDO[@]}" ip addr add 10.250.6.2/24 dev "$host_link"
"${SUDO[@]}" ip -6 addr add fd00:a6::2/64 dev "$host_link" nodad
"${SUDO[@]}" ip link set "$host_link" up
"${SUDO[@]}" ip netns exec "$ns" ip link set lo up
"${SUDO[@]}" ip netns exec "$ns" ip addr add 10.250.6.1/24 dev "$fixture_link"
"${SUDO[@]}" ip netns exec "$ns" ip -6 addr add fd00:a6::1/64 dev "$fixture_link" nodad
"${SUDO[@]}" ip netns exec "$ns" ip link set "$fixture_link" up
mkdir -m 0755 "$work/fixtures"
"${SUDO[@]}" ip netns exec "$ns" env "${FACTS[@]}" \
  node scripts/proofs/agent-egress-fixtures.ts "$work/fixtures" </dev/null >"$work/fixtures.log" 2>&1 &
fixtures_pid=$!
waited_for "$work/fixtures/fixtures.ready" || { cat "$work/fixtures.log" >&2; refuse "the fixtures did not start"; }

say "healthy control, unconfined, as uid $NOBODY"
"${SUDO[@]}" setpriv "${DROP[@]}" -- env -i PATH="$PATH" "${FACTS[@]}" \
  node scripts/proofs/agent-egress-control.ts "$work/fixtures/counters.json" </dev/null ||
  refuse "the healthy control did not reach every fixture"
cp "$work/fixtures/counters.json" "$work/control-counters.json"
say "counters after the control: $(cat "$work/control-counters.json")"

say "confined suite, under unshare --net and setpriv"
set +e
"${SUDO[@]}" env "${FACTS[@]}" A6_OUTER_NAMESPACE="$(readlink /proc/self/ns/net)" \
  VITEST_MAX_WORKERS="$VITEST_WORKERS" \
  unshare --net -- bash "$repo_root/scripts/proofs/agent-egress-conformance.sh" --inner "$work"
status=$?
set -e

if [ -s "$work/receipt/receipt.json" ]; then
  say "receipt:"
  cat "$work/receipt/receipt.json"
fi
if [ "$status" -ne 0 ]; then
  say "the confined suite failed (exit $status)"
  exit 1
fi
[ -s "$work/out/report.json" ] || refuse "the inner exit status was lost: no report"
node -e '
  const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const tests = report.testResults.flatMap((file) => file.assertionResults);
  const passed = tests.filter((test) => test.status === "passed").length;
  console.log(`agent-egress: ${passed}/${tests.length} passed`);
  const whole = report.success === true && tests.length > 0 && passed === tests.length &&
    report.numTotalTests === tests.length && report.numPendingTests === 0 && report.numTodoTests === 0;
  process.exit(whole ? 0 : 1);
' "$work/out/report.json" || refuse "a test was skipped or the report is not whole"
say "counters after the confined suite: $(cat "$work/fixtures/counters.json")"
cmp -s "$work/control-counters.json" "$work/fixtures/counters.json" || {
  say "a fixture counter rose under confinement"
  exit 1
}
say "pass at $head"
