/**
 * Report HTTP routes.
 *
 *   POST   /api/reports                      Generate a report
 *   GET    /api/reports                      List reports (filter by sessionId, template)
 *   GET    /api/reports/:id                  Get report metadata
 *   GET    /api/reports/:id/manifest         Get full manifest JSON
 *   GET    /api/reports/:id/download/:format Download a rendered file
 *   DELETE /api/reports/:id                  Delete a report (+ files)
 *   GET    /api/reports/templates            List available templates
 *
 * All routes are protected by the existing auth middleware mounted globally
 * in src/server.ts. Path traversal is impossible because report IDs are
 * UUIDv4 and validated in storage.getReportDirectory().
 */

import { FastifyInstance } from "fastify";
import * as fs from "fs";
import { z } from "zod";
import { buildAndPersist, listTemplates } from "../reports/report-builder";
import {
  deleteReport,
  getReport,
  getReportFilePath,
  getReportManifest,
  listReports,
} from "../reports/storage";
import type { ReportFormat } from "../reports/types";

const generateSchema = z.object({
  sessionId: z.string().min(1),
  template: z.enum(["incident-response", "generic"]).default("incident-response"),
  formats: z.array(z.enum(["markdown", "docx", "pdf", "html"])).min(1).default(["markdown", "docx"]),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  customer: z.string().optional(),
  author: z.string().optional(),
  localTimezone: z.string().optional(),
});

const listQuerySchema = z.object({
  sessionId: z.string().optional(),
  template: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const formatMimeMap: Record<ReportFormat, string> = {
  markdown: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  html: "text/html",
};

const formatFilenameMap: Record<ReportFormat, string> = {
  markdown: "report.md",
  docx: "report.docx",
  pdf: "report.pdf",
  html: "report.html",
};

export async function reportRoutes(fastify: FastifyInstance) {
  fastify.post("/", async (request, reply) => {
    const parsed = generateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid request", details: parsed.error.flatten() };
    }
    const opts = parsed.data;
    try {
      const result = await buildAndPersist(opts);
      return {
        reportId: result.reportId,
        directory: result.directory,
        metadata: result.metadata,
        files: result.files.map((f) => ({
          format: f.format,
          bytes: f.bytes,
          mime: f.mime,
          downloadUrl: `/api/reports/${result.reportId}/download/${f.format}`,
        })),
        warnings: result.warnings,
      };
    } catch (err) {
      reply.code(500);
      return { error: "Report generation failed", message: err instanceof Error ? err.message : String(err) };
    }
  });

  fastify.get("/", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query", details: parsed.error.flatten() };
    }
    const rows = listReports(parsed.data);
    return { reports: rows };
  });

  fastify.get("/templates", async () => {
    return { templates: listTemplates() };
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const r = getReport(request.params.id);
    if (!r) { reply.code(404); return { error: "Report not found" }; }
    return r;
  });

  fastify.get<{ Params: { id: string } }>("/:id/manifest", async (request, reply) => {
    const m = getReportManifest(request.params.id);
    if (!m) { reply.code(404); return { error: "Manifest not found" }; }
    return m;
  });

  fastify.get<{ Params: { id: string; format: ReportFormat } }>(
    "/:id/download/:format",
    async (request, reply) => {
      const { id, format } = request.params;
      const allowed: ReportFormat[] = ["markdown", "docx", "pdf", "html"];
      if (!allowed.includes(format)) {
        reply.code(400);
        return { error: "Invalid format", allowed };
      }
      const r = getReport(id);
      if (!r) { reply.code(404); return { error: "Report not found" }; }
      const filePath = getReportFilePath(id, format);
      if (!filePath) {
        reply.code(404);
        return { error: `Report has no ${format} render. Available formats: ${r.formats.join(", ")}` };
      }
      const stream = fs.createReadStream(filePath);
      reply
        .header("Content-Type", formatMimeMap[format])
        .header("Content-Disposition", `attachment; filename="${slugFilename(r.title)}-${formatFilenameMap[format]}"`);
      return reply.send(stream);
    },
  );

  fastify.delete<{ Params: { id: string }; Querystring: { confirm?: string } }>("/:id", async (request, reply) => {
    if (request.query.confirm !== "true") {
      reply.code(400);
      return { error: "Pass ?confirm=true to delete a report." };
    }
    const ok = deleteReport(request.params.id);
    if (!ok) { reply.code(404); return { error: "Report not found" }; }
    return { deleted: true, reportId: request.params.id };
  });
}

function slugFilename(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report";
}
