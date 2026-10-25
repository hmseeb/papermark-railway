// In-process stand-in for @trigger.dev/sdk, aliased in next.config.mjs.
// Papermark hands document conversion, notifications and exports to
// Trigger.dev cloud. Self-hosting Trigger.dev needs a Docker or Kubernetes
// worker, which Railway does not offer, so tasks run here, inside the web
// process, with run state kept in memory on globalThis (Next bundles this
// module into every route separately, so module scope would not be shared).
// shortcut: no retries, no cron schedules, and pending or delayed runs are
// lost on restart; set TRIGGER_SECRET_KEY on a real Trigger.dev project and
// drop the alias to upgrade.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { registry } from "./registry";

export type RunStatus =
  | "DELAYED"
  | "QUEUED"
  | "EXECUTING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED";

export type ShimRun = {
  id: string;
  taskIdentifier: string;
  status: RunStatus;
  tags: string[];
  payload: any;
  metadata: Record<string, any>;
  output?: any;
  error?: { message: string };
  createdAt: Date;
  updatedAt: Date;
  finishedAt?: Date;
  parentId?: string;
  timer?: ReturnType<typeof setTimeout>;
  done?: Promise<void>;
};

type TaskDef = { id: string; run: (payload: any, ctx: any) => any; schema?: any };

const g = globalThis as any;
const store: Map<string, ShimRun> = (g.__pmTriggerRuns ??= new Map());
const als: AsyncLocalStorage<ShimRun> = (g.__pmTriggerAls ??=
  new AsyncLocalStorage<ShimRun>());
const active: { n: number; queue: (() => void)[] } = (g.__pmTriggerSlots ??= {
  n: 0,
  queue: [],
});
// mupdf page rendering is memory hungry; two concurrent runs keep a 1 GB
// container safe while still overlapping I/O-bound notification tasks.
const MAX_CONCURRENT = Number(process.env.TRIGGER_SHIM_CONCURRENCY || 2);
const MAX_TIMEOUT = 2_147_483_647;
const FINISHED_TTL = 6 * 60 * 60 * 1000;

const now = () => new Date();

function parseDelay(delay: unknown): number {
  if (delay == null) return 0;
  if (delay instanceof Date) return Math.max(0, delay.getTime() - Date.now());
  if (typeof delay === "number") return delay * 1000;
  const m = /^(\d+)\s*(s|m|h|d|w)$/.exec(String(delay).trim());
  if (!m) return 0;
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2]]!;
  return Number(m[1]) * unit;
}

function prune() {
  const cutoff = Date.now() - FINISHED_TTL;
  store.forEach((run, id) => {
    if (run.finishedAt && run.finishedAt.getTime() < cutoff) store.delete(id);
  });
}

async function acquire() {
  if (active.n < MAX_CONCURRENT) {
    active.n++;
    return;
  }
  await new Promise<void>((resolve) => active.queue.push(resolve));
  active.n++;
}

function release() {
  active.n--;
  active.queue.shift()?.();
}

async function resolveDef(id: string): Promise<TaskDef | undefined> {
  const load = (registry as Record<string, () => Promise<any>>)[id];
  return load ? (await load())?.__def : undefined;
}

async function execute(run: ShimRun, def: TaskDef | undefined) {
  if (run.status === "CANCELED") return;
  run.status = "QUEUED";
  run.updatedAt = now();
  await acquire();
  try {
    if (run.status === "CANCELED") return;
    if (!def) throw new Error(`Unknown task "${run.taskIdentifier}"`);
    run.status = "EXECUTING";
    run.updatedAt = now();
    const payload = def.schema?.parse ? def.schema.parse(run.payload) : run.payload;
    const ctx = { run: { id: run.id, tags: run.tags }, task: { id: def.id } };
    run.output = await als.run(run, () => def.run(payload, { ctx }));
    run.status = "COMPLETED";
  } catch (error) {
    run.status = "FAILED";
    run.error = { message: error instanceof Error ? error.message : String(error) };
    console.error(`[trigger-shim] ${run.taskIdentifier} ${run.id} failed:`, error);
  } finally {
    run.updatedAt = now();
    run.finishedAt = now();
    release();
  }
}

