import { config } from 'dotenv';
import { z } from 'zod';

// Load environment variables from .env file
config();

const envSchema = z.object({
  // Server
  PORT: z.string().transform(Number).default('6000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // OpenCode API
  OPENCODE_API_URL: z.string().url().default('https://api.opencode.com/v1'),
  OPENCODE_API_KEY: z.string().default(''),

  // Microsoft 365
  MICROSOFT_TENANT_ID: z.string().default(''),
  MICROSOFT_CLIENT_ID: z.string().default(''),
  MICROSOFT_CLIENT_SECRET: z.string().default(''),
  MICROSOFT_REDIRECT_URI: z.string().url().default('http://localhost:3000/auth/microsoft/callback'),

  // Jira
  JIRA_BASE_URL: z.string().url().default('https://your-domain.atlassian.net'),
  JIRA_EMAIL: z.string().default(''),
  JIRA_API_TOKEN: z.string().default(''),
  JIRA_PROJECT_KEYS: z.string().default('').transform(s => s ? s.split(',').map(k => k.trim()) : []),

  // GitLab
  GITLAB_BASE_URL: z.string().url().default('https://gitlab.com'),
  GITLAB_TOKEN: z.string().default(''),
  GITLAB_WEBHOOK_SECRET: z.string().default(''),

  // Policy
  POLICY_APPROVAL_MODE: z.enum(['strict', 'balanced', 'permissive']).default('strict'),
  POLICY_JIRA_AUTO_CLOSE: z.string().transform(s => s === 'true').default('false'),
  POLICY_CALENDAR_ALLOW_DELETE: z.string().transform(s => s === 'true').default('false'),

  // Database
  DATABASE_URL: z.string().default('sqlite:./data/app.db'),

  // Audit
  AUDIT_LOG_FILE: z.string().default('./logs/audit.log'),
  AUDIT_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Feature flags
  ENABLE_CALENDAR_WRITE: z.string().transform(s => s === 'true').default('false'),
  ENABLE_JIRA_TRANSITIONS: z.string().transform(s => s === 'true').default('true'),
  ENABLE_GITLAB_WEBHOOKS: z.string().transform(s => s === 'true').default('true'),

  // Discord
  DISCORD_BOT_TOKEN: z.string().default(''),
  DISCORD_CLIENT_ID: z.string().default(''),
  DISCORD_GUILD_ID: z.string().default(''),

  // Signal
  SIGNAL_PHONE_NUMBER: z.string().default(''),
  SIGNAL_DATA_PATH: z.string().default('~/.config/Signal'),
  SIGNAL_WEBHOOK_PORT: z.string().transform(Number).default('3001'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('❌ Invalid environment configuration:');
    parsed.error.errors.forEach(err => {
      console.error(`  - ${err.path.join('.')}: ${err.message}`);
    });
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();
