import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AttemptResult } from './types.js';

export type RunStatus =
  | 'running'
  | 'done'
  | 'all-blocked'
  | 'failed'
  | 'timeout'
  | 'interrupted'
  | 'resumed';

export interface RunRecord {
  id: string;
  task: string;
  /** Chain selector used for lane resolution, when the caller gave one. */
  chain?: string;
  pid: number;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  /** Lane that finished the task (status 'done'). */
  lane?: string;
  /** Error summary for failed/all-blocked/timeout. */
  error?: string;
  /** Id of the run this one continues (lanerelay run --resume <id>). */
  resumedFrom?: string;
  /** Set on a record once a successor run resumes it. */
  resumedBy?: string;
  /** Attempts; pre-seeded from the resumed run on continuation. */
  attempts: AttemptResult[];
}

/** True when a process with this pid is alive right now. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * One JSON file per `lanerelay run`/`lanerelay watch` task attempt in `.lanerelay/runs/`.
 * Written atomically (tmp + rename) after every lane attempt, so a killed
 * process still leaves a resumable record. A record whose status stays
 * 'running' while its pid is dead is treated as 'interrupted' on read.
 */
export class RunStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private save(rec: RunRecord): void {
    const tmp = `${this.path(rec.id)}.${process.pid}.tmp`;
    // Dates inside attempts serialize to ISO; reads revive resetAt.
    writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
    renameSync(tmp, this.path(rec.id));
  }

  private readPath(path: string): RunRecord | null {
    try {
      const rec = JSON.parse(readFileSync(path, 'utf8')) as RunRecord;
      for (const a of rec.attempts ?? []) {
        if (a.verdict.type === 'limited' && typeof (a.verdict.resetAt as unknown) === 'string') {
          a.verdict.resetAt = new Date(a.verdict.resetAt as unknown as string);
        }
      }
      return rec;
    } catch {
      return null;
    }
  }

  /** Create a running record (pid = this process). */
  create(input: { task: string; chain?: string; resumedFrom?: string; attempts?: AttemptResult[] }): RunRecord {
    const rec: RunRecord = {
      id: `r-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      task: input.task,
      chain: input.chain,
      pid: process.pid,
      status: 'running',
      startedAt: new Date().toISOString(),
      resumedFrom: input.resumedFrom,
      attempts: input.attempts ?? [],
    };
    this.save(rec);
    return rec;
  }

  /** Rewrite the record on disk (attempts/status/finishedAt as given). */
  update(rec: RunRecord): void {
    this.save(rec);
  }

  /** Finalize a record for a finished run. */
  finish(rec: RunRecord, status: RunStatus, extra?: { lane?: string; error?: string }): void {
    rec.status = status;
    rec.finishedAt = new Date().toISOString();
    rec.lane = extra?.lane;
    rec.error = extra?.error;
    this.save(rec);
  }

  /** Best-effort mark on process death: running → interrupted. */
  markInterrupted(rec: RunRecord): void {
    if (rec.status !== 'running') return;
    rec.status = 'interrupted';
    rec.finishedAt = new Date().toISOString();
    try {
      this.save(rec);
    } catch {
      /* process is dying; ignore write failures */
    }
  }

  /** Mark a superseded record when `lanerelay run --resume` continues it. */
  markResumed(rec: RunRecord, byId: string): void {
    rec.status = 'resumed';
    rec.resumedBy = byId;
    rec.finishedAt = rec.finishedAt ?? new Date().toISOString();
    this.save(rec);
  }

  get(id: string): RunRecord | null {
    const p = this.path(id);
    if (!existsSync(p)) return null;
    return this.readPath(p);
  }

  /**
   * A record may be continued when its task never finished and no live
   * process owns it. 'running' records with a dead pid count as interrupted.
   */
  resumable(rec: RunRecord): boolean {
    if (rec.status === 'done' || rec.status === 'resumed') return false;
    if (rec.status === 'running' && pidAlive(rec.pid)) return false;
    return true;
  }

  /**
   * All records, newest first. 'running' records owned by dead pids are
   * reported (not rewritten) as 'interrupted'.
   */
  list(): RunRecord[] {
    if (!existsSync(this.dir)) return [];
    const out: RunRecord[] = [];
    for (const f of readdirSync(this.dir).filter((f) => f.endsWith('.json'))) {
      const rec = this.readPath(join(this.dir, f));
      if (!rec) continue;
      if (rec.status === 'running' && !pidAlive(rec.pid)) rec.status = 'interrupted';
      out.push(rec);
    }
    out.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
    return out;
  }

  /**
   * Delete records older than `days` (measured from finishedAt, or
   * startedAt when the run never finished). Live runs — status 'running'
   * with a live pid — and unreadable files are never touched.
   * Returns the removed record ids.
   */
  prune(days: number, now: Date = new Date()): string[] {
    const cutoff = now.getTime() - days * 86_400_000;
    const removed: string[] = [];
    if (!existsSync(this.dir)) return removed;
    for (const f of readdirSync(this.dir).filter((f) => f.endsWith('.json'))) {
      const p = join(this.dir, f);
      const rec = this.readPath(p);
      if (!rec) continue;
      if (rec.status === 'running' && pidAlive(rec.pid)) continue;
      const stamp = Date.parse(rec.finishedAt ?? rec.startedAt ?? '');
      if (!Number.isFinite(stamp) || stamp >= cutoff) continue;
      rmSync(p, { force: true });
      removed.push(rec.id ?? f.replace(/\.json$/, ''));
    }
    return removed;
  }
}
