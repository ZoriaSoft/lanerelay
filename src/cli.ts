#!/usr/bin/env node
import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Command, Option } from 'commander';
import { ConfigError, DEFAULTS, findConfigFile, loadConfig, orderLanes, resolveLane } from './config.js';
import { initConfig } from './init.js';
import { runTask, type OrchestrateOptions } from './orchestrate.js';
import { LeaseSet } from './leases.js';
import { DEFAULT_PROBE_PROMPT, probeLane, type ProbeResult } from './probe.js';
import { deferDecision, TaskQueue } from './queue.js';
import { buildReport, formatLaneReport, formatReport, laneReport } from './report.js';
import { pidAlive, RunStore, type RunRecord } from './runs.js';
import { LaneStore } from './state.js';
import { formatStatus, laneStatuses } from './status.js';
import { runTop, topSnapshot } from './top.js';
import { listLogs, resolveLog, tailFile } from './logview.js';
import type { AttemptResult, Config, Lane, TaskVerdict } from './types.js';

interface Ctx {
  cfg: Config;
  store: LaneStore;
  queueDir: string;
  leasesDir: string;
  pollSeconds: number;
  runs: RunStore;
}

function loadCtx(cwd: string, configFlag?: string): Ctx {
  const path = findConfigFile(cwd, configFlag ?? process.env.QP_CONFIG);
  if (!path) {
    throw new ConfigError(
      'no config file found. Run `qp init` to create quota-pilot.yaml, or pass --config <path>.',
    );
  }
  const cfg = loadConfig(path);
  const d = { ...DEFAULTS, ...cfg.defaults };
  return {
    cfg,
    store: new LaneStore(join(cwd, d.stateFile)),
    queueDir: join(cwd, cfg.queue?.dir ?? d.queueDir),
    leasesDir: join(cwd, d.leasesDir),
    pollSeconds: cfg.queue?.pollSeconds ?? d.pollSeconds,
    runs: new RunStore(join(cwd, d.runsDir)),
  };
}

function report(verdict: TaskVerdict, runId?: string): number {
  const resumeHint = runId ? ` Continue with: qp run --resume ${runId}` : '';
  switch (verdict.type) {
    case 'done': {
      const last = verdict.attempts[verdict.attempts.length - 1];
      process.stderr.write(
        `\nqp: done on lane "${verdict.lane}" (${verdict.attempts.length} attempt(s), log: ${last?.logFile ?? 'none'})\n`,
      );
      return 0;
    }
    case 'all-blocked':
      process.stderr.write(
        `\nqp: every lane is blocked${verdict.earliestReset ? `; earliest reset ${verdict.earliestReset.toLocaleTimeString()}` : ''}. Rerun without --no-wait to sleep until it resets, or 'qp status' to inspect.${resumeHint}\n`,
      );
      return 2;
    case 'failed':
      process.stderr.write(`\nqp: all lanes failed; last error: ${verdict.lastError}.${resumeHint}\n`);
      return 3;
    case 'timeout':
      process.stderr.write(`\nqp: gave up waiting for a free lane (maxWaitMinutes exceeded).${resumeHint}\n`);
      return 4;
  }
}

/**
 * Registry of live run records. One shared set of exit/signal handlers marks
 * every in-flight record 'interrupted' — needed once `qp watch --jobs N`
 * runs several records in the same process ('exit' alone is not enough: a
 * signal under its default disposition kills the process without firing it,
 * so SIGINT/SIGTERM mark first, then exit with the conventional code).
 */
const liveRecords = new Set<{ runs: RunStore; rec: RunRecord }>();
let signalsWired = false;

function wireSignals(): void {
  if (signalsWired) return;
  signalsWired = true;
  const markAll = () => {
    for (const { runs, rec } of liveRecords) runs.markInterrupted(rec);
  };
  process.on('exit', markAll);
  process.on('SIGINT', () => {
    markAll();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    markAll();
    process.exit(143);
  });
}

