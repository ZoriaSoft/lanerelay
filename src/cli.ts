#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command, Option } from 'commander';
import { ConfigError, DEFAULTS, findConfigFile, loadConfig, orderLanes } from './config.js';
import { initConfig } from './init.js';
import { runTask, type OrchestrateOptions } from './orchestrate.js';
import { TaskQueue } from './queue.js';
import { LaneStore } from './state.js';
import { formatStatus, laneStatuses } from './status.js';
import type { Config, Lane, TaskVerdict } from './types.js';

interface Ctx {
  cfg: Config;
  lanes: Lane[];
  store: LaneStore;
  queueDir: string;
  pollSeconds: number;
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
  };
}

function report(verdict: TaskVerdict): number {
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
        `\nqp: every lane is blocked${verdict.earliestReset ? `; earliest reset ${verdict.earliestReset.toLocaleTimeString()}` : ''}. Rerun without --no-wait to sleep until it resets, or 'qp status' to inspect.\n`,
      );
      return 2;
    case 'failed':
      process.stderr.write(`\nqp: all lanes failed; last error: ${verdict.lastError}\n`);
      return 3;
    case 'timeout':
      process.stderr.write('\nqp: gave up waiting for a free lane (maxWaitMinutes exceeded)\n');
      return 4;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const program = new Command();
program
  .name('qp')
  .description('Run one coding task across several AI agent CLIs; quota-limit hits hand the task to the next lane.')
  .version('0.1.0')
  .option('--config <path>', 'path to quota-pilot.yaml');

program
  .command('run')
  .argument('<task...>', 'task description')
  .option('-c, --chain <chain>', 'named chain from config, or comma-separated lane names')
  .option('--no-wait', 'exit instead of waiting when every lane is blocked')
  .option('-q, --quiet', 'do not mirror lane output to the terminal')
  .action(async (taskParts: string[], opts: { chain?: string; wait: boolean; quiet: boolean }, cmd: Command) => {
    const cwd = process.cwd();
    const ctx = loadCtx(cwd, cmd.optsWithGlobals().config);
    const task = taskParts.join(' ');
    const lanes = opts.chain ? orderLanes(ctx.cfg, opts.chain) : ctx.lanes;
    const verdict = await runTask(task, ctx.cfg, lanes, ctx.store, {
      cwd,
      wait: opts.wait,
      runOpts: {
        tee: !opts.quiet,
        logsDir: join(cwd, ctx.cfg.defaults?.logsDir ?? DEFAULTS.logsDir),
      },
    });
    process.exitCode = report(verdict);
  });

program
  .command('status')
  .description('show each lane: available / blocked until / unknown')
  .addOption(new Option('--json', 'machine-readable output'))
  .action((opts: { json?: boolean }, cmd: Command) => {
    const ctx = loadCtx(process.cwd(), cmd.optsWithGlobals().config);
    const rows = laneStatuses(ctx.lanes, ctx.store);
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      console.log(formatStatus(rows));
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
        console.log(`  ${i.id}  ${i.task.slice(0, 80)}${i.result ? `  → ${i.result}${i.lane ? ` on ${i.lane}` : ''}` : ''}`);
      }
    }
    if (!printed) console.log('queue is empty');
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
      if (pid && isAlive(pid)) {
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
      const orchOpts: OrchestrateOptions = {
        cwd,
        wait: true,
        runOpts: { tee: !opts.quiet, logsDir: join(cwd, ctx.cfg.defaults?.logsDir ?? DEFAULTS.logsDir) },
      };
      const verdict = await runTask(item.task, ctx.cfg, lanes, ctx.store, orchOpts);
      q.finish(item, verdict.type, {
        lane: verdict.type === 'done' ? verdict.lane : undefined,
        error: verdict.type === 'failed' ? verdict.lastError : undefined,
      });
      process.stderr.write(`qp: ${item.id} → ${verdict.type}\n`);
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

program.parseAsync().catch((e) => {
  if (e instanceof ConfigError) {
    process.stderr.write(`qp: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`qp: ${(e as Error).stack ?? e}\n`);
  process.exitCode = 1;
});
