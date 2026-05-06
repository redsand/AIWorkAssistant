/**
 * Autonomous Loop Reviewer
 * 
 * Reviews completed work items for quality before they are marked as done.
 * Part of the autonomous loop system — ensures that AI-generated output
 * meets quality standards without requiring human review at every step.
 * 
 * Review Levels:
 * - auto:    Fully automatic — accept if all checks pass
 * - flag:    Auto-accept but flag for later human audit
 * - block:   Require human approval before marking done
 */

import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewerConfig {
  /** Minimum quality score (0-1) to auto-approve (default: 0.8) */
  autoApproveThreshold?: number;
  /** Score below this always blocks for human review (default: 0.4) */
  humanReviewThreshold?: number;
  /** Maximum items to review per cycle (default: 50) */
  batchSize?: number;
}

export interface WorkOutput {
  id: string;
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ReviewResult {
  workId: string;
  level: 'auto' | 'flag' | 'block';
  score: number;
  checks: CheckResult[];
  decidedAt: string;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  score: number;
  message?: string;
}

export type ReviewerState = 'idle' | 'reviewing' | 'stopped';

// ---------------------------------------------------------------------------
// Built-in checks
// ---------------------------------------------------------------------------

const MIN_CONTENT_LENGTH = 10;

function checkNonEmpty(output: WorkOutput): CheckResult {
  const passed = output.content.trim().length >= MIN_CONTENT_LENGTH;
  return {
    name: 'non-empty',
    passed,
    score: passed ? 1 : 0,
    message: passed ? undefined : 'Content is empty or too short',
  };
}

function checkNoPlaceholders(output: WorkOutput): CheckResult {
  const placeholderPattern = /TODO|FIXME|HACK|XXX|PLACEHOLDER/i;
  const hasPlaceholder = placeholderPattern.test(output.content);
  return {
    name: 'no-placeholders',
    passed: !hasPlaceholder,
    score: hasPlaceholder ? 0.3 : 1,
    message: hasPlaceholder ? 'Content contains placeholder markers' : undefined,
  };
}

function checkStructure(output: WorkOutput): CheckResult {
  // Very basic structural check — content should have some line breaks
  // or sections for non-trivial outputs
  const lines = output.content.split('\n').length;
  const passed = lines > 1 || output.content.length < 200;
  return {
    name: 'structure',
    passed,
    score: passed ? 1 : 0.5,
    message: passed ? undefined : 'Output appears to be a single long line — may need formatting',
  };
}

const BUILTIN_CHECKS: ((output: WorkOutput) => CheckResult)[] = [
  checkNonEmpty,
  checkNoPlaceholders,
  checkStructure,
];

// ---------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------

export class AutonomousLoopReviewer extends EventEmitter {
  private state: ReviewerState = 'idle';
  private readonly config: Required<ReviewerConfig>;
  private readonly customChecks: ((output: WorkOutput) => CheckResult)[] = [];

  constructor(config?: ReviewerConfig) {
    super();
    this.config = {
      autoApproveThreshold: config?.autoApproveThreshold ?? 0.8,
      humanReviewThreshold: config?.humanReviewThreshold ?? 0.4,
      batchSize: config?.batchSize ?? 50,
    };
  }

  /** Register a custom quality check. */
  addCheck(check: (output: WorkOutput) => CheckResult): void {
    this.customChecks.push(check);
  }

  /** Current state for observability. */
  getState(): ReviewerState {
    return this.state;
  }

  /**
   * Review a batch of work outputs and return review results.
   * Results determine whether each item is auto-approved, flagged, or blocked.
   */
  async reviewBatch(outputs: WorkOutput[]): Promise<ReviewResult[]> {
    if (this.state === 'stopped') throw new Error('Reviewer is stopped');

    this.state = 'reviewing';
    this.emit('review-started', { count: outputs.length });

    const batch = outputs.slice(0, this.config.batchSize);
    const results: ReviewResult[] = [];

    for (const output of batch) {
      const result = this.reviewSingle(output);
      results.push(result);
      this.emit('item-reviewed', result);
    }

    this.state = 'idle';
    this.emit('review-completed', {
      total: results.length,
      auto: results.filter((r) => r.level === 'auto').length,
      flagged: results.filter((r) => r.level === 'flag').length,
      blocked: results.filter((r) => r.level === 'block').length,
    });

    return results;
  }

  /** Stop the reviewer — future calls to reviewBatch will throw. */
  stop(): void {
    this.state = 'stopped';
    this.emit('stopped');
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private reviewSingle(output: WorkOutput): ReviewResult {
    const allChecks = [...BUILTIN_CHECKS, ...this.customChecks];
    const checks = allChecks.map((check) => check(output));

    const totalScore = checks.reduce((sum, c) => sum + c.score, 0) / checks.length;

    let level: ReviewResult['level'];
    if (totalScore >= this.config.autoApproveThreshold) {
      level = 'auto';
    } else if (totalScore >= this.config.humanReviewThreshold) {
      level = 'flag';
    } else {
      level = 'block';
    }

    return {
      workId: output.id,
      level,
      score: Math.round(totalScore * 100) / 100,
      checks,
      decidedAt: new Date().toISOString(),
    };
  }
}