/**
 * Persist a run record: rewrites it after every lane attempt and finalizes
 * it with the verdict; a SIGINT/exit while still running marks it
 * 'interrupted' so `qp run --resume <id>` can pick the task up.
 */
function wireRecord(runs: RunStore, rec: RunRecord): OrchestrateOptions['onUpdate'] {
  wireSignals();
  const entry = { runs, rec };
  liveRecords.add(entry);
  return (attempts: AttemptResult[], verdict: TaskVerdict | null) => {
    rec.attempts = attempts;
    if (verdict === null) {
      runs.update(rec);
      return;
    }
    runs.finish(rec, verdict.type, {
      lane: verdict.type === 'done' ? verdict.lane : undefined,
      error:
        verdict.type === 'failed'
          ? verdict.lastError
          : verdict.type === 'all-blocked'
            ? 'all lanes blocked'
            : verdict.type === 'timeout'
              ? 'max wait exceeded'
              : undefined,
    });
    liveRecords.delete(entry);
  };
}

function leasesFor(ctx: Ctx): LeaseSet {
  const leases = new LeaseSet(ctx.leasesDir);
  process.on('exit', () => leases.releaseProcess());
  return leases;
}

function parseDiff(v: string | undefined): 'none' | 'stat' | 'full' | undefined {
  if (v === undefined) return undefined;
  if (v === 'none' || v === 'stat' || v === 'full') return v;
  throw new ConfigError(`--diff must be "none", "stat" or "full" (got "${v}")`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const program = new Command();
program
  .name('qp')
  .description('Run one coding task across several AI agent CLIs; quota-limit hits hand the task to the next lane.')
  .version('0.7.0')
  .option('--config <path>', 'path to quota-pilot.yaml');

program
  .command('run')
  .argument('[task...]', 'task description (omit with --resume to reuse the recorded task)')
  .option('-c, --chain <chain>', 'named chain from config, or comma-separated lane names')
  .option('--resume <id>', 'continue an earlier run (see `qp report` for resumable ids)')
  .option('--no-wait', 'exit instead of waiting when every lane is blocked')
  .option('-q, --quiet', 'do not mirror lane output to the terminal')
  .option('--diff <mode>', 'handoff diff mode: none|stat|full (overrides handoff.diff)')
  .action(
    async (
      taskParts: string[],
      opts: { chain?: string; resume?: string; wait: boolean; quiet: boolean; diff?: string },
      cmd: Command,
    ) => {
      const cwd = process.cwd();
      const ctx = loadCtx(cwd, cmd.optsWithGlobals().config);

      let task = taskParts.join(' ');
      let chain = opts.chain;
      let resumeFrom: AttemptResult[] | undefined;
      let resumedFrom: string | undefined;
      let resumedRec: RunRecord | undefined;

      if (opts.resume) {
        const old = ctx.runs.get(opts.resume);
        if (!old) {
          process.stderr.write(`qp: no run record "${opts.resume}" (.qp/runs)\n`);
          process.exitCode = 1;
          return;
        }
        if (old.status === 'done') {
          process.stderr.write(`qp: run ${old.id} already finished on lane "${old.lane}"\n`);
          process.exitCode = 1;
          return;
        }
        if (old.status === 'running' && pidAlive(old.pid)) {
          process.stderr.write(`qp: run ${old.id} is still running (pid ${old.pid}); not resuming\n`);
          process.exitCode = 1;
          return;
        }
        if (!old.resumedBy) {
          if (task && task !== old.task) {
            process.stderr.write(
              `qp: run ${old.id} recorded a different task; omit the task argument to continue it, or start a new run.\n`,
            );
            process.exitCode = 1;
            return;
          }
          task = old.task;
          chain = chain ?? old.chain;
          resumeFrom = old.attempts;
          resumedFrom = old.id;
          resumedRec = old;
        } else {
          process.stderr.write(`qp: run ${old.id} was already resumed by ${old.resumedBy}; resume that one instead\n`);
          process.exitCode = 1;
          return;
        }
      }

      if (!task) {
        process.stderr.write('qp: give a task, or --resume <id> to continue a recorded run\n');
        process.exitCode = 1;
        return;
      }

      const lanes = chain ? orderLanes(ctx.cfg, chain) : orderLanes(ctx.cfg, undefined, ctx.store);
      const rec = ctx.runs.create({ task, chain, resumedFrom, attempts: resumeFrom });
      if (resumedRec) ctx.runs.markResumed(resumedRec, rec.id);
      process.stderr.write(`qp: run ${rec.id}${resumedFrom ? ` (resuming ${resumedFrom})` : ''}\n`);

      const leases = leasesFor(ctx);
      let verdict: TaskVerdict;
      try {
        verdict = await runTask(task, ctx.cfg, lanes, ctx.store, {
          cwd,
          wait: opts.wait,
          resume: resumeFrom,
          leases,
          leaseOwner: rec.id,
          diffMode: parseDiff(opts.diff),
          onUpdate: wireRecord(ctx.runs, rec),
          runOpts: {
            tee: !opts.quiet,
            logsDir: join(cwd, ctx.cfg.defaults?.logsDir ?? DEFAULTS.logsDir),
          },
        });
      } finally {
        leases.releaseRun(rec.id);
      }
      process.exitCode = report(verdict, rec.id);
    },
  );

program
  .command('status')
  .description('show each lane: available / blocked until / unknown')
  .addOption(new Option('--json', 'machine-readable output'))
  .action((opts: { json?: boolean }, cmd: Command) => {
    const ctx = loadCtx(process.cwd(), cmd.optsWithGlobals().config);
    const rows = laneStatuses(
      orderLanes(ctx.cfg, undefined, ctx.store),
      ctx.store,
      new Date(),
      existsSync(ctx.leasesDir) ? new LeaseSet(ctx.leasesDir).heldLanes() : {},
    );
    const unfinished = ctx.runs.list().filter((r) => ctx.runs.resumable(r) || r.status === 'running');
    if (opts.json) {
      console.log(JSON.stringify({ lanes: rows, unfinishedRuns: unfinished.map((r) => r.id) }, null, 2));
      return;
    }
    console.log(formatStatus(rows));
    if (unfinished.length > 0) {
      console.log('\nunfinished runs:');
      for (const r of unfinished.slice(0, 5)) {
        const how = r.status === 'running' ? `running (pid ${r.pid})` : `${r.status} — resume: qp run --resume ${r.id}`;
        console.log(`  ${r.id}  ${how}  ${r.task.slice(0, 60)}`);
      }
    }
  });

program
  .command('top')
  .description('live dashboard: lane reset countdowns, running tasks, queue depth (q to quit)')
  .option('--interval <seconds>', 'refresh interval', (v) => parseFloat(v), 1)
  .option('--once', 'draw a single frame and exit (always the case when piped)')
  .action(async (opts: { interval: number; once?: boolean }, cmd: Command) => {
    const cwd = process.cwd();
    const ctx = loadCtx(cwd, cmd.optsWithGlobals().config);
    if (!Number.isFinite(opts.interval) || opts.interval <= 0) {
      process.stderr.write('qp: --interval must be a positive number of seconds\n');
      process.exitCode = 1;
      return;
    }
    const lock = join(cwd, '.qp', 'watch.lock');
    const collect = () => {
      const q = new TaskQueue(ctx.queueDir);
      let watcherPid: number | null = null;
      try {
        const pid = parseInt(readFileSync(lock, 'utf8'), 10);
        if (pid && pidAlive(pid)) watcherPid = pid;
      } catch {
        /* no lockfile or unreadable → no watcher */
      }
      const records = ctx.runs.list();
      return {
        repo: basename(cwd),
        snap: topSnapshot({
          lanes: orderLanes(ctx.cfg, undefined, ctx.store),
          store: ctx.store,
          leased: existsSync(ctx.leasesDir) ? new LeaseSet(ctx.leasesDir).heldLanes() : {},
          records,
          queue: {
            pending: q.list('pending'),
            running: q.list('running'),
            done: q.list('done'),
            failed: q.list('failed'),
          },
          isResumable: (r: RunRecord) => ctx.runs.resumable(r),
          watcherPid,
        }),
      };
    };
    await runTop({
      collect,
      intervalMs: opts.interval * 1000,
      once: opts.once,
      io: { out: process.stdout, inp: process.stdin },
    });
  });

program
  .command('queue')
  .description('list queued tasks')
  .action((_opts, cmd: Command) => {
    const ctx = loadCtx(process.cwd(), cmd.optsWithGlobals().config);
    const q = new TaskQueue(ctx.queueDir);
    let printed = false;
    for (const state of ['pending', 'running', 'done', 'failed'] as const) {
      const items = q.list(state);
      if (items.length === 0) continue;
      printed = true;
      console.log(`${state}:`);
      for (const i of items) {
        const wake = i.notBefore ? Date.parse(i.notBefore) : NaN;
        const deferred =
          state === 'pending' && Number.isFinite(wake) && wake > Date.now()
            ? `  [deferred until ${new Date(wake).toLocaleTimeString()}${i.defers ? ` x${i.defers}` : ''}${i.deferReason ? ` — ${i.deferReason}` : ''}]`
            : '';
        const tail = `${i.result ? `  → ${i.result}${i.lane ? ` on ${i.lane}` : ''}` : ''}${i.runId ? `  run ${i.runId}` : ''}`;
        console.log(`  ${i.id}  ${i.task.slice(0, 80)}${tail}${deferred}`);
      }
    }
    if (!printed) console.log('queue is empty');
  });

program
  .command('report')
  .description('run history: per-lane attempt stats, queue outcomes, resumable runs')
  .option('--lane <name>', 'drill into one lane: every recorded attempt with log refs')
  .addOption(new Option('--json', 'machine-readable output'))
  .action((opts: { lane?: string; json?: boolean }, cmd: Command) => {
    const ctx = loadCtx(process.cwd(), cmd.optsWithGlobals().config);
    if (opts.lane !== undefined) {
      const detail = laneReport(ctx.runs.list(), opts.lane);
      console.log(opts.json ? JSON.stringify(detail, null, 2) : formatLaneReport(detail));
      if (detail.stats.attempts === 0) process.exitCode = 1;
      return;
    }
    const rep = buildReport(ctx.runs.list(), new TaskQueue(ctx.queueDir).list());
    console.log(opts.json ? JSON.stringify(rep, null, 2) : formatReport(rep));
  });

program
  .command('prune')
  .description('delete run records older than N days (default 30; live runs are never touched)')
  .option('--days <n>', 'age cutoff in days', (v) => parseInt(v, 10), 30)
  .action((opts: { days: number }, cmd: Command) => {
    const ctx = loadCtx(process.cwd(), cmd.optsWithGlobals().config);
    if (!Number.isFinite(opts.days) || opts.days < 1) {
      process.stderr.write('qp: --days must be a positive integer\n');
      process.exitCode = 1;
      return;
    }
    const removed = ctx.runs.prune(opts.days);
    console.log(removed.length > 0 ? `pruned ${removed.length} run record(s)` : 'nothing to prune');
  });

program
  .command('add')
  .argument('<task...>', 'task description')
  .option('-c, --chain <chain>', 'chain override for this task')
  .description('enqueue a task for `qp watch`')
  .action((taskParts: string[], opts: { chain?: string }, cmd: Command) => {
    const ctx = loadCtx(process.cwd(), cmd.optsWithGlobals().config);
    const item = new TaskQueue(ctx.queueDir).add(taskParts.join(' '), opts.chain);
    console.log(`queued ${item.id}`);
  });

program
  .command('watch')
  .description('daemon: process queued tasks; --jobs N runs N tasks at once on different lanes')
  .option('-c, --chain <chain>', 'default chain for tasks without one')
  .option('-j, --jobs <n>', 'parallel tasks (one lane lease each)', (v) => parseInt(v, 10))
  .option('--once', 'process pending tasks then exit when the queue is empty')
  .option('--poll <seconds>', 'poll interval', (v) => parseInt(v, 10))
  .option('-q, --quiet', 'do not mirror lane output')
  .action(
    async (
      opts: { chain?: string; once?: boolean; poll?: number; jobs?: number; quiet: boolean },
      cmd: Command,
    ) => {
      const cwd = process.cwd();
      const ctx = loadCtx(cwd, cmd.optsWithGlobals().config);
      const lock = join(cwd, '.qp', 'watch.lock');

      if (existsSync(lock)) {
        let pid = 0;
        try {
          pid = parseInt(readFileSync(lock, 'utf8'), 10);
        } catch {
          /* unreadable lock → treat as stale */
        }
        if (pid && pidAlive(pid)) {
          process.stderr.write(`qp: another watcher is already running (pid ${pid})\n`);
          process.exitCode = 1;
          return;
        }
      }
      writeFileSync(lock, String(process.pid));
      const cleanup = () => rmSync(lock, { force: true });
      process.on('exit', cleanup);
      process.on('SIGINT', () => process.exit(130));
      process.on('SIGTERM', () => process.exit(143));

      const jobs = opts.jobs ?? ctx.cfg.queue?.jobs ?? 1;
      if (!Number.isInteger(jobs) || jobs < 1) {
        process.stderr.write(`qp: --jobs must be a positive integer (got "${opts.jobs}")\n`);
        process.exitCode = 1;
        return;
      }

      const q = new TaskQueue(ctx.queueDir);
      const leases = leasesFor(ctx);
      const pollMs = (opts.poll ?? ctx.pollSeconds) * 1_000;
      process.stderr.write(
        `qp: watching ${ctx.queueDir} (poll ${pollMs / 1000}s${jobs > 1 ? `, ${jobs} workers` : ''})\n`,
      );

      const logsDir = join(cwd, ctx.cfg.defaults?.logsDir ?? DEFAULTS.logsDir);
      const worker = async (wid: number) => {
        for (;;) {
          const item = q.claim();
          if (!item) {
            if (opts.once) return;
            await sleep(pollMs);
            continue;
          }
          process.stderr.write(`qp: [w${wid}] running ${item.id}: ${item.task.slice(0, 80)}\n`);
          const chain = item.chain ?? opts.chain;
          const lanes = chain ? orderLanes(ctx.cfg, chain) : orderLanes(ctx.cfg, undefined, ctx.store);
          const rec = ctx.runs.create({ task: item.task, chain });
          try {
            const verdict = await runTask(item.task, ctx.cfg, lanes, ctx.store, {
              cwd,
              wait: true,
              leases,
              leaseOwner: rec.id,
              onUpdate: wireRecord(ctx.runs, rec),
              runOpts: { tee: !opts.quiet, logsDir },
            });
            // A task that found every lane blocked/leased is not dead: put
            // it back until the earliest lane reset instead of failing it.
            const maxDefers = ctx.cfg.queue?.maxDefers ?? 10;
            const now = new Date();
            const resets = lanes.map((l) => ctx.store.blockedUntil(l.name, now));
            if (verdict.type === 'all-blocked') resets.push(verdict.earliestReset);
            const defer = deferDecision(verdict.type, resets, item.defers ?? 0, maxDefers, now);
            if (defer) {
              item.runId = rec.id;
              q.defer(item, defer.wakeAt, defer.reason);
              process.stderr.write(
                `qp: [w${wid}] ${item.id} deferred until ${defer.wakeAt.toLocaleTimeString()} ` +
                  `(x${item.defers}, ${defer.reason}, run ${rec.id})\n`,
              );
            } else {
              q.finish(item, verdict.type, {
                lane: verdict.type === 'done' ? verdict.lane : undefined,
                error:
                  verdict.type === 'failed'
                    ? verdict.lastError
                    : verdict.type === 'all-blocked' || verdict.type === 'timeout'
                      ? `${verdict.type}: defer limit ${maxDefers} reached`
                      : undefined,
                runId: rec.id,
              });
              process.stderr.write(`qp: [w${wid}] ${item.id} → ${verdict.type} (run ${rec.id})\n`);
            }
          } finally {
            // Any lease left behind (a throw between acquire and the inner
            // finally) must not pin the lane for the other workers.
            leases.releaseRun(rec.id);
          }
        }
      };
      await Promise.all(Array.from({ length: jobs }, (_, i) => worker(i + 1)));
      if (opts.once) {
        // Deferred items stay pending by design (--once never waits out a
        // lane reset); tell the user instead of a silent early exit.
        const left = q.list('pending');
        if (left.length > 0) {
          const wakes = left
            .map((i) => (i.notBefore ? Date.parse(i.notBefore) : NaN))
            .filter((w) => Number.isFinite(w));
          const eta = wakes.length > 0 ? ` until ${new Date(Math.min(...wakes)).toLocaleTimeString()}` : '';
          process.stderr.write(`qp: ${left.length} deferred item(s) left in queue${eta}\n`);
        }
      }
    },
  );

program
  .command('unblock')
  .argument('[lane]', 'lane name (omit to unblock all)')
  .description('clear stored blocked state')
  .action((lane: string | undefined, _opts, cmd: Command) => {
    const ctx = loadCtx(process.cwd(), cmd.optsWithGlobals().config);
    ctx.store.unblock(lane);
    console.log(lane ? `unblocked ${lane}` : 'all lanes unblocked');
  });

program
  .command('log')
  .argument(
    '[selector]',
    'run id prefix, queue item id prefix, lane name, or log filename fragment (default: newest log)',
  )
  .description('tail a lane attempt log from .qp/logs (or follow a live one)')
  .option('-n, --lines <n>', 'lines to print (0 = whole file)', (v) => parseInt(v, 10), 200)
  .option('-f, --follow', 'keep printing new bytes as the lane writes them')
  .option('--list', 'list recent log files instead of tailing')
  .action(
    async (
      selector: string | undefined,
      opts: { lines: number; follow?: boolean; list?: boolean },
      cmd: Command,
    ) => {
      const cwd = process.cwd();
      const ctx = loadCtx(cwd, cmd.optsWithGlobals().config);
      const logsDir = join(cwd, ctx.cfg.defaults?.logsDir ?? DEFAULTS.logsDir);

      if (opts.list) {
        const entries = listLogs(logsDir);
        if (entries.length === 0) {
          console.log(`no logs in ${logsDir} yet`);
          return;
        }
        for (const e of entries.slice(0, 20)) {
          const when = new Date(e.mtimeMs).toISOString().slice(0, 19).replace('T', ' ');
          const size = e.sizeBytes < 1024 ? `${e.sizeBytes}B` : `${Math.round(e.sizeBytes / 1024)}K`;
          console.log(`  ${when}  ${String(size).padStart(6)}  ${e.name}`);
        }
        return;
      }

      const q = new TaskQueue(ctx.queueDir);
      const resolved = resolveLog(logsDir, {
        selector,
        records: ctx.runs.list(),
        queueItems: q.list(),
        lanes: ctx.cfg.lanes.map((l) => l.name),
      });
      if (!resolved.entry) {
        process.stderr.write(`qp: ${resolved.error}\n`);
        process.exitCode = 1;
        return;
      }
      const path = resolved.entry.path;
      process.stderr.write(`qp: ${resolved.entry.name}\n`);

      const tail = tailFile(path, opts.lines);
      if (tail.truncated) {
        process.stderr.write('qp: (log exceeds 1 MiB; showing the tail window)\n');
      }
      if (tail.text) process.stdout.write(tail.text + '\n');

      if (opts.follow) {
        // Cheap tail -f: poll the file every 500 ms and stream appends.
        // Reset the offset when the file shrinks (rotation/truncate).
        let offset = statSync(path).size;
        for (;;) {
          await sleep(500);
          const size = statSync(path).size;
          if (size < offset) offset = size;
          if (size === offset) continue;
          const fd = openSync(path, 'r');
          try {
            const buf = Buffer.alloc(size - offset);
            const n = readSync(fd, buf, 0, buf.length, offset);
            process.stdout.write(buf.subarray(0, n).toString('utf8'));
            offset += n;
          } finally {
            closeSync(fd);
          }
        }
      }
    },
  );


program
  .command('probe')
  .argument('[lane]', 'lane name (omit with --all to probe every lane)')
  .description('send a tiny prompt to a lane and classify it: available / limited / auth-error / error')
  .option('--all', 'probe every configured lane')
  .option('-p, --prompt <text>', 'probe prompt (keep it tiny — quota is scarce)')
  .option('--timeout <seconds>', 'per-lane probe cap', (v) => parseInt(v, 10))
  .addOption(new Option('--json', 'machine-readable output'))
  .action(
    async (
      laneName: string | undefined,
      opts: { all?: boolean; prompt?: string; timeout?: number; json?: boolean },
      cmd: Command,
    ) => {
      const cwd = process.cwd();
      const ctx = loadCtx(cwd, cmd.optsWithGlobals().config);

      let lanes: Lane[];
      if (opts.all) {
        lanes = orderLanes(ctx.cfg, undefined, ctx.store);
      } else if (laneName) {
        const cfg = ctx.cfg.lanes.find((l) => l.name === laneName);
        if (!cfg) {
          process.stderr.write(`qp: no lane named "${laneName}" in config\n`);
          process.exitCode = 1;
          return;
        }
        lanes = [resolveLane(ctx.cfg, cfg)];
      } else {
        process.stderr.write('qp: give a lane name or --all\n');
        process.exitCode = 1;
        return;
      }

      const results: ProbeResult[] = [];
      for (const lane of lanes) {
        const r = await probeLane(lane, ctx.store, {
          cwd,
          prompt: opts.prompt ?? DEFAULT_PROBE_PROMPT,
          timeoutMs: opts.timeout !== undefined ? opts.timeout * 1000 : undefined,
          runOpts: { tee: !opts.json },
        });
        results.push(r);
        if (!opts.json) {
          const reset = r.resetAt !== null ? `, resets ${r.resetAt.toLocaleTimeString()}` : '';
          const quota = r.quotaLeft !== null ? `, ${r.quotaLeft}% quota` : '';
          console.log(`${r.lane.padEnd(14)} ${r.status.padEnd(11)} ${r.durationMs}ms  ${r.evidence}${reset}${quota}`);
        }
      }
      if (opts.json) console.log(JSON.stringify(results, null, 2));
      if (results.some((r) => r.status === 'limited' || r.status === 'auth-error')) {
        process.exitCode = 2;
      }
    },
  );

program
  .command('init')
  .description('write a starter quota-pilot.yaml')
  .action(() => {
    const res = initConfig(process.cwd());
    if (!res.created) {
      console.log(`config already exists: ${res.configPath}`);
      return;
    }
    console.log(`wrote ${res.configPath}${res.gitignoreNote ? ` (${res.gitignoreNote})` : ''}`);
    console.log('edit the lane commands, then: qp run "your task"');
  });


program.parseAsync().catch((e) => {
  if (e instanceof ConfigError) {
    process.stderr.write(`qp: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`qp: ${(e as Error).stack ?? e}\n`);
  process.exitCode = 1;
});
