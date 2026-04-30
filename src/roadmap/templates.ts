/**
 * MDR Service Delivery Templates
 * Pre-built roadmap templates for common MDR service scenarios
 */

import { roadmapDatabase } from './database';

export interface TemplateMilestone {
  name: string;
  description: string;
  targetDaysFromStart: number;
  order: number;
}

export interface TemplateItem {
  title: string;
  description: string;
  type: 'feature' | 'task' | 'bug' | 'technical_debt' | 'research';
  priority: 'low' | 'medium' | 'high' | 'critical';
  estimatedHours: number;
  milestoneIndex: number; // Which milestone this belongs to
  order: number;
}

export interface RoadmapTemplateData {
  name: string;
  description: string;
  milestones: TemplateMilestone[];
  items: TemplateItem[];
}

/**
 * Client Onboarding Template
 * 90-day onboarding process for new MDR clients
 */
export const CLIENT_ONBOARDING_TEMPLATE: RoadmapTemplateData = {
  name: 'MDR Client Onboarding',
  description: 'Complete 90-day onboarding process for new MDR clients including deployment, configuration, and optimization',
  milestones: [
    {
      name: 'Discovery & Planning',
      description: 'Initial assessment, requirements gathering, and deployment planning',
      targetDaysFromStart: 0,
      order: 0,
    },
    {
      name: 'Deployment & Configuration',
      description: 'Sensor deployment, policy configuration, and integration setup',
      targetDaysFromStart: 14,
      order: 1,
    },
    {
      name: 'Tuning & Optimization',
      description: 'Alert tuning, detection optimization, and baseline establishment',
      targetDaysFromStart: 45,
      order: 2,
    },
    {
      name: 'Knowledge Transfer & Handoff',
      description: 'Training, documentation, and transition to steady-state operations',
      targetDaysFromStart: 75,
      order: 3,
    },
  ],
  items: [
    // Discovery & Planning items
    {
      title: 'Kickoff meeting with client',
      description: 'Initial stakeholder meeting to understand client environment, security posture, and objectives',
      type: 'task',
      priority: 'high',
      estimatedHours: 2,
      milestoneIndex: 0,
      order: 0,
    },
    {
      title: 'Network and infrastructure assessment',
      description: 'Document client network architecture, critical assets, and security controls',
      type: 'task',
      priority: 'high',
      estimatedHours: 16,
      milestoneIndex: 0,
      order: 1,
    },
    {
      title: 'Create deployment plan',
      description: 'Develop detailed deployment plan with timelines, resource requirements, and rollback procedures',
      type: 'feature',
      priority: 'high',
      estimatedHours: 8,
      milestoneIndex: 0,
      order: 2,
    },
    {
      title: 'Define use cases and detection requirements',
      description: 'Identify key use cases, detection priorities, and compliance requirements',
      type: 'research',
      priority: 'high',
      estimatedHours: 12,
      milestoneIndex: 0,
      order: 3,
    },
    // Deployment & Configuration items
    {
      title: 'Deploy endpoint sensors',
      description: 'Install and configure EDR/sensors on endpoints',
      type: 'feature',
      priority: 'critical',
      estimatedHours: 40,
      milestoneIndex: 1,
      order: 0,
    },
    {
      title: 'Configure network telemetry',
      description: 'Set up network flow collection, traffic analysis, and log aggregation',
      type: 'feature',
      priority: 'critical',
      estimatedHours: 24,
      milestoneIndex: 1,
      order: 1,
    },
    {
      title: 'Integrate with existing security tools',
      description: 'Configure integrations with SIEM, firewall, and other security tools',
      type: 'feature',
      priority: 'high',
      estimatedHours: 16,
      milestoneIndex: 1,
      order: 2,
    },
    {
      title: 'Create detection rules and policies',
      description: 'Develop and deploy detection rules, alert policies, and response playbooks',
      type: 'feature',
      priority: 'critical',
      estimatedHours: 32,
      milestoneIndex: 1,
      order: 3,
    },
    // Tuning & Optimization items
    {
      title: 'Analyze alert data and tune thresholds',
      description: 'Review alert data, identify false positives, and adjust detection thresholds',
      type: 'task',
      priority: 'high',
      estimatedHours: 24,
      milestoneIndex: 2,
      order: 0,
    },
    {
      title: 'Optimize detection coverage',
      description: 'Refine detection rules based on observed attack patterns and client feedback',
      type: 'feature',
      priority: 'high',
      estimatedHours: 20,
      milestoneIndex: 2,
      order: 1,
    },
    {
      title: 'Establish performance baselines',
      description: 'Document normal network and endpoint behavior patterns',
      type: 'research',
      priority: 'medium',
      estimatedHours: 16,
      milestoneIndex: 2,
      order: 2,
    },
    {
      title: 'Conductive table-top exercise',
      description: 'Run incident response simulation with client team',
      type: 'task',
      priority: 'high',
      estimatedHours: 8,
      milestoneIndex: 2,
      order: 3,
    },
    // Knowledge Transfer & Handoff items
    {
      title: 'Create client documentation',
      description: 'Document deployment architecture, procedures, and escalation paths',
      type: 'task',
      priority: 'high',
      estimatedHours: 16,
      milestoneIndex: 3,
      order: 0,
    },
    {
      title: 'Deliver security awareness training',
      description: 'Train client staff on security best practices and MDR service processes',
      type: 'task',
      priority: 'medium',
      estimatedHours: 8,
      milestoneIndex: 3,
      order: 1,
    },
    {
      title: 'Final review and sign-off',
      description: 'Conduct final review with client stakeholders and obtain formal sign-off',
      type: 'task',
      priority: 'high',
      estimatedHours: 4,
      milestoneIndex: 3,
      order: 2,
    },
    {
      title: 'Transition to steady-state operations',
      description: 'Hand off to ongoing monitoring team and establish reporting cadence',
      type: 'task',
      priority: 'critical',
      estimatedHours: 4,
      milestoneIndex: 3,
      order: 3,
    },
  ],
};