function enqueue(
  id: string,
  payload: any,
  options: any = {},
  def?: TaskDef,
): ShimRun {
  prune();
  if (options.idempotencyKey) {
    const existing = Array.from(store.values()).find(
      (r) =>
        r.taskIdentifier === id &&
        (r as any).idempotencyKey === options.idempotencyKey &&
        r.status !== "FAILED" &&
        r.status !== "CANCELED",
    );
    if (existing) return existing;
  }
  const tags = ([] as string[]).concat(options.tags ?? []);
  const run: ShimRun = {
    id: `run_${randomUUID().replace(/-/g, "")}`,
    taskIdentifier: id,
    status: "QUEUED",
    tags,
    payload,
    metadata: {},
    createdAt: now(),
    updatedAt: now(),
    parentId: als.getStore()?.id,
  };
  (run as any).idempotencyKey = options.idempotencyKey;
  store.set(run.id, run);

  const start = () =>
    (run.done = (async () => execute(run, def ?? (await resolveDef(id))))());
  const delay = parseDelay(options.delay);
  if (delay > 0) {
    run.status = "DELAYED";
    // Past the timer limit (multi-week marketing follow-ups) the run stays
    // DELAYED forever rather than firing immediately on overflow.
    if (delay <= MAX_TIMEOUT) run.timer = setTimeout(start, delay);
  } else {
    setImmediate(start);
  }
  return run;
}

const handle = (run: ShimRun) => ({ id: run.id, publicAccessToken: "shim" });

async function waitFor(run: ShimRun) {
  while (!run.done) await new Promise((r) => setTimeout(r, 50));
  await run.done;
  return run.status === "COMPLETED"
    ? { ok: true as const, id: run.id, output: run.output }
    : { ok: false as const, id: run.id, error: run.error };
}

function makeTask(def: TaskDef) {
  return {
    id: def.id,
    __def: def,
    trigger: async (payload?: any, options?: any) =>
      handle(enqueue(def.id, payload, options, def)),
    triggerAndWait: async (payload?: any, options?: any): Promise<any> =>
      waitFor(enqueue(def.id, payload, { ...options, delay: undefined }, def)),
    batchTrigger: async (items: { payload: any; options?: any }[]) => ({
      batchId: `batch_${randomUUID()}`,
      runs: items.map((i) => handle(enqueue(def.id, i.payload, i.options, def))),
    }),
    batchTriggerAndWait: async (items: { payload: any; options?: any }[]) => ({
      runs: await Promise.all(
        items.map((i) => waitFor(enqueue(def.id, i.payload, i.options, def))),
      ),
    }),
  };
}

export function task<T = any>(def: T & TaskDef): any {
  return makeTask(def);
}

export function schemaTask<T = any>(def: T & TaskDef): any {
  return makeTask(def);
}

export const schedules = {
  task<T = any>(def: T & TaskDef): any {
    return makeTask(def);
  },
};

export const tasks = {
  trigger: async <T = any>(id: string, payload?: any, options?: any) =>
    handle(enqueue(id, payload, options)),
  triggerAndWait: async <T = any>(id: string, payload?: any, options?: any): Promise<any> =>
    waitFor(enqueue(id, payload, { ...options, delay: undefined })),
  batchTrigger: async <T = any>(id: string, items: { payload: any; options?: any }[]) => ({
    batchId: `batch_${randomUUID()}`,
    runs: items.map((i) => handle(enqueue(id, i.payload, i.options))),
  }),
};

const toArray = (v: unknown) =>
  v == null ? undefined : ([] as unknown[]).concat(v as any).map(String);

