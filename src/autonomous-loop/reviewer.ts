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
import { createHash } from 'crypto';
import {
  defaultSemanticReviewConfig,
  semanticReview,
  type SemanticFinding,
  type SemanticReviewConfig,
} from './semantic-review';

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
  /** LLM semantic review config. Set to false to disable. */
  semanticReview?: SemanticReviewConfig | false;
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
  semanticFindings: SemanticFinding[];
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
  private readonly config: Required<Omit<ReviewerConfig, 'semanticReview'>> & Pick<ReviewerConfig, 'semanticReview'>;
  private readonly customChecks: ((output: WorkOutput) => CheckResult)[] = [];
  private readonly seenSemanticFindingHashes = new Set<string>();

  constructor(config?: ReviewerConfig) {
    super();
    this.config = {
      autoApproveThreshold: config?.autoApproveThreshold ?? 0.8,
      humanReviewThreshold: config?.humanReviewThreshold ?? 0.4,
      batchSize: config?.batchSize ?? 50,
      semanticReview: config?.semanticReview,
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
      const result = await this.reviewSingle(output);
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

  private async reviewSingle(output: WorkOutput): Promise<ReviewResult> {
    const allChecks = [...BUILTIN_CHECKS, ...this.customChecks];
    const checks = allChecks.map((check) => check(output));
    const semanticFindings: SemanticFinding[] = [];

    if (checks.every((check) => check.passed)) {
      const semanticConfig = this.config.semanticReview;
      const diff = getStringMetadata(output, 'diff') ?? output.content;
      const issueContext = getStringMetadata(output, 'issueContext') ?? getStringMetadata(output, 'issue') ?? '';

      if (semanticConfig !== false && (diff.trim() || issueContext.trim())) {
        try {
          const semanticResult = await semanticReview(diff, issueContext, semanticConfig ?? defaultSemanticReviewConfig());
          const newFindings = semanticResult.findings.filter((finding) => {
            const hash = hashSemanticFinding(finding);
            if (this.seenSemanticFindingHashes.has(hash)) return false;
            this.seenSemanticFindingHashes.add(hash);
            return true;
          });

          semanticFindings.push(...newFindings);
          checks.push(...newFindings.map(semanticFindingToCheck));

          if (semanticResult.recommendation === 'reject' && semanticResult.findings.length === 0) {
            checks.push({
              name: 'semantic-review',
              passed: false,
              score: 0,
              message: semanticResult.summary,
            });
          }
        } catch (error) {
          checks.push({
            name: 'semantic-review',
            passed: false,
            score: 0.6,
            message: error instanceof Error ? error.message : 'Semantic review failed',
          });
        }
      }
    }

    const totalScore = checks.reduce((sum, c) => sum + c.score, 0) / checks.length;

    let level: ReviewResult['level'];
    if (totalScore >= this.config.autoApproveThreshold) {
      level = 'auto';
    } else if (totalScore >= this.config.humanReviewThreshold) {
      level = 'flag';
    } else {
      level = 'block';
    }

    if (semanticFindings.some((finding) => finding.severity === 'critical') && level === 'auto') {
      level = 'flag';
    }

    if (semanticFindings.some((finding) => finding.severity === 'high') && level === 'auto') {
      level = 'flag';
    }

    return {
      workId: output.id,
      level,
      score: Math.round(totalScore * 100) / 100,
      checks,
      semanticFindings,
      decidedAt: new Date().toISOString(),
    };
  }
}

function getStringMetadata(output: WorkOutput, key: string): string | undefined {
  const value = output.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function semanticFindingToCheck(finding: SemanticFinding): CheckResult {
  return {
    name: `semantic-${finding.category}`,
    passed: false,
    score: semanticFindingScore(finding.severity),
    message: `${finding.severity.toUpperCase()} ${finding.file}${finding.line ? `:${finding.line}` : ''}: ${finding.message}`,
  };
}

function semanticFindingScore(severity: SemanticFinding['severity']): number {
  switch (severity) {
    case 'critical':
      return 0;
    case 'high':
      return 0.2;
    case 'medium':
      return 0.6;
    case 'low':
      return 0.85;
  }
}

function hashSemanticFinding(finding: SemanticFinding): string {
  const key = [
    finding.file.trim(),
    finding.severity,
    finding.category,
    finding.message.trim(),
  ].join('\0');
  return createHash('sha256').update(key).digest('hex');
}
