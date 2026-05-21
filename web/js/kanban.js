/**
 * @module kanban
 * Kanban board types — mirrors src/kanban/types.ts for editor IntelliSense.
 */

/**
 * @typedef {"backlog"|"in_flight"|"blocked"|"done"} KanbanColumn
 */

/**
 * @typedef {object} KanbanCard
 * @property {string} key - "<platform>:<repo>:<id>"
 * @property {"github"|"gitlab"|"jira"|"work_items"} platform
 * @property {string} repo
 * @property {string} id
 * @property {string} externalId
 * @property {string} title
 * @property {string} url
 * @property {string} status
 * @property {KanbanColumn} column
 * @property {"critical"|"high"|"medium"|"low"|"unknown"} priority
 * @property {string|null} assignee
 * @property {string[]} labels
 * @property {string} [sprint]
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string[]} dependencyKeys
 * @property {string|null} activeAgentRunId
 */

/**
 * @typedef {object} KanbanAgent
 * @property {string} agentRunId
 * @property {"claude"|"codex"|"opencode"} agent
 * @property {string|null} model
 * @property {"running"|"completed"|"failed"} status
 * @property {string|null} cardKey
 * @property {string} startedAt
 * @property {string} lastActivityAt
 * @property {number} toolLoopCount
 * @property {string|null} lastTool
 * @property {string} [checkpoint]
 */

/**
 * @typedef {object} KanbanEdge
 * @property {string} fromKey
 * @property {string} toKey
 * @property {boolean} fromGhost
 * @property {"depends_on"|"blocks"} kind
 * @property {string} label
 */

/**
 * @typedef {object} KanbanGhostNode
 * @property {string} key
 * @property {string} platform
 * @property {string} repo
 * @property {string} id
 * @property {string} label
 */

/**
 * @typedef {object} KanbanBoardResponse
 * @property {KanbanCard[]} cards
 * @property {KanbanEdge[]} edges
 * @property {KanbanGhostNode[]} ghostNodes
 * @property {KanbanAgent[]} agents
 * @property {Array<{platform:string,repo:string,cardCount:number}>} repos
 * @property {string} generatedAt
 */

/**
 * @typedef {object} KanbanSSEEventCardUpdated
 * @property {"card.updated"} type
 * @property {KanbanCard} card
 */

/**
 * @typedef {object} KanbanSSEEventAgentStarted
 * @property {"agent.started"} type
 * @property {KanbanAgent} agent
 */

/**
 * @typedef {object} KanbanSSEEventAgentStep
 * @property {"agent.step"} type
 * @property {string} agentRunId
 * @property {string} toolName
 * @property {number} stepOrder
 */

/**
 * @typedef {object} KanbanSSEEventAgentCompleted
 * @property {"agent.completed"} type
 * @property {string} agentRunId
 * @property {"completed"|"failed"} status
 * @property {string} [errorMessage]
 */

/**
 * @typedef {object} KanbanSSEEventDependencyUnblocked
 * @property {"dependency.unblocked"} type
 * @property {string} blockerKey
 * @property {string[]} unblockedKeys
 */

/**
 * @typedef {object} KanbanSSEEventWorktreeChanged
 * @property {"worktree.changed"} type
 * @property {string} path
 * @property {"active"|"removed"} status
 */

/**
 * @typedef {KanbanSSEEventCardUpdated|KanbanSSEEventAgentStarted|KanbanSSEEventAgentStep|KanbanSSEEventAgentCompleted|KanbanSSEEventDependencyUnblocked|KanbanSSEEventWorktreeChanged} KanbanSSEEvent
 */
