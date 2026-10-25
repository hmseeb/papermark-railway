// Browser-side stand-in for @trigger.dev/sdk. Client components import
// helpers (lib/utils/generate-trigger-status.ts) from modules that also
// import the SDK, so the browser bundle needs these names to exist; tasks
// only ever run server-side (./sdk.ts).
const serverOnly = () => {
  throw new Error("Trigger tasks run on the server only");
};
const taskStub = (def: { id: string }): any => ({
  id: def.id,
  trigger: serverOnly,
  triggerAndWait: serverOnly,
  batchTrigger: serverOnly,
  batchTriggerAndWait: serverOnly,
});
const noop = () => {};
const meta: any = { set: () => meta, get: noop, current: noop, append: () => meta, increment: () => meta, flush: async () => {} };

export const task = taskStub;
export const schemaTask = taskStub;
export const schedules = { task: taskStub };
export const tasks = { trigger: serverOnly, triggerAndWait: serverOnly, batchTrigger: serverOnly };
export const runs = { list: serverOnly, retrieve: serverOnly, cancel: serverOnly };
export const metadata: any = { ...meta, parent: meta, root: meta };
export const logger = { debug: noop, log: noop, info: noop, warn: noop, error: noop, trace: async (_n: string, fn: any) => fn({}) };
export class AbortTaskRunError extends Error {}
export const queue = (opts: any) => opts;
export const retry = { fetch: serverOnly, onThrow: serverOnly };
export const wait = { for: serverOnly, until: serverOnly };
export const auth = { createPublicToken: serverOnly, configure: noop };
export const configure = noop;
export const defineConfig = (config: any) => config;
export const timeout = { None: 0 };
export const idempotencyKeys = { create: async (key: string | string[]) => String(key) };
