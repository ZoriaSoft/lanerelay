#!/bin/sh
# End-to-end smoke: builds dist/, then drives qp through fake agent lanes in a
# temp dir — handoff on limit, failed run + resume, watch/queue/report/status.
# Usage: test/smoke.sh   (run from the repo root after `npm ci`)
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
QP="node $ROOT/dist/cli.js"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

pass() { printf 'ok  %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }
contains() { grep -qF "$2" "$1" || { printf '%s\n' '--- file ---' >&2; cat "$1" >&2; fail "$3"; }; }

# --- fixture lanes -----------------------------------------------------------
cat > limited.sh <<'EOF'
#!/bin/sh
echo "5-hour limit reached. Your limit resets at 11pm" >&2
exit 1
EOF
cat > broken.sh <<'EOF'
#!/bin/sh
echo "segfault in lane" >&2
exit 3
EOF
cat > hero.sh <<'EOF'
#!/bin/sh
printf '%s' "$1" > "$(dirname "$0")/hero-prompt.txt"
echo "task completed"
exit 0
EOF
chmod +x limited.sh broken.sh hero.sh

cat > quota-pilot.yaml <<EOF
lanes:
  - name: capped
    kind: claude
    command: "$WORK/limited.sh {{prompt}}"
    priority: 0
  - name: busted
    kind: custom
    command: "$WORK/broken.sh {{prompt}}"
    priority: 1
  - name: hero
    kind: custom
    command: "$WORK/hero.sh {{prompt}}"
    priority: 2
EOF

# --- 1. run: limit → non-limit failure → handoff → done ----------------------
$QP run "fix the flaky test" -q >run1.out 2>run1.err || fail "run 1 exit code"
contains run1.err 'done on lane "hero"' "run 1 verdict"
contains hero-prompt.txt 'fix the flaky test' "handoff task text"
contains hero-prompt.txt 'already attempted' "handoff context"
RUN1=$(sed -n 's/^qp: run \(r-[a-z0-9-]*\).*/\1/p' run1.err | head -1)
[ -n "$RUN1" ] || fail "run id not printed"
[ -f ".qp/runs/$RUN1.json" ] || fail "run record file missing"
pass "run + handoff + record ($RUN1)"

$QP status >status.out 2>&1
contains status.out 'capped' "status shows capped lane"
contains status.out 'blocked until' "status shows block"
pass "status"

# --- 2. report ---------------------------------------------------------------
$QP report >report.out 2>&1
contains report.out 'runs: 1 total (1 done)' "report totals"
contains report.out 'capped' "report lane row"
$QP report --json | grep -q '"done": 1' || fail "report --json"
pass "report"

# --- 3. failed run + resume --------------------------------------------------
cat > quota-pilot.yaml <<EOF
lanes:
  - name: busted
    kind: custom
    command: "$WORK/broken.sh {{prompt}}"
    priority: 0
EOF
if $QP run "doomed task" -q --no-wait >run2.out 2>run2.err; then
  fail "run 2 should fail"
fi
contains run2.err 'all lanes failed' "run 2 verdict"
RUN2=$(sed -n 's/^qp: run \(r-[a-z0-9-]*\).*/\1/p' run2.err | head -1)
[ -n "$RUN2" ] || fail "run 2 id missing"
contains run2.err "qp run --resume $RUN2" "resume hint printed"
pass "failed run + resume hint ($RUN2)"

# resuming with a different task must be refused
if $QP run --resume "$RUN2" "different task" 2>resume-diff.err; then
  fail "resume with different task accepted"
fi
contains resume-diff.err 'different task' "refusal message"

# now the lane works: resume picks the task up, handoff shows prior attempt
cat > quota-pilot.yaml <<EOF
lanes:
  - name: hero
    kind: custom
    command: "$WORK/hero.sh {{prompt}}"
EOF
$QP run --resume "$RUN2" -q >run3.out 2>run3.err || fail "resume exit code"
contains run3.err "resuming $RUN2" "resume banner"
contains run3.err 'done on lane "hero"' "resume verdict"
contains hero-prompt.txt 'doomed task' "resumed task text"
contains hero-prompt.txt 'busted' "resumed handoff shows earlier lane"
pass "resume continues recorded task"

# a finished run is not resumable
if $QP run --resume "$RUN2" 2>resume-done.err; then :; fi
# RUN2 is now 'resumed' (superseded) — refused
contains resume-done.err 'resumed by' "superseded refusal"

# --- 4. SIGINT marks the record interrupted; resume picks it up -----------

cat > sleepy.sh <<'EOF'
#!/bin/sh
sleep 300
EOF
chmod +x sleepy.sh
cat > quota-pilot.yaml <<EOF
lanes:
  - name: sleepy
    kind: custom
    command: "$WORK/sleepy.sh {{prompt}}"
EOF
# SIGINT after 1s; qp should exit and leave an 'interrupted' record
timeout -s INT -k 4 1 $QP run "interrupt me" -q >run4.out 2>run4.err || true
RUN4=$(sed -n 's/^qp: run \(r-[a-z0-9-]*\).*/\1/p' run4.err | head -1)
[ -n "$RUN4" ] || fail "run 4 id missing"
grep -q '"status": "interrupted"' ".qp/runs/$RUN4.json" || {
  cat ".qp/runs/$RUN4.json" >&2; fail "record not interrupted";
}
$QP status >status3.out 2>&1
contains status3.out 'unfinished runs' "status lists interrupted run"
contains status3.out "resume: qp run --resume $RUN4" "status shows resume cmd"
$QP report >report3.out 2>&1
contains report3.out "qp run --resume $RUN4" "report lists resumable run"
pass "SIGINT → interrupted → resumable ($RUN4)"

cat > quota-pilot.yaml <<EOF
lanes:
  - name: hero
    kind: custom
    command: "$WORK/hero.sh {{prompt}}"
EOF
$QP run --resume "$RUN4" -q >run5.out 2>run5.err || fail "interrupt-resume exit code"
contains run5.err 'done on lane "hero"' "interrupt-resume verdict"
contains hero-prompt.txt 'interrupt me' "interrupted task text"
pass "interrupted run resumed to done"
cat > quota-pilot.yaml <<EOF
lanes:
  - name: hero
    kind: custom
    command: "$WORK/hero.sh {{prompt}}"
EOF
$QP add "queued job" >add.out 2>&1
contains add.out 'queued' "add output"
$QP watch --once -q >watch.out 2>watch.err || fail "watch exit code"
$QP queue >queue.out 2>&1
contains queue.out 'done' "queue done state"
contains queue.out 'run r-' "queue item links run record"
pass "watch + queue"

# --- 5. status unfinished section appears only when something is resumable ---
$QP status >status2.out 2>&1 || fail "status2"
# all runs finished → no unfinished section
if grep -q 'unfinished runs' status2.out; then fail "unfinished section should be absent"; fi
pass "status clean when nothing resumable"

$QP report >report2.out 2>&1
contains report2.out '4 done' "report counts all runs"
contains report2.out '2 resumed' "report counts superseded runs"
pass "report aggregates runs"

printf 'all smoke checks passed\n'
