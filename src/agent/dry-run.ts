export interface DryRunChange {
  field: string;
  from?: string;
  to?: string;
  description: string;
}

export interface DryRunResult {
  wouldExecute: true;
  toolName: string;
  summary: string;
  targetSystem: string;
  changes: DryRunChange[];
  externalUrl?: string;
  riskLevel?: "low" | "medium" | "high" | "critical";
  paramsPreview: Record<string, unknown>;
  warnings: string[];
}

export function dryRunResult(params: {
  toolName: string;
  summary: string;
  targetSystem: string;
  changes: DryRunChange[];
  externalUrl?: string;
  riskLevel?: "low" | "medium" | "high" | "critical";
  paramsPreview: Record<string, unknown>;
  warnings?: string[];
}): DryRunResult {
  return {
    wouldExecute: true,
    ...params,
    warnings: params.warnings ?? [],
  };
}