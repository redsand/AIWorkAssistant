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
import { workItemDatabase } from '../work-items/database.js';

export class DetectionAssistant {
  async generateDetectionIdea(input: DetectionIdeaInput): Promise<DetectionIdeaOutput> {
    const mitreMapping = await this.mapToMitre({
      name: input.name,
      description: input.description,
      technique: input.mitreTechniques?.[0],
    });

    const severity = input.severity || 'medium';

    return {
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
        { name: `${input.name} - True Positive`, description: `Execute ${input.name} technique and verify detection fires`, type: 'true_positive' },
        { name: `${input.name} - True Negative`, description: `Perform legitimate activity and verify detection does NOT fire`, type: 'true_negative' },
        { name: `${input.name} - False Positive`, description: `Test common false positive scenarios for this detection`, type: 'false_positive' },
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
    };
  }

  async mapToMitre(input: MitreMappingInput): Promise<MitreMappingOutput> {
    // MITRE ATT&CK mapping - simplified implementation
    const techniques: MitreMappingOutput['techniques'] = [];

    if (input.technique) {
      techniques.push({
        id: input.technique,
        name: input.name || `Technique ${input.technique}`,
        tactic: input.description || 'Unknown',
        subtechniques: [],
      });
    }

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
    return {
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
  }

  async createDetectionWorkItems(input: DetectionWorkItemInput): Promise<string[]> {
    const createdIds: string[] = [];

    for (const item of input.idea.workItems) {
      const id = workItemDatabase.createWorkItem({
        type: 'detection',
        title: item.title,
        description: item.description,
        priority: item.priority as any,
        source: 'hawk-ir',
        status: 'proposed',
      });
      createdIds.push(id.id);
    }

    return createdIds;
  }

  async summarizeCoverageGaps(input: CoverageGapInput): Promise<CoverageGapOutput> {
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
      coveragePercentage: input.existingDetections?.length
        ? Math.min(100, (input.existingDetections.length / 14) * 100)
        : 0,
    };
  }
}

export const detectionAssistant = new DetectionAssistant();
