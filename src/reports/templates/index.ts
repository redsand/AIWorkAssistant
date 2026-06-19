/**
 * Template registry. Add new templates by importing them here and registering
 * their builder. Each builder returns a ReportManifest from session-id input.
 */

import { buildGenericManifest, type GenericTemplateInput } from "./generic";
import { buildIncidentManifest, type IncidentTemplateInput } from "./incident-response";
import type { ReportManifest } from "../types";

export type TemplateId = "incident-response" | "generic";

export interface TemplateBuildInput {
  sessionId: string;
  title?: string;
  subtitle?: string;
  customer?: string;
  author?: string;
  localTimezone?: string;
}

export function buildManifest(template: TemplateId, input: TemplateBuildInput): ReportManifest {
  switch (template) {
    case "incident-response":
      return buildIncidentManifest(input as IncidentTemplateInput);
    case "generic":
      return buildGenericManifest(input as GenericTemplateInput);
    default: {
      // Exhaustiveness guard — TypeScript flags unhandled cases at compile time.
      const _exhaustive: never = template;
      throw new Error(`Unknown template: ${_exhaustive}`);
    }
  }
}

export const KNOWN_TEMPLATES: TemplateId[] = ["incident-response", "generic"];
