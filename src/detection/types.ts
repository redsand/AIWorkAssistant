export interface DetectionIdeaInput {
  name: string;
  description: string;
  dataSource?: string;
  mitreTechniques?: string[];
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

export interface DetectionIdeaOutput {
  summary: string;
  hypothesis: string;
  dataSources: string[];
  candidateLogic: string;
  mitreMapping: { technique: string; tactic: string; subtechnique?: string }[];
  falsePositiveConsiderations: string[];
  testCases: { name: string; description: string; type: 'true_positive' | 'true_negative' | 'false_positive' }[];
  validationPlan: string[];
  rolloutNotes: string[];
  workItems: { title: string; type: string; priority: string; description: string }[];
  draftFormats: { format: string; content: string }[];
}

export interface MitreMappingInput {
  technique?: string;
  tactic?: string;
  name?: string;
  description?: string;
}

export interface MitreMappingOutput {
  techniques: { id: string; name: string; tactic: string; subtechniques?: string[] }[];
  suggestedDataSources: string[];
  relatedDetections: string[];
}

export interface CoverageGapInput {
  existingDetections?: string[];
  mitreTechniques?: string[];
  dataSources?: string[];
}

export interface CoverageGapOutput {
  gaps: { technique: string; tactic: string; reason: string; severity: string }[];
  suggestedDetections: { name: string; description: string; priority: string }[];
  coveragePercentage: number;
}

export interface DetectionReviewInput {
  name: string;
  logic: string;
  format?: string;
}

export interface DetectionReviewOutput {
  strengths: string[];
  weaknesses: string[];
  falsePositiveRisk: 'low' | 'medium' | 'high' | 'critical';
  tuningSuggestions: string[];
  improvedLogic?: string;
}

export interface DetectionWorkItemInput {
  idea: DetectionIdeaOutput;
  priority?: string;
  assignToJira?: boolean;
}
