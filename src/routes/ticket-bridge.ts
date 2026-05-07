import { FastifyInstance } from "fastify";
import {
  ticketBridge,
  type TicketSource,
  type PromptContext,
} from "../integrations/ticket-bridge/ticket-bridge";
import { branchRunner } from "../integrations/ticket-bridge/branch-runner";
import type { AgentType } from "../integrations/ticket-bridge/branch-runner";

const VALID_TYPES = ["github", "jira", "roadmap"] as const;
const VALID_AGENTS = ["codex", "opencode", "claude"] as const;

export async function ticketBridgeRoutes(fastify: FastifyInstance) {
  fastify.post("/prompt", async (request, _reply) => {
    const body = request.body as {
      source?: TicketSource;
      context?: Partial<PromptContext>;
    };

    if (!body.source?.type || !body.source?.id) {
      return { success: false, error: "source.type and source.id are required" };
    }

    if (!(VALID_TYPES as readonly string[]).includes(body.source.type)) {
      return {
        success: false,
        error: `source.type must be one of: ${VALID_TYPES.join(", ")}`,
      };
    }

    try {
      const generated = await ticketBridge.generatePrompt(
        body.source,
        body.context,
      );
      return { success: true, ...generated };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });



  fastify.post("/run", async (request, _reply) => {
    const body = request.body as {
      source?: TicketSource;
      context?: Partial<PromptContext>;
      autoBranch?: boolean;
      agent?: string;
      workspace?: string;
      dryRun?: boolean;
      postComment?: boolean;
      postResults?: boolean;
      createWorkItem?: boolean;
      sessionUrl?: string;
    };

    if (!body.source?.type || !body.source?.id) {
      return { success: false, error: "source.type and source.id are required" };
    }

    if (!(VALID_TYPES as readonly string[]).includes(body.source.type)) {
      return {
        success: false,
        error: `source.type must be one of: ${VALID_TYPES.join(", ")}`,
      };
    }

    if (body.agent && !(VALID_AGENTS as readonly string[]).includes(body.agent)) {
      return {
        success: false,
        error: `agent must be one of: ${VALID_AGENTS.join(", ")}`,
      };
    }

    try {
      const generated = await ticketBridge.generatePrompt(
        body.source,
        body.context,
      );

      if (generated.skipped) {
        return {
          success: true,
          skipped: true,
          skipReason: generated.skipReason,
          title: generated.title,
          prompt: "",
          filesReferenced: [],
          tokensEstimate: 0,
          branchName: null,
          branchCreated: false,
          agentStarted: false,
          agentExitCode: null,
          commentPosted: false,
        };
      }

      const result = await branchRunner.run({
        source: body.source,
        prompt: generated.prompt,
        title: generated.title,
        autoBranch: body.autoBranch ?? false,
        agent: (body.agent as AgentType | undefined) ?? null,
        workspace: body.workspace,
        dryRun: body.dryRun ?? false,
        postComment: body.postComment,
        postResults: body.postResults ?? false,
        createWorkItem: body.createWorkItem ?? false,
        sessionUrl: body.sessionUrl,
      });

      return {
        success: true,
        skipped: false,
        skipReason: null,
        prompt: generated.prompt,
        title: generated.title,
        filesReferenced: generated.filesReferenced,
        tokensEstimate: generated.tokensEstimate,
        hasCodingPrompt: generated.hasCodingPrompt,
        ...result,
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
}
