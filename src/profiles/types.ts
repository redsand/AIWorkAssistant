/**
 * Profile types for multi-personality agent instances
 */

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  systemPromptPath: string;
  memoryPath: string;
  skillsPath: string;
  allowedTools: string[];
  blockedTools: string[];
  maxToolCalls: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileConfig {
  id: string;
  name: string;
  description: string;
  allowedTools?: string[];
  blockedTools?: string[];
  maxToolCalls?: number;
}
