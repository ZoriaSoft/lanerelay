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

# --- 6. usage gauge drives lane order --------------------------------------
cat > thirsty.sh <<'EOF'
#!/bin/sh
echo "session usage: 3% left"
echo "$0" >> order.txt
exit 1
EOF
cat > healthy.sh <<'EOF'
#!/bin/sh
echo "$0" >> order.txt
exit 0
EOF
chmod +x thirsty.sh healthy.sh

cat > quota-pilot.yaml <<EOF
lanes:
  - name: thirsty
    kind: custom
    command: "$WORK/thirsty.sh {{prompt}}"
    priority: 0
  - name: healthy
    kind: custom
    command: "$WORK/healthy.sh {{prompt}}"
    priority: 5
EOF

# seed run: thirsty prints its 3% gauge, fails, healthy finishes
$QP run "seed the gauge" -q >seed.out 2>seed.err || fail "seed run"
grep -q '"pctLeft": 3' .qp/state.json || fail "usage reading not stored"
# now healthy (no gauge = 100%) must be picked before thirsty (3%), despite
# thirsty's lower priority number
rm -f order.txt
$QP run "ordered by quota" -q >order.out 2>order.err || fail "order run"
FIRST=$(head -1 order.txt)
[ "$FIRST" = "$WORK/healthy.sh" ] || { cat order.txt >&2; fail "healthy lane should run first"; }
pass "usage gauge reorders lanes"

# --- 7. prune removes aged run records --------------------------------------
cat > .qp/runs/r-stale0000.json <<'EOF'
{"id":"r-stale0000","task":"old","pid":1,"status":"done","startedAt":"2001-01-01T00:00:00.000Z","finishedAt":"2001-01-01T01:00:00.000Z","attempts":[]}
EOF
$QP prune --days 30 >prune.out 2>&1
contains prune.out 'pruned 1 run record' "prune output"
[ ! -f .qp/runs/r-stale0000.json ] || fail "stale record still present"
$QP report >report4.out 2>&1 || fail "report after prune"
contains report4.out 'runs:' "report still aggregates"
pass "prune"

# --- 8. watch --jobs runs queued tasks in parallel on leased lanes --------
cat > waitA.sh <<'EOF'
#!/bin/sh
i=0
# wait until the sibling lane started, then announce ourselves (proves overlap)
while [ ! -f flag-waitB ] && [ $i -lt 100 ]; do i=$((i+1)); sleep 0.1; done
touch flag-waitA
exit 0
EOF
cat > waitB.sh <<'EOF'
#!/bin/sh
touch flag-waitB
i=0
while [ ! -f flag-waitA ] && [ $i -lt 100 ]; do i=$((i+1)); sleep 0.1; done
exit 0
EOF
chmod +x waitA.sh waitB.sh
rm -f flag-waitA flag-waitB

cat > quota-pilot.yaml <<EOF
lanes:
  - name: lane-a
    kind: custom
    command: "$WORK/waitA.sh {{prompt}}"
    priority: 0
  - name: lane-b
    kind: custom
    command: "$WORK/waitB.sh {{prompt}}"
    priority: 1
queue:
  jobs: 2
EOF

$QP add "parallel job one" >/dev/null
$QP add "parallel job two" >/dev/null
# --once drains the queue: two workers, two tasks, two lanes — each waits for
# the other, so serial execution would time out instead of finishing fast.
timeout 30 $QP watch --once -q >watch2.out 2>watch2.err || fail "watch --jobs exit code"
contains watch2.err '2 workers' "watch reports worker count"
[ -f flag-waitA ] && [ -f flag-waitB ] || fail "lanes did not overlap (leases ignored?)"
$QP queue >queue2.out 2>&1
[ "$(grep -c 'done' queue2.out)" -ge 3 ] || { cat queue2.out >&2; fail "queued jobs not done"; }
[ -z "$(find .qp/leases -name '*.json' 2>/dev/null)" ] || fail "lease files leaked"
pass "watch --jobs parallel lanes"

