import { aiClient } from "../agent/opencode-client";

export interface WorkflowBrief {
  problem: string;
  users: string[];
  jobsToBeDone: string[];
  currentWorkflow: string;
  desiredWorkflow: string;
  frictionPoints: string[];
  decisions: string[];
  inputs: string[];
  outputs: string[];
  states: string[];
  transitions: string[];
  edgeCases: string[];
  humanInTheLoop: string[];
  automationOpportunities: string[];
  guardrails: string[];
}

class WorkflowBriefGenerator {
  async generate(idea: string): Promise<WorkflowBrief> {
    if (!aiClient.isConfigured()) {
      return this.fallback(idea);
    }

    try {
      const response = await aiClient.chat({
        messages: [
          {
            role: "system",
            content:
              "You are an engineering strategist. Given a project idea, produce a detailed workflow brief as a JSON object with these exact fields: problem (string), users (string[]), jobsToBeDone (string[]), currentWorkflow (string), desiredWorkflow (string), frictionPoints (string[]), decisions (string[]), inputs (string[]), outputs (string[]), states (string[]), transitions (string[]), edgeCases (string[]), humanInTheLoop (string[]), automationOpportunities (string[]), guardrails (string[]). Respond with ONLY the JSON object, no markdown fences.",
          },
          {
            role: "user",
            content: `Generate a comprehensive workflow brief for this project idea:\n\n${idea}`,
          },
        ],
        temperature: 0.7,
      });

      const content = response.content.trim();
      const jsonStr = content
        .replace(/^```json?\n?/, "")
        .replace(/\n?```$/, "");
      const parsed = JSON.parse(jsonStr);

      return {
        problem: parsed.problem || idea,
        users: parsed.users || [],
        jobsToBeDone: parsed.jobsToBeDone || [],
        currentWorkflow: parsed.currentWorkflow || "",
        desiredWorkflow: parsed.desiredWorkflow || "",
        frictionPoints: parsed.frictionPoints || [],
        decisions: parsed.decisions || [],
        inputs: parsed.inputs || [],
        outputs: parsed.outputs || [],
        states: parsed.states || [],
        transitions: parsed.transitions || [],
        edgeCases: parsed.edgeCases || [],
        humanInTheLoop: parsed.humanInTheLoop || [],
        automationOpportunities: parsed.automationOpportunities || [],
        guardrails: parsed.guardrails || [],
      };
    } catch (error) {
      console.error(
        "[Workflow Brief] AI generation failed, using fallback:",
        error,
      );
      return this.fallback(idea);
    }
  }

  private fallback(idea: string): WorkflowBrief {
    return {
      problem: `Problem: ${idea}`,
      users: ["End user", "Administrator"],
      jobsToBeDone: ["Core workflow to be determined", "Secondary workflow"],
      currentWorkflow: "Manual or non-existent",
      desiredWorkflow: "Automated with appropriate guardrails",
      frictionPoints: ["To be identified during implementation"],
      decisions: ["Key decisions to be mapped"],
      inputs: ["User input", "System data"],
      outputs: ["Processed results", "Status updates"],
      states: ["Initial", "In Progress", "Complete"],
      transitions: ["Start", "Advance", "Complete"],
      edgeCases: ["Error handling", "Timeout scenarios"],
      humanInTheLoop: ["Approval steps", "Review checkpoints"],
      automationOpportunities: ["To be identified"],
      guardrails: ["Input validation", "Error handling"],
    };
  }
}

export const workflowBriefGenerator = new WorkflowBriefGenerator();