/**
 * Security Assessment Template
 * 30-day comprehensive security assessment
 */
export const SECURITY_ASSESSMENT_TEMPLATE: RoadmapTemplateData = {
  name: 'Security Assessment',
  description: '30-day comprehensive security assessment including vulnerability scanning, penetration testing, and risk analysis',
  milestones: [
    {
      name: 'Planning & Reconnaissance',
      description: 'Scope definition, asset inventory, and reconnaissance',
      targetDaysFromStart: 0,
      order: 0,
    },
    {
      name: 'Vulnerability Assessment',
      description: 'Automated and manual vulnerability identification',
      targetDaysFromStart: 7,
      order: 1,
    },
    {
      name: 'Penetration Testing',
      description: 'Exploitation and impact assessment',
      targetDaysFromStart: 14,
      order: 2,
    },
    {
      name: 'Reporting & Remediation',
      description: 'Findings analysis, report generation, and remediation guidance',
      targetDaysFromStart: 21,
      order: 3,
    },
  ],
  items: [
    {
      title: 'Define assessment scope and rules of engagement',
      description: 'Identify assets in scope, testing windows, and authorized testing activities',
      type: 'task',
      priority: 'critical',
      estimatedHours: 8,
      milestoneIndex: 0,
      order: 0,
    },
    {
      title: 'Perform asset discovery and reconnaissance',
      description: 'Map client infrastructure, identify exposed services, and gather OSINT',
      type: 'research',
      priority: 'high',
      estimatedHours: 24,
      milestoneIndex: 0,
      order: 1,
    },
    {
      title: 'Run automated vulnerability scans',
      description: 'Execute authenticated and unauthenticated vulnerability scans',
      type: 'feature',
      priority: 'high',
      estimatedHours: 16,
      milestoneIndex: 1,
      order: 0,
    },
    {
      title: 'Perform manual security testing',
      description: 'Manual testing for business logic flaws, access control issues, and other vulnerabilities',
      type: 'research',
      priority: 'high',
      estimatedHours: 32,
      milestoneIndex: 1,
      order: 1,
    },
    {
      title: 'Execute penetration testing exploits',
      description: 'Safely exploit identified vulnerabilities to assess impact',
      type: 'feature',
      priority: 'high',
      estimatedHours: 40,
      milestoneIndex: 2,
      order: 0,
    },
    {
      title: 'Test security controls and detection capabilities',
      description: 'Evaluate effectiveness of existing security controls',
      type: 'research',
      priority: 'medium',
      estimatedHours: 16,
      milestoneIndex: 2,
      order: 1,
    },
    {
      title: 'Analyze findings and calculate risk scores',
      description: 'Prioritize findings by severity and business impact',
      type: 'task',
      priority: 'high',
      estimatedHours: 16,
      milestoneIndex: 3,
      order: 0,
    },
    {
      title: 'Generate assessment report',
      description: 'Create comprehensive report with findings, recommendations, and remediation guidance',
      type: 'feature',
      priority: 'critical',
      estimatedHours: 24,
      milestoneIndex: 3,
      order: 1,
    },
    {
      title: 'Present findings to stakeholders',
      description: 'Executive and technical presentations of assessment results',
      type: 'task',
      priority: 'high',
      estimatedHours: 8,
      milestoneIndex: 3,
      order: 2,
    },
  ],
};

