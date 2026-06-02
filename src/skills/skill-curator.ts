import type { SkillSummary } from "./skill-types";
import { SkillManager } from "./skill-manager";

const STALE_THRESHOLD_DAYS = 30;
const ARCHIVE_THRESHOLD_DAYS = 14;
const MERGE_OVERLAP_THRESHOLD = 0.7;

export interface CurationDecision {
  skillPath: string;
  action: "stale" | "archive" | "merge_suggestion";
  reason: string;
  timestamp: string;
}

export interface CurationResult {
  decisions: CurationDecision[];
  totalEvaluated: number;
}

export class SkillCurator {
  private manager: SkillManager;
  private staleThresholdDays: number;
  private archiveThresholdDays: number;

  constructor(
    manager: SkillManager,
    options?: {
      staleThresholdDays?: number;
      archiveThresholdDays?: number;
    },
  ) {
    this.manager = manager;
    this.staleThresholdDays =
      options?.staleThresholdDays ?? STALE_THRESHOLD_DAYS;
    this.archiveThresholdDays =
      options?.archiveThresholdDays ?? ARCHIVE_THRESHOLD_DAYS;
  }

  curate(): CurationResult {
    const decisions: CurationDecision[] = [];
    const skills = this.manager.list();
    const now = new Date();

    for (const summary of skills) {
      if (summary.status === "archived") continue;

      const skill = this.manager.loadFull(summary.filePath);
      if (!skill) continue;

      const fm = skill.frontmatter;
      const lastActivity = fm.last_used_at ?? fm.updated_at;
      const lastDate = new Date(lastActivity);
      const daysSinceUse = daysBetween(lastDate, now);

      if (fm.status === "active" && daysSinceUse > this.staleThresholdDays) {
        this.manager.updateStatus(summary.filePath, "stale");

        decisions.push({
          skillPath: summary.filePath,
          action: "stale",
          reason: `Not used in ${daysSinceUse} days (threshold: ${this.staleThresholdDays})`,
          timestamp: now.toISOString(),
        });
      } else if (
        fm.status === "stale" &&
        daysSinceUse > this.staleThresholdDays + this.archiveThresholdDays
      ) {
        this.manager.updateStatus(summary.filePath, "archived");

        decisions.push({
          skillPath: summary.filePath,
          action: "archive",
          reason: `Stale for ${daysSinceUse - this.staleThresholdDays} days past stale threshold (archive threshold: ${this.archiveThresholdDays})`,
          timestamp: now.toISOString(),
        });
      }
    }

    const mergeSuggestions = this.findOverlappingSkills(skills);
    decisions.push(...mergeSuggestions);

    console.log(
      `[SkillCurator] Evaluated ${skills.length} skills, made ${decisions.length} decisions`,
    );

    return {
      decisions,
      totalEvaluated: skills.length,
    };
  }

  private findOverlappingSkills(
    skills: SkillSummary[],
  ): CurationDecision[] {
    const decisions: CurationDecision[] = [];
    const activeSkills = skills.filter((s) => s.status === "active");
    const now = new Date().toISOString();

    for (let i = 0; i < activeSkills.length; i++) {
      for (let j = i + 1; j < activeSkills.length; j++) {
        const a = activeSkills[i];
        const b = activeSkills[j];

        const overlap = computeTagOverlap(a.tags, b.tags);
        if (overlap >= MERGE_OVERLAP_THRESHOLD) {
          decisions.push({
            skillPath: `${a.filePath} + ${b.filePath}`,
            action: "merge_suggestion",
            reason: `Tags overlap ${(overlap * 100).toFixed(0)}% (threshold: ${MERGE_OVERLAP_THRESHOLD * 100}%). Consider merging.`,
            timestamp: now,
          });
        }
      }
    }

    return decisions;
  }
}

function daysBetween(a: Date, b: Date): number {
  const msPerDay = 86400000;
  return Math.floor((b.getTime() - a.getTime()) / msPerDay);
}

function computeTagOverlap(tagsA: string[], tagsB: string[]): number {
  if (tagsA.length === 0 && tagsB.length === 0) return 0;
  const setA = new Set(tagsA.map((t) => t.toLowerCase()));
  const setB = new Set(tagsB.map((t) => t.toLowerCase()));
  let shared = 0;
  for (const tag of setA) {
    if (setB.has(tag)) shared++;
  }
  const total = new Set([...setA, ...setB]).size;
  return total > 0 ? shared / total : 0;
}
