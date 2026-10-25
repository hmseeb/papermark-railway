import type { NextApiRequest, NextApiResponse } from "next";

import { listRuns, runs } from "@/lib/trigger-shim/sdk";

// Progress feed for lib/trigger-shim/react-hooks.ts. Tags are the same
// unguessable ids (version:<cuid>, team_<cuid>) Trigger.dev scopes its public
// tokens to, and payloads and outputs are never returned, only status and
// the progress metadata the upload UI renders.
const view = (run: any) => ({
  id: run.id,
  taskIdentifier: run.taskIdentifier,
  status: run.status,
  tags: run.tags,
  metadata: run.metadata,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  finishedAt: run.finishedAt ?? null,
  error: run.error ?? null,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();
  res.setHeader("Cache-Control", "no-store");

  const id = typeof req.query.id === "string" ? req.query.id : undefined;
  if (id) {
    const run = await runs.retrieve(id).catch(() => undefined);
    return res.json({ runs: run ? [view(run)] : [] });
  }

  const tag = ([] as string[]).concat(req.query.tag ?? []).filter(Boolean);
  if (tag.length === 0) return res.status(400).json({ error: "tag or id required" });
  return res.json({ runs: listRuns({ tag }).map(view) });
}