/**
 * Incident Response Retainer Template
 * Ongoing incident preparedness and response services
 */
export const IR_RETAINER_TEMPLATE: RoadmapTemplateData = {
  name: 'Incident Response Retainer',
  description: 'Ongoing incident preparedness services including table-top exercises, playbook development, and readiness assessments',
  milestones: [
    {
      name: 'Baseline Assessment',
      description: 'Evaluate current incident response capabilities',
      targetDaysFromStart: 0,
      order: 0,
    },
    {
      name: 'Playbook Development',
      description: 'Create and customize incident response playbooks',
      targetDaysFromStart: 30,
      order: 1,
    },
    {
      name: 'Table-Top Exercises',
      description: 'Conduct incident response simulations',
      targetDaysFromStart: 60,
      order: 2,
    },
    {
      name: 'Continuous Improvement',
      description: 'Ongoing refinement and readiness activities',
      targetDaysFromStart: 90,
      order: 3,
    },
  ],
  items: [
    {
      title: 'Assess current incident response capabilities',
      description: 'Review existing IR plans, team structure, and technical capabilities',
      type: 'research',
      priority: 'high',
      estimatedHours: 16,
      milestoneIndex: 0,
      order: 0,
    },
    {
      title: 'Identify gaps and improvement opportunities',
      description: 'Compare against industry best practices and compliance requirements',
      type: 'research',
      priority: 'high',
      estimatedHours: 12,
      milestoneIndex: 0,
      order: 1,
    },
    {
      title: 'Develop incident response playbooks',
      description: 'Create playbooks for common incident scenarios (phishing, malware, etc.)',
      type: 'feature',
      priority: 'high',
      estimatedHours: 32,
      milestoneIndex: 1,
      order: 0,
    },
    {
      title: 'Configure incident response tools and integrations',
      description: 'Set up IR tools, automation, and communication channels',
      type: 'feature',
      priority: 'medium',
      estimatedHours: 16,
      milestoneIndex: 1,
      order: 1,
    },
    {
      title: 'Conduct table-top exercise',
      description: 'Facilitate incident response simulation with client team',
      type: 'task',
      priority: 'high',
      estimatedHours: 16,
      milestoneIndex: 2,
      order: 0,
    },
    {
      title: 'Update playbooks based on exercise findings',
      description: 'Refine playbooks and procedures based on lessons learned',
      type: 'task',
      priority: 'medium',
      estimatedHours: 12,
      milestoneIndex: 2,
      order: 1,
    },
    {
      title: 'Quarterly readiness assessment',
      description: 'Ongoing assessment of IR readiness and capabilities',
      type: 'task',
      priority: 'medium',
      estimatedHours: 8,
      milestoneIndex: 3,
      order: 0,
    },
    {
      title: 'Threat intelligence integration',
      description: 'Integrate relevant threat intelligence into IR planning',
      type: 'research',
      priority: 'low',
      estimatedHours: 8,
      milestoneIndex: 3,
      order: 1,
    },
  ],
};

/**
 * Internal: Platform Development Template
 * Internal roadmap for MDR platform development
 */
