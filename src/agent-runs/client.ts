import axios from "axios";
import type { AgentRun, AgentRunStep, AgentRunCreateParams, AgentRunCompleteParams, AgentRunStepCreate } from "./types";

/**
 * HTTP client for the agent-runs API.
 * Used by aicoder and reviewer to report runs to the AIWorkAssistant server
 * instead of writing directly to the database.
 */

const DEFAULT_TIMEOUT = 5000;

function describeClientError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data;
    const body = data == null
      ? ""
      : typeof data === "string"
        ? data
        : JSON.stringify(data);
    const parts = [
      err.message || err.code || "Axios error",
      status ? `status=${status}` : "",
      body ? `body=${body.slice(0, 500)}` : "",
    ].filter(Boolean);
    return parts.join(" ");
  }
  return err instanceof Error ? err.message || err.name : String(err);
}

export class AgentRunsClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  private get headers() {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  async startRun(params: AgentRunCreateParams): Promise<AgentRun | null> {
    try {
      const resp = await axios.post(`${this.baseUrl}/api/agent-runs`, params, {
        headers: this.headers,
        timeout: DEFAULT_TIMEOUT,
      });
      return resp.data;
    } catch (err) {
      console.error(`[AgentRunsClient] startRun failed: ${describeClientError(err)}`);
      return null;
    }
  }

  async completeRun(id: string, data: AgentRunCompleteParams): Promise<boolean> {
    try {
      await axios.post(`${this.baseUrl}/api/agent-runs/${id}/complete`, data, {
        headers: this.headers,
        timeout: DEFAULT_TIMEOUT,
      });
      return true;
    } catch (err) {
      console.error(`[AgentRunsClient] completeRun failed: ${describeClientError(err)}`);
      return false;
    }
  }

  async failRun(id: string, errorMessage: string): Promise<boolean> {
    try {
      await axios.post(`${this.baseUrl}/api/agent-runs/${id}/fail`, { errorMessage }, {
        headers: this.headers,
        timeout: DEFAULT_TIMEOUT,
      });
      return true;
    } catch (err) {
      console.error(`[AgentRunsClient] failRun failed: ${describeClientError(err)}`);
      return false;
    }
  }

  async addStep(step: AgentRunStepCreate): Promise<AgentRunStep | null> {
    try {
      const resp = await axios.post(`${this.baseUrl}/api/agent-runs/${step.runId}/steps`, step, {
        headers: this.headers,
        timeout: DEFAULT_TIMEOUT,
      });
      return resp.data;
    } catch (err) {
      console.error(`[AgentRunsClient] addStep failed: ${describeClientError(err)}`);
      return null;
    }
  }

  async touchRun(id: string): Promise<boolean> {
    try {
      await axios.post(`${this.baseUrl}/api/agent-runs/${id}/touch`, {}, {
        headers: this.headers,
        timeout: DEFAULT_TIMEOUT,
      });
      return true;
    } catch (err) {
      console.error(`[AgentRunsClient] touchRun failed: ${describeClientError(err)}`);
      return false;
    }
  }

  async markStaleRunsAsFailed(olderThanMinutes?: number): Promise<number> {
    try {
      const resp = await axios.post(`${this.baseUrl}/api/agent-runs/stale`, { olderThanMinutes }, {
        headers: this.headers,
        timeout: DEFAULT_TIMEOUT,
      });
      return resp.data?.markedFailed ?? 0;
    } catch (err) {
      console.error(`[AgentRunsClient] markStaleRunsAsFailed failed: ${describeClientError(err)}`);
      return 0;
    }
  }
}

/**
 * Create an AgentRunsClient from environment variables.
 * Returns null if AIWORKASSISTANT_URL or AIWORKASSISTANT_API_KEY is not set.
 */
export function createAgentRunsClient(): AgentRunsClient | null {
  const url = process.env.AIWORKASSISTANT_URL?.replace(/\/$/, "");
  const key = process.env.AIWORKASSISTANT_API_KEY;
  if (!url || !key) return null;
  return new AgentRunsClient(url, key);
}
