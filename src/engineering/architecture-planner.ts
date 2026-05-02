import { WorkflowBrief } from "./workflow-brief";
import { aiClient } from "../agent/opencode-client";

export interface ArchitectureProposal {
  recommendedStack: {
    backend?: string;
    frontend?: string;
    database?: string;
    queue?: string;
    cache?: string;
  };
  systemBoundaries: string[];
  dataModel: string;
  apiDesign: string;
  eventModel: string;
  backgroundJobs: string[];
  integrations: string[];
  authStrategy: string;
  errorHandling: string;
  observability: string;
  deploymentModel: string;
  security: string;
  privacy: string;
  testingStrategy: string;
}

class ArchitecturePlanner {
  async generate(workflowBrief: WorkflowBrief): Promise<ArchitectureProposal> {
    if (!aiClient.isConfigured()) {
      return this.fallback();
    }

    try {
      const response = await aiClient.chat({
        messages: [
          {
            role: "system",
            content:
              "You are a principal systems architect with deep expertise in distributed systems, API design, and production reliability. Given a workflow brief, produce a detailed architecture proposal as a JSON object.\n\nBe OPINIONATED and SPECIFIC. Recommend concrete technologies with versions. Justify every choice. Do not be generic.\n\nRequired JSON fields:\n- recommendedStack ({backend, frontend, database, queue, cache}): Each field must include the specific technology, version, and WHY it was chosen over alternatives. Consider the project's specific needs.\n- systemBoundaries (string[]): Draw clear boundaries between services/modules. For each boundary: name, responsibility, what it exposes, what it depends on, and why the boundary exists (independent scaling, team ownership, failure isolation, etc.).\n- dataModel (string): Describe the COMPLETE data model. Include all entities, their relationships (1:1, 1:N, N:M), key fields, indexes, and constraints. Think about query patterns and access paths.\n- apiDesign (string): Define the API contract. Include key endpoints with HTTP methods, paths, request/response schemas, status codes, pagination, filtering, sorting, rate limiting, and versioning strategy.\n- eventModel (string): Define the event/message architecture. Include event types, producers, consumers, schemas, ordering guarantees, idempotency keys, and dead letter handling.\n- backgroundJobs (string[]): List every background job. For each: trigger, processing logic, concurrency requirements, retry strategy, monitoring, and failure handling.\n- integrations (string[]): List every external integration. For each: service, protocol, auth method, data flow direction, SLA requirements, circuit breaker config, and fallback strategy.\n- authStrategy (string): Specific auth architecture. Include identity providers, token format, scopes, RBAC model, API key management, session handling, and audit logging.\n- errorHandling (string): Comprehensive error strategy. Include error categories, propagation patterns, user-facing messages, logging levels, alerting thresholds, and runbook links.\n- observability (string): Specific observability stack. Include metrics (names, types, labels), logging (structured format, correlation IDs), tracing (sampling strategy, span attributes), dashboards, and alert rules.\n- deploymentModel (string): Specific deployment architecture. Include container strategy, orchestration, CI/CD pipeline, blue-green/canary strategy, rollback automation, and infrastructure-as-code approach.\n- security (string): Specific security measures. Include input validation rules, output encoding, CSRF/XSS/SQLi prevention, dependency scanning, secret management, and penetration testing strategy.\n- privacy (string): Data privacy measures. Include PII handling, data retention policies, right-to-deletion implementation, consent management, and compliance considerations (GDPR, CCPA, etc.).\n- testingStrategy (string): Specific testing approach. Include unit test framework and coverage targets, integration test strategy, E2E test scenarios, load testing parameters, chaos engineering plan, and test data management.\n\nRespond with ONLY the JSON object, no markdown fences.",
          },
          {
            role: "user",
            content: `Generate an architecture proposal for this workflow brief:\n\n${JSON.stringify(workflowBrief, null, 2)}`,
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
        recommendedStack: parsed.recommendedStack || {},
        systemBoundaries: parsed.systemBoundaries || [],
        dataModel: parsed.dataModel || "",
        apiDesign: parsed.apiDesign || "",
        eventModel: parsed.eventModel || "",
        backgroundJobs: parsed.backgroundJobs || [],
        integrations: parsed.integrations || [],
        authStrategy: parsed.authStrategy || "",
        errorHandling: parsed.errorHandling || "",
        observability: parsed.observability || "",
        deploymentModel: parsed.deploymentModel || "",
        security: parsed.security || "",
        privacy: parsed.privacy || "",
        testingStrategy: parsed.testingStrategy || "",
      };
    } catch (error) {
      console.error(
        "[Architecture Planner] AI generation failed, using fallback:",
        error,
      );
      return this.fallback();
    }
  }

  private fallback(): ArchitectureProposal {
    return {
      recommendedStack: {
        backend: "TypeScript + Fastify",
        frontend: "React + TypeScript",
        database: "PostgreSQL",
        queue: "Redis + Bull",
        cache: "Redis",
      },
      systemBoundaries: ["API Gateway", "Core Service", "Worker Service"],
      dataModel: "To be designed based on workflow brief",
      apiDesign: "REST API with JSON",
      eventModel: "Event-driven architecture",
      backgroundJobs: ["Job processing", "Notifications", "Cleanup"],
      integrations: ["To be determined"],
      authStrategy: "OAuth 2.0 + JWT",
      errorHandling: "Global error handler + retry logic",
      observability: "Logging + metrics + tracing",
      deploymentModel: "Docker containers",
      security: "Input validation + RBAC + encryption",
      privacy: "Data minimization + compliance",
      testingStrategy: "Unit + integration + E2E tests",
    };
  }
}

export const architecturePlanner = new ArchitecturePlanner();
