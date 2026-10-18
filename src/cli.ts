#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command, Option } from 'commander';
import { ConfigError, DEFAULTS, findConfigFile, loadConfig, orderLanes, resolveLane } from './config.js';
import { initConfig } from './init.js';
import { runTask, type OrchestrateOptions } from './orchestrate.js';
import { DEFAULT_PROBE_PROMPT, probeLane, type ProbeResult } from './probe.js';
import { TaskQueue } from './queue.js';
import { buildReport, formatReport } from './report.js';
import { pidAlive, RunStore, type RunRecord } from './runs.js';
import { LaneStore } from './state.js';
import { formatStatus, laneStatuses } from './status.js';
import type { AttemptResult, Config, Lane, TaskVerdict } from './types.js';

interface Ctx {
  cfg: Config;
  lanes: Lane[];
  store: LaneStore;
  queueDir: string;
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
    lanes: orderLanes(cfg),
    store: new LaneStore(join(cwd, d.stateFile)),
    queueDir: join(cwd, cfg.queue?.dir ?? d.queueDir),
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
 * Persist a run record: rewrites it after every lane attempt and finalizes
 * it with the verdict; a SIGINT/exit while still running marks it
 * 'interrupted' so `qp run --resume <id>` can pick the task up.
 */
function wireRecord(runs: RunStore, rec: RunRecord): OrchestrateOptions['onUpdate'] {
  // 'exit' alone is not enough: a signal under its default disposition kills
  // the process without firing it. Catch SIGINT/SIGTERM, mark the record,
  // then exit with the conventional code (which does fire 'exit').
  const onExit = () => runs.markInterrupted(rec);
  const onSigint = () => {
    runs.markInterrupted(rec);
    process.exit(130);
  };
  const onSigterm = () => {
    runs.markInterrupted(rec);
    process.exit(143);
  };
  process.once('exit', onExit);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
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
    process.off('exit', onExit);
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const program = new Command();
program
  .name('qp')
  .description('Run one coding task across several AI agent CLIs; quota-limit hits hand the task to the next lane.')
  .version('0.3.0')
  .option('--config <path>', 'path to quota-pilot.yaml');

program
  .command('run')
  .argument('[task...]', 'task description (omit with --resume to reuse the recorded task)')
  .option('-c, --chain <chain>', 'named chain from config, or comma-separated lane names')
  .option('--resume <id>', 'continue an earlier run (see `qp report` for resumable ids)')
  .option('--no-wait', 'exit instead of waiting when every lane is blocked')
  .option('-q, --quiet', 'do not mirror lane output to the terminal')
  .action(
    async (
      taskParts: string[],
      opts: { chain?: string; resume?: string; wait: boolean; quiet: boolean },
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

      const lanes = chain ? orderLanes(ctx.cfg, chain) : ctx.lanes;
      const rec = ctx.runs.create({ task, chain, resumedFrom, attempts: resumeFrom });
      if (resumedRec) ctx.runs.markResumed(resumedRec, rec.id);
      process.stderr.write(`qp: run ${rec.id}${resumedFrom ? ` (resuming ${resumedFrom})` : ''}\n`);

      const verdict = await runTask(task, ctx.cfg, lanes, ctx.store, {
        cwd,
        wait: opts.wait,
        resume: resumeFrom,
        onUpdate: wireRecord(ctx.runs, rec),
        runOpts: {
          tee: !opts.quiet,
          logsDir: join(cwd, ctx.cfg.defaults?.logsDir ?? DEFAULTS.logsDir),
        },
      });
      process.exitCode = report(verdict, rec.id);
    },
  );

program
  .command('status')
  .description('show each lane: available / blocked until / unknown')
  .addOption(new Option('--json', 'machine-readable output'))
  .action((opts: { json?: boolean }, cmd: Command) => {
    const ctx = loadCtx(process.cwd(), cmd.optsWithGlobals().config);
    const rows = laneStatuses(ctx.lanes, ctx.store);
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
        const tail = `${i.result ? `  → ${i.result}${i.lane ? ` on ${i.lane}` : ''}` : ''}${i.runId ? `  run ${i.runId}` : ''}`;
        console.log(`  ${i.id}  ${i.task.slice(0, 80)}${tail}`);
      }
    }
    if (!printed) console.log('queue is empty');
  });

program
  .command('report')
  .description('run history: per-lane attempt stats, queue outcomes, resumable runs')
  .addOption(new Option('--json', 'machine-readable output'))
  .action((opts: { json?: boolean }, cmd: Command) => {
    const ctx = loadCtx(process.cwd(), cmd.optsWithGlobals().config);
    const rep = buildReport(ctx.runs.list(), new TaskQueue(ctx.queueDir).list());
    console.log(opts.json ? JSON.stringify(rep, null, 2) : formatReport(rep));
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
  .description('daemon: process queued tasks one at a time')
  .option('-c, --chain <chain>', 'default chain for tasks without one')
  .option('--once', 'process pending tasks then exit when the queue is empty')
  .option('--poll <seconds>', 'poll interval', (v) => parseInt(v, 10))
  .option('-q, --quiet', 'do not mirror lane output')
  .action(async (opts: { chain?: string; once?: boolean; poll?: number; quiet: boolean }, cmd: Command) => {
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

    const q = new TaskQueue(ctx.queueDir);
    const pollMs = (opts.poll ?? ctx.pollSeconds) * 1_000;
    process.stderr.write(`qp: watching ${ctx.queueDir} (poll ${pollMs / 1000}s)\n`);

    for (;;) {
      const item = q.claim();
      if (!item) {
        if (opts.once) break;
        await sleep(pollMs);
        continue;
      }
      process.stderr.write(`qp: running ${item.id}: ${item.task.slice(0, 80)}\n`);
      const chain = item.chain ?? opts.chain;
      const lanes = chain ? orderLanes(ctx.cfg, chain) : ctx.lanes;
      const rec = ctx.runs.create({ task: item.task, chain });
      const orchOpts: OrchestrateOptions = {
        cwd,
        wait: true,
        onUpdate: wireRecord(ctx.runs, rec),
        runOpts: { tee: !opts.quiet, logsDir: join(cwd, ctx.cfg.defaults?.logsDir ?? DEFAULTS.logsDir) },
      };
      const verdict = await runTask(item.task, ctx.cfg, lanes, ctx.store, orchOpts);
      q.finish(item, verdict.type, {
        lane: verdict.type === 'done' ? verdict.lane : undefined,
        error: verdict.type === 'failed' ? verdict.lastError : undefined,
        runId: rec.id,
      });
      process.stderr.write(`qp: ${item.id} → ${verdict.type} (run ${rec.id})\n`);
      if (opts.once) break;
    }
  });

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
        lanes = ctx.lanes;
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
          const reset =
            r.resetAt !== null ? `, resets ${r.resetAt.toLocaleTimeString()}` : '';
          console.log(`${r.lane.padEnd(14)} ${r.status.padEnd(11)} ${r.durationMs}ms  ${r.evidence}${reset}`);
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
