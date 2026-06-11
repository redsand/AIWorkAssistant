import { FastifyInstance } from "fastify";
import {
  calibrationDatabase,
  CalibrationDatabase,
  EVAL_SEGMENTS,
  type EvalSegment,
  type EvalSystem,
} from "./database";
import { runEvalCase, runAllUnrunCases } from "./runner";

/**
 * REST surface for the Phase 2 calibration eval set. Powers /eval in the
 * web UI: add cases, list cases, run cases (single or batch), and rate
 * runs. Kept deliberately thin — the database and runner do the work.
 *
 * Routes are mounted under /api/eval-calibration. No API key gate yet
 * because this is a local-dev tool, not a public surface. If exposing
 * remotely, gate `POST /run-all` first — it can be expensive.
 */

function isSegment(s: unknown): s is EvalSegment {
  return typeof s === "string" && (EVAL_SEGMENTS as readonly string[]).includes(s);
}

function isSystem(s: unknown): s is EvalSystem {
  return s === "rag" || s === "claimkit";
}

export interface EvalRoutesOptions {
  database?: CalibrationDatabase;
}

export async function evalCalibrationRoutes(
  fastify: FastifyInstance,
  options?: EvalRoutesOptions,
) {
  const db = options?.database ?? calibrationDatabase;

  // ── Cases ──────────────────────────────────────────────────────────

  fastify.get("/segments", async () => ({ segments: EVAL_SEGMENTS }));

  fastify.get("/cases", async (request) => {
    const q = request.query as { segment?: string };
    const filter = isSegment(q.segment) ? { segment: q.segment } : undefined;
    const cases = db.listCases(filter);
    // Hydrate with run + rating counts so the UI can show progress at a
    // glance without N+1 fetches.
    return {
      cases: cases.map((c) => {
        const runs = db.getRunsForCase(c.id);
        const ragRun = runs.find((r) => r.system === "rag") ?? null;
        const ckRun = runs.find((r) => r.system === "claimkit") ?? null;
        const ragRated = ragRun ? db.getRatingsForRun(ragRun.id).length > 0 : false;
        const ckRated = ckRun ? db.getRatingsForRun(ckRun.id).length > 0 : false;
        return {
          ...c,
          hasRagRun: ragRun != null,
          hasClaimkitRun: ckRun != null,
          ragRated,
          claimkitRated: ckRated,
        };
      }),
    };
  });

  fastify.post("/cases", async (request, reply) => {
    const body = request.body as {
      query?: string;
      segment?: string;
      expectedAnswer?: string | null;
      notes?: string | null;
    };
    if (!body.query?.trim()) {
      return reply.code(400).send({ error: "query is required" });
    }
    if (!isSegment(body.segment)) {
      return reply.code(400).send({ error: "segment is required and must be one of " + EVAL_SEGMENTS.join(", ") });
    }
    const created = db.addCase({
      query: body.query.trim(),
      segment: body.segment,
      expectedAnswer: body.expectedAnswer ?? null,
      notes: body.notes ?? null,
    });
    return reply.code(201).send(created);
  });

  fastify.delete<{ Params: { id: string } }>("/cases/:id", async (request, reply) => {
    const ok = db.deleteCase(request.params.id);
    if (!ok) return reply.code(404).send({ error: "case not found" });
    return reply.send({ ok: true });
  });

  fastify.get<{ Params: { id: string } }>("/cases/:id", async (request, reply) => {
    const c = db.getCase(request.params.id);
    if (!c) return reply.code(404).send({ error: "case not found" });
    const runs = db.getRunsForCase(c.id);
    const runsWithRatings = runs.map((r) => ({
      ...r,
      ratings: db.getRatingsForRun(r.id),
    }));
    return { case: c, runs: runsWithRatings };
  });

  // ── Runs ───────────────────────────────────────────────────────────

  fastify.post<{ Params: { id: string } }>("/cases/:id/run", async (request, reply) => {
    try {
      const r = await runEvalCase(request.params.id);
      return reply.send(r);
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.post("/run-all", async (_request, reply) => {
    try {
      const r = await runAllUnrunCases();
      return reply.send(r);
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Ratings ────────────────────────────────────────────────────────

  fastify.post<{ Params: { runId: string } }>(
    "/runs/:runId/ratings",
    async (request, reply) => {
      const body = request.body as {
        rating?: number;
        correct?: boolean;
        complete?: boolean;
        grounded?: boolean;
        notes?: string | null;
        rater?: string | null;
      };
      if (
        typeof body.rating !== "number" ||
        body.rating < 0 ||
        body.rating > 4 ||
        !Number.isInteger(body.rating)
      ) {
        return reply.code(400).send({ error: "rating must be an integer 0–4" });
      }
      const run = db.getRun(request.params.runId);
      if (!run) return reply.code(404).send({ error: "run not found" });
      const rating = db.addRating({
        runId: request.params.runId,
        rating: body.rating,
        correct: !!body.correct,
        complete: !!body.complete,
        grounded: !!body.grounded,
        notes: body.notes ?? null,
        rater: body.rater ?? null,
      });
      return reply.code(201).send(rating);
    },
  );

  // ── Calibration curve (Phase 3 input) ──────────────────────────────

  fastify.get("/calibration", async (request) => {
    const q = request.query as { system?: string };
    const pairs = db.getCalibrationPairs(isSystem(q.system) ? q.system : undefined);
    return { pairs };
  });

  // ── Phase 3 analysis surface ───────────────────────────────────────
  // One endpoint returns everything the /eval analysis tab needs so the
  // UI can render in a single fetch.

  fastify.get("/analysis", async (request) => {
    const q = request.query as { system?: string; bins?: string };
    const system = isSystem(q.system) ? q.system : "claimkit";
    const binCount = (() => {
      const n = parseInt(q.bins ?? "", 10);
      if (!Number.isFinite(n) || n < 2 || n > 20) return 10;
      return n;
    })();

    const pairs = db.getCalibrationPairs(system);
    const reliability = db.getReliabilityBins({ system, bins: binCount });
    const perSegment = db.getPerSegmentCalibration(system);
    const perPenalty = db.getPenaltyFiringOnRated();

    return {
      system,
      sampleSize: pairs.length,
      pairs, // raw (x=confidence, y=rating/4) — UI plots scatter
      reliability, // bin means + ECE + RMSE
      perSegment, // per-segment calibration
      perPenalty, // per-penalty firing freq + avg rating
    };
  });
}