export const PLATFORM_DEVELOPMENT_TEMPLATE: RoadmapTemplateData = {
  name: 'Platform Development',
  description: 'Internal roadmap for MDR platform development and enhancement',
  milestones: [
    {
      name: 'Requirements & Design',
      description: 'Gather requirements and design new features',
      targetDaysFromStart: 0,
      order: 0,
    },
    {
      name: 'Development',
      description: 'Implement features and unit testing',
      targetDaysFromStart: 14,
      order: 1,
    },
    {
      name: 'Testing & QA',
      description: 'Integration testing, security review, and bug fixes',
      targetDaysFromStart: 45,
      order: 2,
    },
    {
      name: 'Deployment & Documentation',
      description: 'Deploy to production and create documentation',
      targetDaysFromStart: 60,
      order: 3,
    },
  ],
  items: [
    {
      title: 'Gather stakeholder requirements',
      description: 'Collect and prioritize feature requirements from internal teams',
      type: 'research',
      priority: 'high',
      estimatedHours: 16,
      milestoneIndex: 0,
      order: 0,
    },
    {
      title: 'Design technical solution',
      description: 'Create technical design documents and architecture diagrams',
      type: 'feature',
      priority: 'high',
      estimatedHours: 24,
      milestoneIndex: 0,
      order: 1,
    },
    {
      title: 'Implement core features',
      description: 'Develop new features and functionality',
      type: 'feature',
      priority: 'critical',
      estimatedHours: 80,
      milestoneIndex: 1,
      order: 0,
    },
    {
      title: 'Unit testing',
      description: 'Write comprehensive unit tests for new code',
      type: 'task',
      priority: 'high',
      estimatedHours: 40,
      milestoneIndex: 1,
      order: 1,
    },
    {
      title: 'Integration testing',
      description: 'Test integration with existing systems and APIs',
      type: 'task',
      priority: 'high',
      estimatedHours: 24,
      milestoneIndex: 2,
      order: 0,
    },
    {
      title: 'Security review',
      description: 'Conduct security review and address vulnerabilities',
      type: 'task',
      priority: 'critical',
      estimatedHours: 16,
      milestoneIndex: 2,
      order: 1,
    },
    {
      title: 'Bug fixes and refinement',
      description: 'Address bugs identified during testing',
      type: 'bug',
      priority: 'high',
      estimatedHours: 32,
      milestoneIndex: 2,
      order: 2,
    },
    {
      title: 'Deploy to production',
      description: 'Release features to production environment',
      type: 'feature',
      priority: 'high',
      estimatedHours: 8,
      milestoneIndex: 3,
      order: 0,
    },
    {
      title: 'Create technical documentation',
      description: 'Document APIs, configurations, and procedures',
      type: 'task',
      priority: 'medium',
      estimatedHours: 16,
      milestoneIndex: 3,
      order: 1,
    },
    {
      title: 'Train internal teams',
      description: 'Train operations and support teams on new features',
      type: 'task',
      priority: 'medium',
      estimatedHours: 8,
      milestoneIndex: 3,
      order: 2,
    },
  ],
};

/**
 * Initialize all templates in the database
 */
export function initializeTemplates() {
  const templates = [
    {
      template: CLIENT_ONBOARDING_TEMPLATE,
      type: 'client' as const,
      category: 'onboarding' as const,
    },
    {
      template: SECURITY_ASSESSMENT_TEMPLATE,
      type: 'client' as const,
      category: 'project_delivery' as const,
    },
    {
      template: IR_RETAINER_TEMPLATE,
      type: 'client' as const,
      category: 'maintenance' as const,
    },
    {
      template: PLATFORM_DEVELOPMENT_TEMPLATE,
      type: 'internal' as const,
      category: 'internal_improvement' as const,
    },
  ];

  templates.forEach(({ template, type, category }) => {
    // Check if template already exists
    const existing = roadmapDatabase.listTemplates().find(t => t.name === template.name);

    if (!existing) {
      roadmapDatabase.createTemplate({
        name: template.name,
        description: template.description,
        type,
        category,
        milestones: JSON.stringify(template.milestones),
        items: JSON.stringify(template.items),
      });

      console.log(`[Templates] Initialized template: ${template.name}`);
    }
  });

  console.log(`[Templates] Initialized ${templates.length} templates`);
}

export * from './database';
