"use client";

// Stand-in for @trigger.dev/react-hooks, aliased in next.config.mjs. Runs
// execute in the web process (see ./sdk.ts), so the browser polls
// /api/trigger-shim/runs instead of Trigger.dev's realtime stream.
import useSWR from "swr";

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Failed to load run status (${r.status})`);
    return r.json();
  });

export function useRealtimeRunsWithTag(
  tag: string | string[],
  options: { enabled?: boolean; accessToken?: string } = {},
): { runs: any[]; error: Error | undefined } {
  const tags = ([] as string[]).concat(tag);
  const { data, error } = useSWR(
    options.enabled === false || tags.length === 0
      ? null
      : `/api/trigger-shim/runs?${tags.map((t) => `tag=${encodeURIComponent(t)}`).join("&")}`,
    fetcher,
    { refreshInterval: 2000 },
  );
  return { runs: data?.runs ?? [], error };
}

export function useRealtimeRun(
  runId: string | undefined,
  options: { enabled?: boolean; accessToken?: string } = {},
): { run: any; error: Error | undefined } {
  const { data, error } = useSWR(
    options.enabled === false || !runId
      ? null
      : `/api/trigger-shim/runs?id=${encodeURIComponent(runId)}`,
    fetcher,
    {
      refreshInterval: (latest: any) =>
        latest?.runs?.[0]?.finishedAt ? 0 : 2000,
    },
  );
  return { run: data?.runs?.[0], error };
}
