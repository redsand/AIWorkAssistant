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
              'You are a senior engineering strategist with 15+ years of experience building production systems. Given a project idea, produce a comprehensive workflow brief as a JSON object.\n\nYour analysis must be THOROUGH and SPECIFIC. Do not give generic answers. Every field should contain concrete, actionable insights specific to the project idea provided.\n\nRequired JSON fields with expectations:\n- problem (string): A precise problem statement. What exact pain point exists? Who experiences it? How often? What is the cost of the current situation?\n- users (string[]): List EVERY distinct user persona. For each, describe their role, technical skill level, and primary motivation. Be specific (e.g., "DevOps engineer managing 50+ microservices" not "developer").\n- jobsToBeDone (string[]): List at least 5-8 specific jobs-to-be-done using the format "When [situation], I want to [motivation], so I can [outcome]". Think through the ENTIRE lifecycle.\n- currentWorkflow (string): Describe the EXACT current process step-by-step. Include tools used, manual steps, handoffs, and time estimates. Be brutally honest about inefficiencies.\n- desiredWorkflow (string): Describe the ideal automated workflow step-by-step. Be specific about what the system does vs what the human does. Include error recovery paths.\n- frictionPoints (string[]): List at least 5-8 specific friction points. For each: what causes it, who is affected, what is the impact (time/cost/risk), and how the proposed system addresses it.\n- decisions (string[]): List EVERY decision point in the workflow. For each: what is being decided, who decides, what information do they need, what are the possible outcomes, and what happens if they choose wrong.\n- inputs (string[]): List all data inputs the system needs. For each: source, format, frequency, validation requirements, and what happens if it\'s missing/invalid.\n- outputs (string[]): List all system outputs. For each: consumer, format, delivery mechanism, freshness requirements, and SLA.\n- states (string[]): Define the COMPLETE state machine. List every possible state an entity can be in, with entry/exit conditions.\n- transitions (string[]): List every valid state transition. For each: trigger, preconditions, side effects, rollback plan, and who can initiate it.\n- edgeCases (string[]): Think of at least 5-8 edge cases that would break a naive implementation. For each: scenario, expected behavior, and mitigation strategy.\n- humanInTheLoop (string[]): List every point where a human MUST be involved. For each: why automation is insufficient, what judgment the human provides, and how the system presents the decision.\n- automationOpportunities (string[]): List at least 5 specific things that CAN and SHOULD be automated. For each: current manual cost, automation approach, confidence level, and fallback if automation fails.\n- guardrails (string[]): List at least 5 specific safety mechanisms. For each: what it prevents, how it works, what triggers it, and what the recovery path is.\n\nRespond with ONLY the JSON object, no markdown fences. Be SPECIFIC to the project idea, not generic.',
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
