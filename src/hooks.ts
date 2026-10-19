import { execFile } from 'node:child_process';
import type { HookDef, HooksConfig } from './types.js';

export type HookEvent = 'limit' | 'handoff' | 'finish' | 'fail';

export interface HookVars {
  event: HookEvent;
  lane: string;
  task: string;
  status: string;
  /** Extra fields merged into the JSON payload / env prefix. */
  [k: string]: string;
}

const TEMPLATE = /\{\{\s*(\w+)\s*\}\}/g;

function render(template: string, vars: HookVars): string {
  return template.replace(TEMPLATE, (_, k: string) => vars[k] ?? '');
}

/**
 * Fire configured hooks for an event. Command hooks run via sh -c with
 * {{var}} templating plus LR_* env vars; webhook hooks POST a JSON body.
 * Failures are reported to stderr and never throw — notifications must
 * never take down a run.
 */
export async function fireHooks(
  hooks: HooksConfig | undefined,
  event: HookEvent,
  vars: HookVars,
): Promise<void> {
  const defs: HookDef[] = hooks?.[event] ?? [];
  await Promise.all(
    defs.map(async (def) => {
      try {
        if (def.command) {
          await runCommand(render(def.command, vars), vars);
        }
        if (def.webhook) {
          await postWebhook(def.webhook, vars);
        }
      } catch (e) {
        process.stderr.write(`lanerelay: ${event} hook failed: ${(e as Error).message}\n`);
      }
    }),
  );
}

function runCommand(command: string, vars: HookVars): Promise<void> {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(vars)) {
    env[`LR_${k.toUpperCase()}`] = v;
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = execFile('sh', ['-c', command], { env, timeout: 15_000 }, (err) => {
    if (err) reject(err);
    else resolve();
  });
  child.unref();
  return promise;
}

async function postWebhook(url: string, vars: HookVars): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...vars, ts: new Date().toISOString() }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`webhook ${url} → HTTP ${res.status}`);
}
