import type {
  DetectionIdeaInput,
  DetectionIdeaOutput,
  MitreMappingInput,
  MitreMappingOutput,
  CoverageGapInput,
  CoverageGapOutput,
  DetectionReviewInput,
  DetectionReviewOutput,
  DetectionWorkItemInput,
} from './types.js';
import { auditLogger } from '../audit/logger.js';
import { workItemDatabase } from '../work-items/database.js';
import { v4 as uuidv4 } from 'uuid';

export class DetectionAssistant {
  async generateDetectionIdea(input: DetectionIdeaInput): Promise<DetectionIdeaOutput> {
    const mitreMapping = await this.mapToMitre({
      name: input.name,
      description: input.description,
      technique: input.mitreTechniques?.[0],
    });

    const severity = input.severity || 'medium';

    const output = {
      summary: `Detection idea for ${input.name}`,
      hypothesis: `If ${input.description}, then an adversary may be performing ${input.name} using ${input.mitreTechniques?.join(', ') || 'unknown techniques'}`,
      dataSources: [input.dataSource || 'logs', 'endpoint', 'network'].filter(Boolean),
      candidateLogic: `// Detection: ${input.name}\n// Data Source: ${input.dataSource || 'logs'}\n// Severity: ${severity}\nevent where ${input.description}`,
      mitreMapping: mitreMapping.techniques.map(t => ({
        technique: t.id,
        tactic: t.tactic,
        subtechnique: t.subtechniques?.[0],
      })),
      falsePositiveConsiderations: [
        'Legitimate administrative activity may trigger this detection',
        'Service accounts performing automated tasks',
        'Authorized security scanning or testing',
      ],
      testCases: [
        { name: `${input.name} - True Positive`, description: `Execute ${input.name} technique and verify detection fires`, type: 'true_positive' as const },
        { name: `${input.name} - True Negative`, description: `Perform legitimate activity and verify detection does NOT fire`, type: 'true_negative' as const },
        { name: `${input.name} - False Positive`, description: `Test common false positive scenarios for this detection`, type: 'false_positive' as const },
      ],
      validationPlan: [
        'Test with known-bad sample data',
        'Test with known-good baseline data',
        'Verify alerting and case creation works end-to-end',
      ],
      rolloutNotes: [
        'Deploy to staging environment first',
        'Monitor for 48 hours before enabling automated response',
        'Document any tuning adjustments made during rollout',
      ],
      workItems: [
        {
          title: `Implement detection: ${input.name}`,
          type: 'detection',
          priority: severity,
          description: `Implement detection for ${input.name}: ${input.description}`,
        },
        {
          title: `Write tests for detection: ${input.name}`,
          type: 'detection',
          priority: 'medium',
          description: `Create true positive, true negative, and false positive test cases`,
        },
      ],
      draftFormats: [
        { format: 'sigma-like', content: `title: ${input.name}\ndescription: ${input.description}\nstatus: experimental\nlevel: ${severity}` },
        { format: 'kql-like', content: `// Detection: ${input.name}\nevent where ${input.description}` },
      ],
    } satisfies DetectionIdeaOutput;

    await auditLogger.log({
      id: uuidv4(),
      timestamp: new Date(),
      action: 'detection_idea_generated',
      actor: 'detection-assistant',
      details: {
        name: input.name,
        severity,
        techniques: input.mitreTechniques ?? [],
        workItemCount: output.workItems.length,
      },
      severity: 'info',
    });

    return output;
  }

  async mapToMitre(input: MitreMappingInput): Promise<MitreMappingOutput> {
    // MITRE ATT&CK mapping - simplified implementation
    const techniques: MitreMappingOutput['techniques'] = [];

    if (input.technique) {
      techniques.push({
        id: input.technique,
        name: input.name || `Technique ${input.technique}`,
        tactic: input.tactic || 'Unknown',
        subtechniques: [],
      });
    }

    await auditLogger.log({
      id: uuidv4(),
      timestamp: new Date(),
      action: 'detection_mitre_mapped',
      actor: 'detection-assistant',
      details: {
        technique: input.technique,
        tactic: input.tactic,
        mappedTechniques: techniques.length,
      },
      severity: 'info',
    });

    return {
      techniques,
      suggestedDataSources: ['logs', 'endpoint', 'network'],
      relatedDetections: [],
    };
  }

  async generateTestCases(input: DetectionIdeaInput): Promise<DetectionIdeaOutput['testCases']> {
    const idea = await this.generateDetectionIdea(input);
    return idea.testCases;
  }

  async reviewDetectionLogic(input: DetectionReviewInput): Promise<DetectionReviewOutput> {
    const output: DetectionReviewOutput = {
      strengths: ['Detection logic is structured and follows naming conventions'],
      weaknesses: ['Consider adding threshold-based logic to reduce false positives'],
      falsePositiveRisk: 'medium',
      tuningSuggestions: [
        'Add allowlisting for known service accounts',
        'Consider time-of-day baselines',
        'Add threshold for event count before alerting',
      ],
      improvedLogic: `// Improved: ${input.name}\n${input.logic}\n// Added: threshold logic and allowlisting`,
    };

    await auditLogger.log({
      id: uuidv4(),
      timestamp: new Date(),
      action: 'detection_logic_reviewed',
      actor: 'detection-assistant',
      details: {
        name: input.name,
        format: input.format,
        falsePositiveRisk: output.falsePositiveRisk,
      },
      severity: 'info',
    });

    return output;
  }

  async createDetectionWorkItems(input: DetectionWorkItemInput): Promise<string[]> {
    const createdIds: string[] = [];
    const source = input.assignToJira ? 'jira' : 'hawk-ir';

    for (const item of input.idea.workItems) {
      try {
        const created = workItemDatabase.createWorkItem({
          type: 'detection',
          title: item.title,
          description: item.description,
          priority: item.priority as any,
          source,
          status: 'proposed',
          metadata: input.assignToJira ? { assignToJira: true } : undefined,
        });
        createdIds.push(created.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown database error';
        await auditLogger.log({
          id: uuidv4(),
          timestamp: new Date(),
          action: 'detection_work_item_failed',
          actor: 'detection-assistant',
          details: {
            title: item.title,
            source,
            error: message,
          },
          severity: 'error',
        });
        throw new Error(`Failed to create detection work item: ${message}`);
      }
    }

    if (createdIds.length > 0) {
      await auditLogger.log({
        id: uuidv4(),
        timestamp: new Date(),
        action: 'detection_work_items_created',
        actor: 'detection-assistant',
        details: {
          count: createdIds.length,
          source,
          assignToJira: input.assignToJira ?? false,
        },
        severity: 'info',
      });
    }

    return createdIds;
  }

  async summarizeCoverageGaps(input: CoverageGapInput): Promise<CoverageGapOutput> {
    const totalTechniques = input.mitreTechniques?.length ?? 0;
    const coveragePercentage = totalTechniques
      ? Math.min(100, ((input.existingDetections?.length ?? 0) / totalTechniques) * 100)
      : 0;

    return {
      gaps: [
        {
          technique: 'T1078',
          tactic: 'Defense Evasion',
          reason: 'No detection for valid account abuse',
          severity: 'high',
        },
      ],
      suggestedDetections: [
        {
          name: 'Suspicious Account Usage',
          description: 'Detect anomalous usage of valid accounts',
          priority: 'high',
        },
      ],
      coveragePercentage,
    };
  }
}

export const detectionAssistant = new DetectionAssistant();
