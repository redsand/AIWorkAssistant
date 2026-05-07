import * as fs from "fs";
import * as path from "path";

export class RunLogger {
  private logStream: fs.WriteStream | null = null;
  private startTime: Date = new Date();
  private logDir: string;

  constructor(workspace: string) {
    this.logDir = path.join(workspace, ".aicoder", "logs");
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  startRun(issueNumber: number, title: string): void {
    this.close();
    this.startTime = new Date();
    const ts = this.startTime.toISOString().replace(/[:.]/g, "-");
    const logFile = path.join(this.logDir, `run-${issueNumber}-${ts}.log`);
    this.logStream = fs.createWriteStream(logFile, { flags: "a" });
    this.write(`[AICODER] Run started at ${this.startTime.toISOString()}`);
    this.write(`[AICODER] Issue #${issueNumber}: ${title}`);
  }

  log(level: string, message: string): void {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${message}`;
    this.write(line);
    switch (level) {
      case "ERROR":
        console.error(`[${level}] ${message}`);
        break;
      case "WARN":
        console.warn(`[${level}] ${message}`);
        break;
      default:
        console.log(`[${level}] ${message}`);
    }
  }

  logConfig(message: string): void {
    this.log("CONFIG", message);
  }

  logWork(message: string): void {
    this.log("WORK", message);
  }

  logGit(action: string, detail?: string): void {
    this.log("GIT", detail ? `${action}: ${detail}` : action);
  }

  logAgent(message: string): void {
    this.log("AGENT", message);
  }

  logError(message: string): void {
    this.log("ERROR", message);
  }

  logPoll(message: string): void {
    this.log("POLL", message);
  }

  logSkip(message: string): void {
    this.log("SKIP", message);
  }

  logPR(message: string): void {
    this.log("PR", message);
  }

  endRun(exitCode: number | null): void {
    const duration = Date.now() - this.startTime.getTime();
    const seconds = (duration / 1000).toFixed(1);
    this.write(`[AICODER] Run completed (duration: ${seconds}s, exit: ${exitCode ?? "unknown"})`);
    this.close();
  }

  private write(line: string): void {
    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.write(line + "\n");
    }
  }

  private close(): void {
    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.end();
      this.logStream = null;
    }
  }
}