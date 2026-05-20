import os

test_path = os.path.join('tests', 'unit', 'routes', 'repo-dashboard.test.ts')

# Read current file as base for the sprint field and points tests
with open(test_path, 'r', encoding='utf-8') as f:
    old = f.read()

# Write the new test file
content = []
content.append('/**')
content.append(' * Unit tests for repo-dashboard sprint & burndown endpoints.')
content.append(' */')
content.append('')
content.append('import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";')
content.append('import Fastify, { FastifyInstance } from "fastify";')
content.append('import {')
content.append('  parseDependencies,')
content.append('  normalizeStatus,')
content.append('  normalizePriority,')
content.append('  calculateBurndown,')
content.append('  repoDashboardRoutes,')
content.append('} from "../../../src/routes/repo-dashboard";')
content.append('import type {')
content.append('  DashboardSprint,')
content.append('  DashboardIssue,')
content.append('} from "../../../src/routes/repo-dashboard";')
content.append('')
content.append('vi.mock("../../../src/integrations/github/github-client", () => ({')
content.append('  githubClient: { listRepositories: vi.fn(), listIssues: vi.fn(), listMilestones: vi.fn() },')
content.append('}));')
content.append('vi.mock("../../../src/integrations/gitlab/gitlab-client", () => ({')
content.append('  gitlabClient: { getProjects: vi.fn(), listIssues: vi.fn() },')
content.append('}));')
content.append('vi.mock("../../../src/integrations/jira/jira-client", () => ({')
content.append('  jiraClient: { getProjects: vi.fn(), searchIssues: vi.fn(), getSprints: vi.fn(), getSprintIssues: vi.fn() },')
content.append('}));')
content.append('vi.mock("../../../src/work-items/database", () => ({')
content.append('  workItemDatabase: { listWorkItems: vi.fn() },')
content.append('}));')
content.append('vi.mock("../../../src/config/env", () => ({')
content.append('  env: { GITHUB_TOKEN: "gh-test-token", GITHUB_DEFAULT_OWNER: "test-org", GITHUB_DEFAULT_REPO: "test-repo", GITLAB_TOKEN: "gl-test-token", JIRA_BASE_URL: "https://test.atlassian.net", JIRA_API_TOKEN: "jira-test-token" },')
content.append('}));')
content.append('')
content.append('import { githubClient } from "../../../src/integrations/github/github-client";')
content.append('import { gitlabClient } from "../../../src/integrations/gitlab/gitlab-client";')
content.append('import { jiraClient } from "../../../src/integrations/jira/jira-client";')
content.append('import { workItemDatabase } from "../../../src/work-items/database";')

with open(test_path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(content) + '\n')

print('Header written')