# --- 9. --diff full embeds the patch in the handoff -----------------------
if git --version >/dev/null 2>&1; then
  git init -q .
  echo base > tracked.txt
  git add tracked.txt
  git -c user.email=t@t -c user.name=t commit -qm init
  echo changed > tracked.txt

  cat > cap.sh <<'EOF'
#!/bin/sh
echo "rate limit" >&2
exit 1
EOF
  chmod +x cap.sh
  cat > quota-pilot.yaml <<EOF
lanes:
  - name: cap
    kind: codex
    command: "$WORK/cap.sh {{prompt}}"
    priority: 0
  - name: hero
    kind: custom
    command: "$WORK/hero.sh {{prompt}}"
    priority: 1
EOF

  $QP run "diff me" -q --diff full >diff.out 2>diff.err || fail "diff-full run"
  contains hero-prompt.txt 'diff --git' "handoff contains patch"
  contains hero-prompt.txt 'tracked.txt' "patch names the file"

  $QP unblock >/dev/null 2>&1
  $QP run "diff me again" -q --diff none >diff2.out 2>diff2.err || fail "diff-none run"
  contains hero-prompt.txt 'already attempted' "handoff still present"
  if grep -qF 'diff --git' hero-prompt.txt; then fail "diff none leaked the patch"; fi
  pass "handoff diff modes"
else
  pass "handoff diff modes (skipped: no git)"
fi

# --- 10. qp top --once renders one frame ----------------------------------
$QP top --once >top.out 2>&1 || fail "top --once exit code"
contains top.out 'qp top' "top header"
contains top.out 'LANES' "top lane section"
contains top.out 'queue:' "top queue line"
pass "top --once"

# --- 11. deferred queue item survives an all-blocked window ---------------
# maxWaitMinutes 0 → runTask times out the instant the lane is blocked; the
# watcher must defer the item to the reset (not fail it), and a persistent
# watcher must pick it up once the reset passes.
cat > quota-pilot.yaml <<EOF
lanes:
  - name: hero
    kind: custom
    command: "sh $WORK/hero.sh {{prompt}}"
    cost: free
    priority: 0
defaults:
  maxWaitMinutes: 0
queue:
  pollSeconds: 1
  maxDefers: 3
EOF
RESET_AT=$(date -u -d '+4 seconds' '+%Y-%m-%dT%H:%M:%S.000Z')
printf '{"lanes":{"hero":{"blockedUntil":"%s","reason":"smoke"}}}\n' "$RESET_AT" > .qp/state.json
DEF_ID=$($QP add "deferred job" | sed 's/^queued //')
$QP watch -q --poll 1 >watch3.out 2>watch3.err &
WPID=$!
for i in $(seq 1 45); do [ -f ".qp/queue/done/$DEF_ID.json" ] && break; sleep 1; done
kill $WPID 2>/dev/null || true
wait $WPID 2>/dev/null || true
[ -f ".qp/queue/done/$DEF_ID.json" ] || { cat watch3.err >&2; fail "deferred item never ran"; }
contains watch3.err 'deferred until' "watch defers the task"
contains watch3.err 'wait timed out' "defer reason is timeout"
grep -q "\"id\": \"$DEF_ID\"" ".qp/queue/done/$DEF_ID.json" || fail "deferred item not in done/"
grep -q '"defers": 1' ".qp/queue/done/$DEF_ID.json" || { cat ".qp/queue/done/$DEF_ID.json" >&2; fail "defers counter not recorded"; }
$QP queue >queue3.out 2>&1
contains queue3.out "$DEF_ID" "deferred item finished"
pass "watch defers all-blocked tasks to lane reset"

