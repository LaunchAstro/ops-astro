#!/bin/zsh
# loaded-runs.sh <label> <rounds> <copies> <file> [burners]
# Each round runs <copies> vitest processes of <file> at once against the lane's
# own Postgres; every copy is one loaded run. Logs per copy and a summary line.
set -u
export PATH=/opt/homebrew/bin:$PATH
label=$1 rounds=$2 copies=$3 file=$4 burners=${5:-0}
cd ~/m5lanes/oa-ci-flake
export DATABASE_URL=postgres://postgres:conformance-throwaway@127.0.0.1:54798/conformance
out=~/m5lanes/oa-ci-flake-logs/$label
mkdir -p $out
pass=0 fail=0
burn=()
for b in $(seq 1 $burners); do nice -n 5 yes > /dev/null & burn+=($!); done
trap "kill \$burn 2>/dev/null" EXIT
for r in $(seq 1 $rounds); do
  pids=()
  for c in $(seq 1 $copies); do
    nice -n 5 node node_modules/vitest/vitest.mjs run "$file" > $out/r$r-c$c.log 2>&1 &
    pids+=($!)
  done
  c=0
  for p in $pids; do
    c=$((c+1))
    if wait $p; then pass=$((pass+1)); st=pass; else fail=$((fail+1)); st=FAIL; fi
    print "$(date -u +%FT%TZ) $label round $r copy $c $st" >> $out/summary.log
  done
done
print "$(date -u +%FT%TZ) $label burners $burners TOTAL pass $pass fail $fail of $((rounds*copies))" | tee -a $out/summary.log
