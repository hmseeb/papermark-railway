// Postgres stand-in for Tinybird, swapped in for @chronark/zod-bird by the
// import in ./publish.ts and ./pipes.ts. Same buildIngestEndpoint/buildPipe
// surface; every event lands as JSON in one table and each pipe below is a
// hand port of ./endpoints/<name>.pipe (ClickHouse SQL) to Postgres.
// Why not Tinybird Local: it is a ClickHouse server for a few thousand rows a
// month, and Papermark's endpoints are Classic-format files that the Forward
// CLI shipped with it no longer deploys.
import { z } from "zod";

import prisma from "@/lib/prisma";

let ready: Promise<void> | undefined;

function ensureTable() {
  ready ??= (async () => {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS tb_events (
         datasource text NOT NULL,
         ts timestamptz NOT NULL DEFAULT now(),
         data jsonb NOT NULL)`,
    );
    for (const [name, expr] of [
      ["doc", "datasource, (data->>'documentId')"],
      ["view", "datasource, (data->>'viewId')"],
      ["link", "datasource, (data->>'linkId')"],
      ["dataroom", "datasource, (data->>'dataroomId')"],
      ["snake_doc", "datasource, (data->>'document_id')"],
      ["snake_view", "datasource, (data->>'view_id')"],
      ["webhook", "datasource, (data->>'webhook_id')"],
    ]) {
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS tb_events_${name} ON tb_events (${expr})`,
      );
    }
  })().catch((error) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

const csv = (s: unknown) =>
  (Array.isArray(s) ? s : String(s ?? "").split(",")).map(String).filter(Boolean);
const MAX_TIME = 9999999999999;

// Shared fragments. page_views__v3 rows carry camelCase keys, the newer
// datasources snake_case, exactly as Papermark ingests them.
const PV = `FROM tb_events WHERE datasource = 'page_views__v3'`;
const time = `(data->>'time')::bigint`;
const dur = `(data->>'duration')::bigint`;
const sum = `COALESCE(SUM(${dur}), 0)::float8`;
const evTs = `(data->>'timestamp')`;

type Query = [sql: string, ...params: unknown[]];
type Port = (p: any) => Query;

const pipes: Record<string, Port> = {
  get_total_average_page_duration__v5: (p) => [
    `WITH d AS (
       SELECT (data->>'versionNumber')::int AS v, data->>'pageNumber' AS pg,
              data->>'viewId' AS vid, SUM(${dur}) AS dd
       ${PV} AND data->>'documentId' = $1 AND ${time} >= $2::bigint AND ${time} <= $3::bigint
         AND data->>'linkId' <> ALL($4::text[]) AND data->>'viewId' <> ALL($5::text[])
       GROUP BY 1, 2, 3)
     SELECT v AS "versionNumber", pg AS "pageNumber", AVG(dd)::float8 AS avg_duration
     FROM d GROUP BY v, pg ORDER BY v ASC, pg ASC`,
    p.documentId, p.since, p.until ?? MAX_TIME, csv(p.excludedLinkIds), csv(p.excludedViewIds),
  ],
  get_page_duration_per_view__v5: (p) => [
    `SELECT data->>'pageNumber' AS "pageNumber", ${sum} AS sum_duration
     ${PV} AND data->>'documentId' = $1 AND data->>'viewId' = $2
       AND ${time} >= $3::bigint AND ${time} <= $4::bigint
     GROUP BY 1 ORDER BY 1 ASC`,
    p.documentId, p.viewId, p.since, p.until ?? MAX_TIME,
  ],
  get_view_completion_stats__v1: (p) => [
    `SELECT data->>'viewId' AS "viewId", (data->>'versionNumber')::int AS "versionNumber",
            COUNT(DISTINCT data->>'pageNumber')::int AS pages_viewed
     ${PV} AND data->>'documentId' = $1 AND data->>'viewId' <> ALL($2::text[]) AND ${time} >= $3::bigint
     GROUP BY 1, 2`,
    p.documentId, csv(p.excludedViewIds), p.since,
  ],
  get_total_document_duration__v1: (p) => [
    `SELECT ${sum} AS sum_duration
     ${PV} AND data->>'documentId' = $1 AND ${time} >= $2::bigint AND ${time} <= $3::bigint
       AND data->>'linkId' <> ALL($4::text[]) AND data->>'viewId' <> ALL($5::text[])`,
    p.documentId, p.since, p.until ?? MAX_TIME, csv(p.excludedLinkIds), csv(p.excludedViewIds),
  ],
  get_total_link_duration__v1: (p) => [
    `SELECT ${sum} AS sum_duration, COUNT(DISTINCT data->>'viewId')::int AS view_count
     ${PV} AND data->>'linkId' = $1 AND data->>'documentId' = $2 AND ${time} >= $3::bigint
       AND ${time} <= $4::bigint AND data->>'viewId' <> ALL($5::text[])`,
    p.linkId, p.documentId, p.since, p.until ?? MAX_TIME, csv(p.excludedViewIds),
  ],
  get_total_viewer_duration__v1: (p) => [
    `SELECT ${sum} AS sum_duration
     ${PV} AND data->>'viewId' = ANY($1::text[]) AND ${time} >= $2::bigint AND ${time} <= $3::bigint`,
    csv(p.viewIds), p.since, p.until ?? MAX_TIME,
  ],
  get_total_dataroom_duration__v1: (p) => [
    `SELECT data->>'viewId' AS "viewId", ${sum} AS sum_duration
     ${PV} AND data->>'dataroomId' = $1 AND ${time} >= $2::bigint AND ${time} <= $3::bigint
       AND data->>'linkId' <> ALL($4::text[]) AND data->>'viewId' <> ALL($5::text[])
     GROUP BY 1`,
    p.dataroomId, p.since, p.until ?? MAX_TIME, csv(p.excludedLinkIds), csv(p.excludedViewIds),
  ],
  get_document_duration_per_viewer__v1: (p) => [
    `SELECT ${sum} AS sum_duration
     ${PV} AND data->>'documentId' = $1 AND data->>'viewId' = ANY($2::text[])`,
    p.documentId, csv(p.viewIds),
  ],
  get_dataroom_view_document_stats__v1: (p) => [
    `SELECT data->>'viewId' AS "viewId", data->>'documentId' AS "documentId",
            ${sum} AS sum_duration, COUNT(DISTINCT data->>'pageNumber')::int AS pages_viewed
     ${PV} AND data->>'viewId' = ANY($1::text[])
     GROUP BY 1, 2`,
    csv(p.viewIds),
  ],
  // v2 only exists in Papermark's live workspace, not in endpoints/; it is
  // v3 with an unused documentId/since filter, and the fields agree.
  get_useragent_per_view__v2: (p) => pipes.get_useragent_per_view__v3(p),
  get_useragent_per_view__v3: (p) => [
    `SELECT data->>'country' AS country, data->>'city' AS city, data->>'browser' AS browser,
            data->>'os' AS os, data->>'device' AS device
     FROM tb_events WHERE datasource = 'pm_click_events__v1' AND data->>'view_id' = $1
     LIMIT 1`,
    p.viewId,
  ],
  get_webhook_events__v1: (p) => [
    `SELECT data->>'event_id' AS event_id, data->>'webhook_id' AS webhook_id,
            data->>'message_id' AS message_id, data->>'event' AS event, data->>'url' AS url,
            (data->>'http_status')::int AS http_status, data->>'request_body' AS request_body,
            data->>'response_body' AS response_body,
            to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp
     FROM tb_events WHERE datasource = 'webhook_events__v1' AND data->>'webhook_id' = $1
     ORDER BY ts DESC LIMIT 100`,
    p.webhookId,
  ],
  get_video_events_by_document__v1: (p) => [
    `SELECT ${evTs} AS timestamp, data->>'view_id' AS view_id, data->>'event_type' AS event_type,
            COALESCE((data->>'start_time')::float8, 0) AS start_time,
            COALESCE((data->>'end_time')::float8, 0) AS end_time,
            COALESCE((data->>'playback_rate')::float8, 0) AS playback_rate,
            COALESCE((data->>'volume')::float8, 0) AS volume,
            COALESCE((data->>'is_muted')::float8, 0) AS is_muted,
            COALESCE((data->>'is_focused')::float8, 0) AS is_focused,
            COALESCE((data->>'is_fullscreen')::float8, 0) AS is_fullscreen
     FROM tb_events WHERE datasource = 'video_views__v1' AND data->>'document_id' = $1
     ORDER BY ${evTs}::timestamptz ASC`,
    p.document_id,
  ],
  get_video_events_by_view__v1: (p) => [
    `SELECT ${evTs} AS timestamp, data->>'event_type' AS event_type,
            COALESCE((data->>'start_time')::float8, 0) AS start_time,
            COALESCE((data->>'end_time')::float8, 0) AS end_time,
            COALESCE((data->>'playback_rate')::float8, 0) AS playback_rate,
            COALESCE((data->>'volume')::float8, 0) AS volume,
            COALESCE((data->>'is_muted')::float8, 0) AS is_muted,
            COALESCE((data->>'is_focused')::float8, 0) AS is_focused,
            COALESCE((data->>'is_fullscreen')::float8, 0) AS is_fullscreen
     FROM tb_events WHERE datasource = 'video_views__v1'
       AND data->>'document_id' = $1 AND data->>'view_id' = $2
     ORDER BY ${evTs}::timestamptz ASC`,
    p.document_id, p.view_id,
  ],
  get_click_events_by_view__v1: (p) => [
    `SELECT ${evTs} AS timestamp, data->>'document_id' AS document_id,
            data->>'dataroom_id' AS dataroom_id, data->>'view_id' AS view_id,
            data->>'page_number' AS page_number, (data->>'version_number')::int AS version_number,
            data->>'href' AS href
     FROM tb_events WHERE datasource = 'click_events__v1'
       AND data->>'document_id' = $1 AND data->>'view_id' = $2
     ORDER BY ${evTs}::timestamptz ASC`,
    p.document_id, p.view_id,
  ],
  get_total_team_duration__v1: (p) => [
    `SELECT
       (SELECT ${sum} ${PV} AND data->>'documentId' = ANY($1::text[])
          AND ${time} >= $2::bigint AND ${time} < $3::bigint) AS total_duration,
       (SELECT COALESCE(array_agg(DISTINCT data->>'country'), '{}')
          FROM tb_events WHERE datasource = 'pm_click_events__v1'
          AND data->>'document_id' = ANY($1::text[])
          AND (extract(epoch FROM ${evTs}::timestamptz) * 1000) >= $2::bigint
          AND (extract(epoch FROM ${evTs}::timestamptz) * 1000) < $3::bigint
          AND data->>'country' NOT IN ('Unknown', '')) AS unique_countries`,
    csv(p.documentIds), p.since ?? 0, p.until ?? MAX_TIME,
  ],
};

export class Tinybird {
  constructor(_opts?: { token?: string; baseUrl?: string }) {}

  buildIngestEndpoint<TSchema extends z.ZodTypeAny>(req: {
    datasource: string;
    event: TSchema;
  }) {
    return async (events: z.input<TSchema> | z.input<TSchema>[]) => {
      const rows = (Array.isArray(events) ? events : [events]).map((e) =>
        req.event.parse(e),
      );
      await ensureTable();
      for (const row of rows) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO tb_events (datasource, data) VALUES ($1, $2::jsonb)`,
          req.datasource,
          JSON.stringify(row),
        );
      }
      return { successful_rows: rows.length, quarantined_rows: 0 };
    };
  }

  buildPipe<TParams extends z.ZodTypeAny, TData extends z.ZodTypeAny>(req: {
    pipe: string;
    parameters?: TParams;
    data: TData;
  }) {
    const port = pipes[req.pipe];
    if (!port) throw new Error(`No Postgres port for Tinybird pipe ${req.pipe}`);
    return async (params: z.input<TParams>) => {
      const parsed = req.parameters ? req.parameters.parse(params) : params;
      await ensureTable();
      const [sql, ...args] = port(parsed);
      const rows = (await prisma.$queryRawUnsafe(sql, ...args)) as unknown[];
      const data = z.array(req.data).parse(rows) as z.output<TData>[];
      return { meta: [], data, rows: data.length, statistics: {} };
    };
  }
}
