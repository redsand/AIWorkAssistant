export type WorkflowPhase =
  | "research"
  | "document"
  | "implement"
  | "review"
  | "approve"
  | "complete";

export interface WorkflowStep {
  phase: WorkflowPhase;
  description: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
  result?: string;
}

export interface Workflow {
  id: string;
  title: string;
  roadmapItemId?: string;
  jiraKey?: string;
  steps: WorkflowStep[];
  currentPhase: WorkflowPhase;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

const PHASE_ORDER: WorkflowPhase[] = [
  "research",
  "document",
  "implement",
  "review",
  "approve",
  "complete",
];

class WorkflowExecutor {
  private workflows: Map<string, Workflow> = new Map();

  createWorkflow(
    title: string,
    options?: {
      roadmapItemId?: string;
      jiraKey?: string;
      skipPhases?: WorkflowPhase[];
    },
  ): Workflow {
    const id = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const skipPhases = new Set(options?.skipPhases || []);

    const steps: WorkflowStep[] = PHASE_ORDER.map((phase) => ({
      phase,
      description: this.getPhaseDescription(phase),
      status: skipPhases.has(phase) ? "skipped" : "pending",
    }));

    const workflow: Workflow = {
      id,
      title,
      roadmapItemId: options?.roadmapItemId,
      jiraKey: options?.jiraKey,
      steps,
      currentPhase: this.getFirstActivePhase(steps),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.workflows.set(id, workflow);
    return workflow;
  }

  getWorkflow(workflowId: string): Workflow | undefined {
    return this.workflows.get(workflowId);
  }

  listWorkflows(): Workflow[] {
    return Array.from(this.workflows.values());
  }

  advancePhase(workflowId: string, result?: string): Workflow | null {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    const currentStep = workflow.steps.find(
      (s) => s.phase === workflow.currentPhase,
    );
    if (!currentStep || currentStep.status === "completed") return null;

    currentStep.status = "completed";
    currentStep.result = result;

    const nextPhase = this.getNextPhase(workflow);
    if (nextPhase) {
      workflow.currentPhase = nextPhase;
      const nextStep = workflow.steps.find((s) => s.phase === nextPhase);
      if (nextStep) nextStep.status = "in_progress";
    } else {
      workflow.completedAt = new Date();
    }

    workflow.updatedAt = new Date();
    return workflow;
  }

  updatePhaseResult(
    workflowId: string,
    phase: WorkflowPhase,
    result: string,
  ): Workflow | null {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    const step = workflow.steps.find((s) => s.phase === phase);
    if (!step) return null;

    step.result = result;
    workflow.updatedAt = new Date();
    return workflow;
  }

  getPhasePrompt(phase: WorkflowPhase, context: string): string {
    const prompts: Record<WorkflowPhase, string> = {
      research: `You are a research agent. Research the following task thoroughly. Use web search and local file tools to gather all relevant information. Store important findings in the knowledge base using knowledge.store. Return a comprehensive research summary.\n\nTask: ${context}`,
      document: `You are a documentation agent. Based on the research findings, create comprehensive documentation. Include: problem statement, architecture decisions, API contracts, data models, and implementation plan. Store the documentation in the knowledge base.\n\nTask: ${context}`,
      implement: `You are an implementation agent. Based on the documentation and plan, implement the required changes. Use codex.run or write code directly. Follow the implementation plan precisely. Run any available tests to verify your work.\n\nTask: ${context}`,
      review: `You are a code review agent. Review the implementation for: correctness, security, performance, code quality, test coverage. List any issues found and suggest fixes. Be thorough but constructive.\n\nTask: ${context}`,
      approve: `The implementation has been reviewed. Summarize what was done, the review findings, and any remaining issues. Present this for final approval. If there are critical issues, recommend going back to the implement phase.\n\nTask: ${context}`,
      complete: `The workflow is complete. Summarize everything that was accomplished. If a Jira ticket was provided, suggest updating it. If a roadmap item was provided, suggest marking it complete. Store a final summary in the knowledge base.\n\nTask: ${context}`,
    };
    return prompts[phase];
  }

  getWorkflowContext(workflowId: string): string {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return "";

    const parts: string[] = [`Workflow: ${workflow.title}`];
    if (workflow.jiraKey) parts.push(`Jira: ${workflow.jiraKey}`);
    if (workflow.roadmapItemId)
      parts.push(`Roadmap Item: ${workflow.roadmapItemId}`);

    for (const step of workflow.steps) {
      if (step.status === "completed" && step.result) {
        parts.push(
          `\n[${step.phase.toUpperCase()} COMPLETED]\n${step.result.substring(0, 1000)}`,
        );
      }
    }

    return parts.join("\n");
  }

  deleteWorkflow(workflowId: string): boolean {
    return this.workflows.delete(workflowId);
  }

  private getPhaseDescription(phase: WorkflowPhase): string {
    const descriptions: Record<WorkflowPhase, string> = {
      research: "Research the task using web search and local files",
      document: "Create documentation and architecture plan",
      implement: "Implement the required changes",
      review: "Review implementation for quality and correctness",
      approve: "Present for final approval",
      complete: "Close out and update tracking systems",
    };
    return descriptions[phase];
  }

  private getFirstActivePhase(steps: WorkflowStep[]): WorkflowPhase {
    for (const step of steps) {
      if (step.status === "pending") return step.phase;
    }
    return "complete";
  }

  private getNextPhase(workflow: Workflow): WorkflowPhase | null {
    const currentIdx = PHASE_ORDER.indexOf(workflow.currentPhase);
    for (let i = currentIdx + 1; i < PHASE_ORDER.length; i++) {
      const step = workflow.steps.find((s) => s.phase === PHASE_ORDER[i]);
      if (step && step.status !== "skipped") return PHASE_ORDER[i];
    }
    return null;
  }
}

export const workflowExecutor = new WorkflowExecutor();