export function listRuns(filter: {
  tag?: string | string[];
  taskIdentifier?: string | string[];
  status?: string | string[];
}): ShimRun[] {
  const tags = toArray(filter.tag);
  const ids = toArray(filter.taskIdentifier);
  const statuses = toArray(filter.status);
  return Array.from(store.values())
    .filter(
      (r) =>
        (!tags || r.tags.some((t) => tags.includes(t))) &&
        (!ids || ids.includes(r.taskIdentifier)) &&
        (!statuses || statuses.includes(r.status)),
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export const runs = {
  list: async (filter: any = {}) => ({ data: listRuns(filter) }),
  retrieve: async (id: string): Promise<any> => {
    const run = store.get(id);
    if (!run) throw new Error(`Run ${id} not found`);
    return run;
  },
  cancel: async (id: string) => {
    const run = store.get(id);
    if (run && !run.finishedAt) {
      if (run.timer) clearTimeout(run.timer);
      run.status = "CANCELED";
      run.updatedAt = now();
      run.finishedAt = now();
    }
    return { id };
  },
};

function metaTarget(run: ShimRun | undefined) {
  const api = {
    set(key: string, value: any) {
      if (run) {
        run.metadata[key] = value;
        run.updatedAt = now();
      }
      return api;
    },
    get: (key: string) => run?.metadata[key],
    current: () => run?.metadata,
    append(key: string, value: any) {
      if (run) run.metadata[key] = [...(run.metadata[key] ?? []), value];
      return api;
    },
    increment(key: string, by = 1) {
      if (run) run.metadata[key] = (run.metadata[key] ?? 0) + by;
      return api;
    },
    flush: async () => {},
  };
  return api;
}

export const metadata = {
  set: (key: string, value: any) => metaTarget(als.getStore()).set(key, value),
  get: (key: string) => metaTarget(als.getStore()).get(key),
  current: () => metaTarget(als.getStore()).current(),
  append: (key: string, value: any) => metaTarget(als.getStore()).append(key, value),
  increment: (key: string, by?: number) =>
    metaTarget(als.getStore()).increment(key, by),
  flush: async () => {},
  get parent() {
    const run = als.getStore();
    return metaTarget(run?.parentId ? store.get(run.parentId) : undefined);
  },
  get root() {
    let run = als.getStore();
    while (run?.parentId && store.get(run.parentId)) run = store.get(run.parentId);
    return metaTarget(run);
  },
};

// lib/utils/generate-trigger-status.ts reaches metadata through this global
// so that client components importing it never bundle this module.
g.__pmTriggerMetadata = metadata;

const log =
  (fn: (...a: any[]) => void) =>
  (message: string, data?: Record<string, any>) =>
    fn(`[trigger-shim] ${message}`, data ? JSON.stringify(data) : "");

export const logger = {
  debug: log(console.debug),
  log: log(console.log),
  info: log(console.info),
  warn: log(console.warn),
  error: log(console.error),
  trace: async <T>(_name: string, fn: (span: any) => Promise<T>) => fn({}),
};

export class AbortTaskRunError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "AbortTaskRunError";
  }
}

export const queue = (opts: any) => opts;

export const retry = {
  // Trigger's retry.fetch retries network errors and 5xx/429 with backoff.
  fetch: async (url: any, init: any = {}): Promise<Response> => {
    const { retry: _policy, timeoutInMs, ...rest } = init ?? {};
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url, {
          ...rest,
          ...(timeoutInMs ? { signal: AbortSignal.timeout(timeoutInMs) } : {}),
        });
        if ((res.status >= 500 || res.status === 429) && attempt < 3) throw res;
        return res;
      } catch (error) {
        if (attempt >= 3 && error instanceof Error) throw error;
        if (attempt >= 3) return error as Response;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  },
  onThrow: async <T>(fn: (opts: { attempt: number }) => Promise<T>, opts: { maxAttempts?: number } = {}) => {
    const max = opts.maxAttempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn({ attempt });
      } catch (error) {
        if (attempt >= max) throw error;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  },
};

export const wait = {
  for: async (d: { seconds?: number; minutes?: number; hours?: number }) =>
    new Promise((r) =>
      setTimeout(
        r,
        ((d.seconds ?? 0) + (d.minutes ?? 0) * 60 + (d.hours ?? 0) * 3600) * 1000,
      ),
    ),
  until: async (d: { date: Date }) =>
    new Promise((r) => setTimeout(r, Math.max(0, d.date.getTime() - Date.now()))),
};

export const auth = {
  // The browser polls /api/trigger-shim/runs instead of Trigger's realtime
  // API, so the "token" is just a marker the shim hooks ignore.
  createPublicToken: async (_opts?: any) => "shim",
  configure: (_opts?: any) => {},
};

export const configure = (_opts?: any) => {};
export const defineConfig = (config: any) => config;
export const timeout = { None: 0 };
export const idempotencyKeys = { create: async (key: string | string[]) => String(key) };
