import type { CronJob } from "./cron-engine";
import { aiClient } from "../agent/opencode-client";
import { agentMemory } from "../memory/agent-memory";
import { errorLog } from "../observability/error-log";

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;

export interface JobResult {
  success: boolean;
  output: string;
  silent: boolean;
}

export interface JobRunnerDependencies {
  runJobFn: (job: CronJob, chainedContext?: string) => Promise<JobResult>;
}

const INJECTION_PATTERNS = [
  /\bignore\s+(all\s+)?previous\s+(instructions|context|directions)/gi,
  /\bforget\s+(all\s+)?previous\b/gi,
  /\byou\s+are\s+now\b/gi,
  /\bsystem\s*:\s*/gi,
  /\[INST\]/gi,
  /\<\|im_start\|\>/gi,
];

export function sanitizePrompt(prompt: string): string {
  let sanitized = prompt;
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[filtered]");
  }
  return sanitized;
}

function buildSystemMessage(job: CronJob, chainedContext?: string): string {
  const parts: string[] = [
    "You are a scheduled automation agent executing a recurring task.",
    "Complete the task and return the result.",
    "If the result is routine or unremarkable, start your response with [SILENT] to suppress the delivery notification.",
  ];

  const memorySnapshot = agentMemory.getMemorySnapshot();
  if (memorySnapshot) {
    parts.push(`\n--- MEMORY CONTEXT ---\n${memorySnapshot}`);
  }

  const userSnapshot = agentMemory.getUserSnapshot();
  if (userSnapshot) {
    parts.push(`\n--- USER CONTEXT ---\n${userSnapshot}`);
  }

  if (chainedContext) {
    parts.push(`\n--- CONTEXT FROM PREVIOUS JOB ---\n${chainedContext}`);
  }

  parts.push(`\n--- TASK ---\n${job.prompt}`);

  return parts.join("\n");
}

export async function runJob(job: CronJob, chainedContext?: string): Promise<JobResult> {
  if (!aiClient.isConfigured()) {
    const msg = "AI provider not configured — cannot run cron job";
    console.error(`[CronEngine] ${msg}`);
    return { success: false, output: msg, silent: false };
  }

  const systemMessage = buildSystemMessage(job, chainedContext);

  console.log(`[CronEngine] Running job ${job.id} ("${job.name}")`);

  const startTime = Date.now();
  let lastActivity = startTime;
  let timedOut = false;
  let inactivityTimer: ReturnType<typeof setInterval> | null = null;

  const timeoutPromise = new Promise<null>((resolve) => {
    inactivityTimer = setInterval(() => {
      if (Date.now() - lastActivity > INACTIVITY_TIMEOUT_MS) {
        timedOut = true;
        if (inactivityTimer) clearInterval(inactivityTimer);
        resolve(null);
      }
    }, POLL_INTERVAL_MS);
  });

  try {
    const responsePromise = aiClient.chat({
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: sanitizePrompt(job.prompt) },
      ],
      temperature: 0.7,
    });

    const response = await Promise.race([responsePromise, timeoutPromise]);

    if (inactivityTimer) clearInterval(inactivityTimer);

    if (timedOut || !response) {
      const msg = `Job ${job.id} timed out after ${INACTIVITY_TIMEOUT_MS / 1000}s of inactivity`;
      console.warn(`[CronEngine] ${msg}`);
      return { success: false, output: msg, silent: false };
    }

    lastActivity = Date.now();
    const content = response.content || "";
    const silent = content.includes("[SILENT]");

    console.log(`[CronEngine] Job ${job.id} completed (${(Date.now() - startTime) / 1000}s)${silent ? " [SILENT]" : ""}`);

    return { success: true, output: content, silent };
  } catch (error) {
    if (inactivityTimer) clearInterval(inactivityTimer);
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[CronEngine] Job ${job.id} error:`, msg);
    void errorLog.log({
      source: "cron-engine",
      category: "job_failed",
      message: `Cron job ${job.id} failed: ${msg}`,
      error: error instanceof Error ? error : new Error(msg),
    });
    return { success: false, output: msg, silent: false };
  }
}