# --- 12. qp log + report --lane -------------------------------------------
$QP log --list >loglist.out 2>&1 || fail "log --list exit code"
contains loglist.out 'hero.log' "log --list shows lane logs"
$QP log >logtail.out 2>logtail.err || fail "log exit code"
grep -q '^# lane: ' logtail.out || { cat logtail.out >&2; fail "log did not print log file"; }
$QP log "$RUN1" >logrun.out 2>&1 || fail "log <run-id> exit code"
grep -q '^# lane: ' logrun.out || fail "log <run-id> did not print attempt log"
$QP log hero >loglane.out 2>&1 || fail "log <lane> exit code"
grep -q '^# lane: hero' loglane.out || fail "log <lane> picked wrong file"
if $QP log nope-does-not-exist >logbad.out 2>&1; then fail "unknown selector should exit non-zero"; fi
contains logbad.out 'no log file, lane or run id matching' "unknown selector message"
pass "qp log"

$QP report --lane hero >rl.out 2>&1 || fail "report --lane exit code"
contains rl.out 'lane hero:' "report --lane header"
contains rl.out 'attempts' "report --lane stats"
contains rl.out 'log ' "report --lane shows log refs"
if $QP report --lane ghost-lane >rlbad.out 2>&1; then fail "unknown lane should exit non-zero"; fi
contains rlbad.out 'no recorded attempts' "empty lane report"
$QP report --lane hero --json | grep -q '"verdict": "done"' || fail "report --lane --json"
pass "qp report --lane"

# queue.maxDefers validation rejects negatives
cat > quota-pilot.yaml <<EOF
lanes:
  - name: hero
    kind: custom
    command: "sh $WORK/hero.sh {{prompt}}"
queue:
  maxDefers: -1
EOF
if $QP status >badcfg.out 2>&1; then fail "maxDefers -1 accepted"; fi
contains badcfg.out 'queue.maxDefers must be a non-negative integer' "maxDefers validation"
# restore a working config for anything after this point
cat > quota-pilot.yaml <<EOF
lanes:
  - name: hero
    kind: custom
    command: "sh $WORK/hero.sh {{prompt}}"
    cost: free
    priority: 0
EOF
pass "queue.maxDefers validation"

# --- 13. qp doctor / add --file / report --jsonl ---------------------------
$QP doctor >doc.out 2>&1 || fail "doctor exit code"
contains doc.out 'config' "doctor reports config check"
contains doc.out 'lane hero: executable' "doctor resolves lane executable"
contains doc.out 'runtime dirs' "doctor checks runtime dirs"
$QP doctor --json | grep -q '"status": "ok"' || fail "doctor --json"
pass "qp doctor"

# doctor must FAIL a lane whose executable is missing
cat > quota-pilot.yaml <<EOF
lanes:
  - name: ghost
    kind: custom
    command: "ghost-cli-zzz {{prompt}}"
EOF
if $QP doctor >docbad.out 2>&1; then fail "doctor accepted missing executable"; fi
contains docbad.out 'FAIL' "doctor prints FAIL tag"
contains docbad.out 'ghost-cli-zzz' "doctor names the missing executable"
# restore working config
cat > quota-pilot.yaml <<EOF
lanes:
  - name: hero
    kind: custom
    command: "sh $WORK/hero.sh {{prompt}}"
    cost: free
    priority: 0
EOF

printf 'first job\n# comment\n\nsecond job\n' > tasks.txt
$QP add --file tasks.txt >addfile.out 2>&1 || fail "add --file exit code"
ADDN=$(grep -c '^queued ' addfile.out)
[ "$ADDN" = "2" ] || fail "add --file queued $ADDN tasks, want 2"
$QP queue >queue4.out 2>&1
contains queue4.out 'first job' "file task 1 queued"
contains queue4.out 'second job' "file task 2 queued"
printf 'piped task\n' | $QP add --file - >addstdin.out 2>&1 || fail "add --file - exit code"
contains addstdin.out 'queued' "stdin task queued"
if $QP add >addempty.out 2>&1; then fail "empty add accepted"; fi
contains addempty.out 'give a task or use --file' "empty add message"
pass "qp add --file"

$QP report --jsonl >report.jsonl 2>&1 || fail "report --jsonl exit code"
head -1 report.jsonl | grep -q '"id"' || fail "jsonl first line is not a record"
if head -1 report.jsonl | grep -q '^\['; then fail "jsonl leaked an array"; fi
pass "qp report --jsonl"

printf 'all smoke checks passed\n'
