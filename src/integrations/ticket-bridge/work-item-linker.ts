import { workItemDatabase } from "../../work-items/database";
import type { WorkItemSource, WorkItemHandoffMeta } from "../../work-items/types";
import type { TicketSource, TicketSourceType } from "./ticket-bridge";
import type { AgentType } from "./branch-runner";

export interface HandoffWorkItemOptions {
  source: TicketSource;
  ticketTitle: string;
  ticketUrl: string | null;
  branchName: string | null;
  agent: AgentType | null;
}

export interface HandoffCompleteOptions {
  workItemId: string;
  agentExitCode: number | null;
  filesChanged: string[];
  commitMessages: string[];
  runDurationMs: number | null;
}

export interface WorkItemLinkResult {
  workItemId: string;
  created: boolean;
}

function toWorkItemSource(type: TicketSourceType): WorkItemSource {
  switch (type) {
    case "github":
      return "github";
    case "jira":
      return "jira";
    case "roadmap":
      return "roadmap";
    case "gitlab":
      return "gitlab";
    case "jitbit":
      return "jitbit";
  }
}

function externalIdFromSource(source: TicketSource): string {
  switch (source.type) {
    case "github": {
      const match = source.id.match(/#(\d+)$/);
      return match ? match[1] : source.id;
    }
    case "jira":
      return source.id;
    case "roadmap":
      return source.id;
    case "gitlab": {
      const match = source.id.match(/#?(\d+)$/);
      return match ? match[1] : source.id;
    }
    case "jitbit":
      return source.id;
  }
}

class WorkItemLinker {
  createOrUpdateHandoff(options: HandoffWorkItemOptions): WorkItemLinkResult {
    const wiSource = toWorkItemSource(options.source.type);
    const externalId = externalIdFromSource(options.source);

    const handoffPayload: WorkItemHandoffMeta["handoff"] = {
      handoffStatus: "running",
      agent: options.agent,
      branch: options.branchName,
      startedAt: new Date().toISOString(),
    };

    const existing = workItemDatabase.findByTicketSource(wiSource, externalId);

    if (existing) {
      const existingMeta = existing.metadataJson
        ? (JSON.parse(existing.metadataJson) as Record<string, unknown>)
        : {};
      workItemDatabase.updateWorkItem(existing.id, {
        status: "active",
        metadata: { ...existingMeta, handoff: handoffPayload },
      });
      return { workItemId: existing.id, created: false };
    }

    const created = workItemDatabase.createWorkItem({
      type: "task",
      title: options.ticketTitle || `Agent handoff: ${options.source.id}`,
      description: options.branchName
        ? `Branch: \`${options.branchName}\``
        : "",
      status: "active",
      priority: "medium",
      source: wiSource,
      sourceUrl: options.ticketUrl ?? undefined,
      sourceExternalId: externalId,
      tags: ["agent-handoff"],
      metadata: { handoff: handoffPayload },
    });

    return { workItemId: created.id, created: true };
  }

  completeHandoff(options: HandoffCompleteOptions): void {
    const item = workItemDatabase.getWorkItem(options.workItemId);
    if (!item) return;

    const existingMeta = item.metadataJson
      ? (JSON.parse(item.metadataJson) as Record<string, unknown>)
      : {};

    const existingHandoff =
      (existingMeta.handoff as Partial<WorkItemHandoffMeta["handoff"]>) ?? {};

    const succeeded = options.agentExitCode === 0;
    const handoffStatus: WorkItemHandoffMeta["handoff"]["handoffStatus"] =
      options.agentExitCode === null
        ? "running"
        : succeeded
          ? "completed"
          : "failed";

    const updatedHandoff: WorkItemHandoffMeta["handoff"] = {
      handoffStatus,
      agent: existingHandoff.agent ?? null,
      branch: existingHandoff.branch ?? null,
      startedAt: existingHandoff.startedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: options.agentExitCode ?? undefined,
      filesChanged: options.filesChanged,
      commitMessages: options.commitMessages,
      runDurationMs: options.runDurationMs ?? undefined,
    };

    workItemDatabase.updateWorkItem(options.workItemId, {
      status: succeeded ? "active" : "waiting",
      metadata: { ...existingMeta, handoff: updatedHandoff },
    });
  }
}

export const workItemLinker = new WorkItemLinker();
