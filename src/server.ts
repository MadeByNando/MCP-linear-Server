import { LinearClient } from '@linear/sdk';
import { z } from 'zod';
import dotenv from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/*
 * IMPORTANT: MCP Integration Rule
 * ------------------------------
 * When adding new functionality to this server:
 * 1. Update the README.md file with the new endpoint details
 * 2. Include the endpoint in the "Instructing Claude" section
 * 3. Follow the existing format:
 *    ```http
 *    METHOD /endpoint
 *    ```
 *    Description and any required request body/parameters
 * 
 * This ensures Claude can be properly instructed about all available functionality.
 */

// Configuration constants
const DEBUG = true;
const API_TIMEOUT_MS = 30000; // Increased to 30 second timeout for API calls
const HEARTBEAT_INTERVAL_MS = 10000; // Reduced to 10 second heartbeat interval
const SHUTDOWN_GRACE_PERIOD_MS = 5000; // 5 second grace period for shutdown
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 2000;

// Connection state tracking
const connectionState = {
  isConnected: false,
  reconnectAttempts: 0,
  lastHeartbeat: Date.now(),
};

// Utility to create a timeout promise
function createTimeout(ms: number, message: string) {
  return new Promise((_, reject) => 
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${message}`)), ms)
  );
}

// Utility to wrap promises with timeout
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, context: string): Promise<T> {
  try {
    const result = await Promise.race([
      promise,
      createTimeout(timeoutMs, context)
    ]) as T;
    return result;
  } catch (error: any) {
    if (error?.message?.includes('Timeout after')) {
      debugLog(`Operation timed out: ${context}`);
    }
    throw error;
  }
}

function debugLog(...args: any[]) {
  if (DEBUG) {
    console.error(`[DEBUG][${new Date().toISOString()}]`, ...args);
  }
}

function handleError(error: any, context: string) {
  const timestamp = new Date().toISOString();
  console.error(`[ERROR][${timestamp}] ${context}:`, error);
  if (error?.response?.data) {
    console.error('API Response:', error.response.data);
  }
  // Log stack trace for unexpected errors
  if (error instanceof Error) {
    console.error('Stack trace:', error.stack);
  }
}

// Load environment variables
dotenv.config();
debugLog('Environment variables loaded');

// Validate environment variables
const envSchema = z.object({
  LINEAR_API_KEY: z.string().min(1),
});

const envValidation = envSchema.safeParse(process.env);
if (!envValidation.success) {
  console.error('Environment validation failed:', envValidation.error.errors);
  process.exit(1);
}
debugLog('Environment validation successful');

// Initialize Linear client with error handling
let linearClient: LinearClient;
try {
  linearClient = new LinearClient({
    apiKey: process.env.LINEAR_API_KEY,
  });
  debugLog('Linear client initialized');
} catch (error) {
  handleError(error, 'Failed to initialize Linear client');
  process.exit(1);
}

// Create the MCP server with explicit capabilities
const server = new McpServer({
  name: 'linear-mcp-server',
  version: '1.0.0',
  capabilities: {
    tools: {
      'linear_create_issue': {
        description: 'Create a new Linear issue',
        parameters: {
          title: { type: 'string', description: 'Issue title' },
          description: { type: 'string', description: 'Issue description (markdown supported)' },
          teamId: { type: 'string', description: 'Team ID to create issue in' },
          // priority: { type: 'number', description: 'Priority level (0-4)', minimum: 0, maximum: 4 },
          projectId: { type: 'string', description: 'ID of the project to associate the issue with' },
          stateId: { type: 'string', description: 'ID of the workflow state to set for the issue' }
        },
        required: ['title', 'teamId']
      },
      'linear_search_issues': {
        description: 'Search Linear issues with flexible filtering',
        parameters: {
          query: { type: 'string', description: 'Text to search in title/description' },
          teamId: { type: 'string', description: 'Filter by team' },
          status: { type: 'string', description: 'Filter by status' },
          assigneeId: { type: 'string', description: 'Filter by assignee' },
          priority: { type: 'number', description: 'Priority level (0-4)', minimum: 0, maximum: 4 },
          limit: { type: 'number', description: 'Max results', default: 10 }
        }
      },
      'linear_sprint_issues': {
        description: 'Get all issues in the current sprint/iteration',
        parameters: {
          teamId: { type: 'string', description: 'Team ID to get sprint issues for' }
        },
        required: ['teamId']
      },
      'linear_search_teams': {
        description: 'Search and retrieve Linear teams',
        parameters: {
          query: { type: 'string', description: 'Optional text to search in team names' }
        }
      },
      'linear_filter_sprint_issues': {
        description: 'Filter current sprint issues by status and optionally by assignee',
        parameters: {
          teamId: { type: 'string', description: 'Team ID to get sprint issues for' },
          status: { type: 'string', description: 'Status to filter by (e.g. "Pending Prod Release")' }
        },
        required: ['teamId', 'status']
      },
      'linear_get_workflow_states': {
        description: 'Get all available workflow states (statuses) for a team',
        parameters: {
          teamId: { type: 'string', description: 'Team ID to get workflow states for' }
        },
        required: ['teamId']
      },
      'linear_list_projects': {
        description: 'Get a list of all projects available with their IDs',
        parameters: {
          teamId: { type: 'string', description: 'Optional team ID to filter projects by team' },
          limit: { type: 'number', description: 'Max number of projects to return', default: 50 }
        }
      }
    }
  }
});
debugLog('MCP server created');

// Add Linear tools with improved error handling
server.tool(
  'linear_create_issue',
  {
    title: z.string().describe('Issue title'),
    description: z.string().optional().describe('Issue description (markdown supported)'),
    teamId: z.string().describe('Team ID to create issue in'),
    // priority: z.number().min(0).max(4).optional().describe('Priority level (0-4)'),
    projectId: z.string().optional().describe('ID of the project to associate the issue with'),
    stateId: z.string().optional().describe('ID of the workflow state to set for the issue')
  },
  async (params) => {
    try {
      debugLog('Creating issue with params:', params);
      const issueResult = await linearClient.createIssue(params);
      const issueData = await issueResult.issue;
      
      if (!issueData) {
        console.error('Issue creation succeeded but returned no data');
        throw new Error('Issue creation succeeded but returned no data');
      }

      debugLog('Issue created successfully:', issueData.identifier);
      return {
        content: [{
          type: 'text',
          text: `Created issue ${issueData.identifier}: ${issueData.title}`
        }]
      };
    } catch (error) {
      handleError(error, 'Failed to create issue');
      throw error;
    }
  }
);

server.tool(
  'linear_search_issues',
  {
    query: z.string().optional().describe('Text to search in title/description'),
    teamId: z.string().optional().describe('Filter by team'),
    status: z.string().optional().describe('Filter by status'),
    assigneeId: z.string().optional().describe('Filter by assignee'),
    priority: z.number().min(0).max(4).optional().describe('Filter by priority'),
    limit: z.number().default(10).describe('Max results')
  },
  async (params) => {
    try {
      debugLog('Searching issues with params:', params);
      const issues = await linearClient.issues({
        first: params.limit,
        filter: {
          ...(params.teamId && { team: { id: { eq: params.teamId } } }),
          ...(params.status && { state: { name: { eq: params.status } } }),
          ...(params.assigneeId && { assignee: { id: { eq: params.assigneeId } } }),
          ...(params.priority !== undefined && { priority: { eq: params.priority } })
        },
        ...(params.query && { search: params.query })
      });

      debugLog(`Found ${issues.nodes.length} issues`);
      const issueList = await Promise.all(
        issues.nodes.map(async (issue) => {
          const state = await issue.state;
          return `${issue.identifier}: ${issue.title} (${state?.name ?? 'No status'})`;
        })
      );

      return {
        content: [{
          type: 'text',
          text: issueList.join('\n')
        }]
      };
    } catch (error) {
      handleError(error, 'Failed to search issues');
      throw error;
    }
  }
);

server.tool(
  'linear_sprint_issues',
  {
    teamId: z.string().describe('Team ID to get sprint issues for')
  },
  async (params) => {
    try {
      debugLog('Fetching current sprint issues for team:', params.teamId);
      
      // Get the team's current cycle (sprint)
      const team = await linearClient.team(params.teamId);
      const cycles = await linearClient.cycles({
        filter: {
          team: { id: { eq: params.teamId } },
          isActive: { eq: true }
        }
      });
      
      if (!cycles.nodes.length) {
        return {
          content: [{
            type: 'text',
            text: 'No active sprint found for this team.'
          }]
        };
      }

      const currentCycle = cycles.nodes[0];
      
      // Get all issues in the current cycle
      const issues = await linearClient.issues({
        filter: {
          team: { id: { eq: params.teamId } },
          cycle: { id: { eq: currentCycle.id } }
        }
      });

      debugLog(`Found ${issues.nodes.length} issues in current sprint`);

      const issueList = await Promise.all(
        issues.nodes.map(async (issue) => {
          const state = await issue.state;
          const assignee = await issue.assignee;
          return `${issue.identifier}: ${issue.title} (${state?.name ?? 'No status'})${assignee ? ` - Assigned to: ${assignee.name}` : ''}`;
        })
      );

      return {
        content: [{
          type: 'text',
          text: `Current Sprint: ${currentCycle.name}\nStart: ${new Date(currentCycle.startsAt).toLocaleDateString()}\nEnd: ${new Date(currentCycle.endsAt).toLocaleDateString()}\n\nIssues:\n${issueList.join('\n')}`
        }]
      };
    } catch (error) {
      handleError(error, 'Failed to fetch sprint issues');
      throw error;
    }
  }
);

server.tool(
  'linear_search_teams',
  {
    query: z.string().optional().describe('Optional text to search in team names')
  },
  async (params) => {
    try {
      debugLog('Searching teams with query:', params.query);
      
      const teams = await linearClient.teams({
        ...(params.query && { filter: { name: { contains: params.query } } })
      });

      if (!teams.nodes.length) {
        return {
          content: [{
            type: 'text',
            text: 'No teams found.'
          }]
        };
      }

      debugLog(`Found ${teams.nodes.length} teams`);

      const teamList = await Promise.all(
        teams.nodes.map(async (team) => {
          const activeMembers = await team.members();
          return `Team: ${team.name}\nID: ${team.id}\nKey: ${team.key}\nMembers: ${activeMembers.nodes.length}\n`;
        })
      );

      return {
        content: [{
          type: 'text',
          text: teamList.join('\n')
        }]
      };
    } catch (error) {
      handleError(error, 'Failed to search teams');
      throw error;
    }
  }
);

server.tool(
  'linear_filter_sprint_issues',
  {
    teamId: z.string().describe('Team ID to get sprint issues for'),
    status: z.string().describe('Status to filter by')
  },
  async (params) => {
    try {
      debugLog('Filtering sprint issues with params:', params);
      
      // Get current user info with timeout
      const viewer = await withTimeout(
        linearClient.viewer,
        API_TIMEOUT_MS,
        'Fetching Linear user info'
      );
      debugLog('Current user:', viewer.id);
      
      // Get the team's current cycle (sprint) with timeout
      const cycles = await withTimeout(
        linearClient.cycles({
          filter: {
            team: { id: { eq: params.teamId } },
            isActive: { eq: true }
          }
        }),
        API_TIMEOUT_MS,
        'Fetching active cycles'
      );
      
      if (!cycles.nodes.length) {
        return {
          content: [{
            type: 'text',
            text: 'No active sprint found for this team.'
          }]
        };
      }

      const currentCycle = cycles.nodes[0];
      
      // Get filtered issues in the current cycle with timeout
      const issues = await withTimeout(
        linearClient.issues({
          filter: {
            team: { id: { eq: params.teamId } },
            cycle: { id: { eq: currentCycle.id } },
            state: { name: { eq: params.status } },
            assignee: { id: { eq: viewer.id } }
          }
        }),
        API_TIMEOUT_MS,
        'Fetching filtered sprint issues'
      );

      debugLog(`Found ${issues.nodes.length} matching issues in current sprint`);

      if (issues.nodes.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No issues found with status "${params.status}" assigned to you in the current sprint.`
          }]
        };
      }

      // Process issues with timeout protection for each issue's state fetch
      const issueList = await Promise.all(
        issues.nodes.map(async (issue) => {
          const state = issue.state ? await withTimeout(
            issue.state,
            API_TIMEOUT_MS,
            `Fetching state for issue ${issue.id}`
          ) : null;
          return `${issue.identifier}: ${issue.title}\n  Status: ${state?.name ?? 'No status'}\n  URL: ${issue.url}`;
        })
      );

      return {
        content: [{
          type: 'text',
          text: `Current Sprint: ${currentCycle.name}\nStart: ${new Date(currentCycle.startsAt).toLocaleDateString()}\nEnd: ${new Date(currentCycle.endsAt).toLocaleDateString()}\n\nYour Issues with Status "${params.status}":\n\n${issueList.join('\n\n')}`
        }]
      };
    } catch (error) {
      handleError(error, 'Failed to filter sprint issues');
      throw error;
    }
  }
);

// Add new tool to get workflow states
server.tool(
  'linear_get_workflow_states',
  {
    teamId: z.string().describe('Team ID to get workflow states for')
  },
  async (params) => {
    try {
      debugLog('Fetching workflow states for team:', params.teamId);
      
      // Get the team's workflow states with timeout
      const team = await withTimeout(
        linearClient.team(params.teamId),
        API_TIMEOUT_MS,
        'Fetching team info'
      );
      
      const workflowStates = await withTimeout(
        linearClient.workflowStates({
          filter: {
            team: { id: { eq: params.teamId } }
          }
        }),
        API_TIMEOUT_MS,
        'Fetching workflow states'
      );
      
      if (!workflowStates.nodes.length) {
        return {
          content: [{
            type: 'text',
            text: 'No workflow states found for this team.'
          }]
        };
      }

      debugLog(`Found ${workflowStates.nodes.length} workflow states`);

      // Sort workflow states by position to maintain the correct order
      const sortedStates = [...workflowStates.nodes].sort((a, b) => a.position - b.position);
      
      const statesList = sortedStates.map(state => {
        return {
          id: state.id,
          name: state.name,
          description: state.description || 'No description',
          type: state.type,
          position: state.position
        };
      });

      return {
        content: [{
          type: 'text',
          text: `Team: ${team.name}\nWorkflow States:\n${JSON.stringify(statesList, null, 2)}`
        }]
      };
    } catch (error) {
      handleError(error, 'Failed to fetch workflow states');
      throw error;
    }
  }
);

// Add new tool to list all projects
server.tool(
  'linear_list_projects',
  {
    teamId: z.string().optional().describe('Optional team ID to filter projects by team'),
    limit: z.number().default(50).describe('Max number of projects to return')
  },
  async (params) => {
    try {
      debugLog('Fetching projects with params:', params);
      
      // Get projects with timeout
      let projects;
      
      if (params.teamId) {
        // If teamId is provided, first get the team
        const team = await withTimeout(
          linearClient.team(params.teamId),
          API_TIMEOUT_MS,
          'Fetching team'
        );
        
        // Then get projects for this team
        projects = await withTimeout(
          team.projects({ first: params.limit }),
          API_TIMEOUT_MS,
          'Fetching projects for team'
        );
      } else {
        // Get all projects
        projects = await withTimeout(
          linearClient.projects({ first: params.limit }),
          API_TIMEOUT_MS,
          'Fetching all projects'
        );
      }
      
      if (!projects.nodes.length) {
        return {
          content: [{
            type: 'text',
            text: params.teamId 
              ? `No projects found for team ID: ${params.teamId}.` 
              : 'No projects found.'
          }]
        };
      }

      debugLog(`Found ${projects.nodes.length} projects`);

      // Create a simplified list of projects with basic information
      const projectsList = projects.nodes.map(project => ({
        id: project.id,
        name: project.name,
        description: project.description || 'No description',
        url: project.url,
        startedAt: project.startedAt ? new Date(project.startedAt).toLocaleDateString() : 'Not set',
        targetDate: project.targetDate ? new Date(project.targetDate).toLocaleDateString() : 'Not set'
      }));

      return {
        content: [{
          type: 'text',
          text: `Projects (${projects.nodes.length}):\n${JSON.stringify(projectsList, null, 2)}`
        }]
      };
    } catch (error) {
      handleError(error, 'Failed to fetch projects');
      throw error;
    }
  }
);

// Create and configure transport
const transport = new StdioServerTransport();

transport.onerror = async (error: any) => {
  handleError(error, 'Transport error');
  if (connectionState.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    connectionState.reconnectAttempts++;
    debugLog(`Attempting reconnection (${connectionState.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    setTimeout(async () => {
      try {
        await server.connect(transport);
        connectionState.isConnected = true;
        debugLog('Reconnection successful');
      } catch (reconnectError) {
        handleError(reconnectError, 'Reconnection failed');
        if (connectionState.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          debugLog('Max reconnection attempts reached, shutting down');
          await shutdown();
        }
      }
    }, RECONNECT_DELAY_MS);
  } else {
    debugLog('Max reconnection attempts reached, shutting down');
    await shutdown();
  }
};

transport.onmessage = async (message: any) => {
  try {
    debugLog('Received message:', message?.method);
    
    if (message?.method === 'initialize') {
      debugLog('Handling initialize request');
      connectionState.isConnected = true;
      connectionState.lastHeartbeat = Date.now();
    } else if (message?.method === 'initialized') {
      debugLog('Connection fully initialized');
      connectionState.isConnected = true;
    } else if (message?.method === 'server/heartbeat') {
      connectionState.lastHeartbeat = Date.now();
      debugLog('Heartbeat received');
    }

    // Set up heartbeat check
    const heartbeatCheck = setInterval(() => {
      const timeSinceLastHeartbeat = Date.now() - connectionState.lastHeartbeat;
      if (timeSinceLastHeartbeat > HEARTBEAT_INTERVAL_MS * 2) {
        debugLog('No heartbeat received, attempting reconnection');
        clearInterval(heartbeatCheck);
        if (transport && transport.onerror) {
          transport.onerror(new Error('Heartbeat timeout'));
        }
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Clear heartbeat check on process exit
    process.on('beforeExit', () => {
      clearInterval(heartbeatCheck);
    });
  } catch (error) {
    handleError(error, 'Message handling error');
    throw error;
  }
};

// Handle graceful shutdown
const shutdown = async () => {
  debugLog('Shutting down gracefully...');
  
  // Close transport
  try {
    await transport.close();
    debugLog('Transport closed successfully');
  } catch (error) {
    handleError(error, 'Transport closure failed');
  }
  
  process.exit(0);
};

// Update signal handlers
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Add global error handlers
process.on('uncaughtException', (error: Error) => {
  handleError(error, 'Uncaught Exception');
  shutdown();
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown();
});

// Verify Linear API connection before starting server
try {
  debugLog('Verifying Linear API connection...');
  await withTimeout(linearClient.viewer, API_TIMEOUT_MS, 'Linear API connection check');
  debugLog('Linear API connection verified');
} catch (error) {
  handleError(error, 'Failed to verify Linear API connection');
  process.exit(1);
}

// Connect to transport with initialization handling
try {
  debugLog('Connecting to MCP transport...');
  
  await server.connect(transport);
  
  debugLog('MCP server connected and ready');
} catch (error) {
  handleError(error, 'Failed to connect MCP server');
  process.exit(1);
}

// Keep the process alive and handle errors
process.stdin.resume();
process.stdin.on('error', (error) => {
  handleError(error, 'stdin error');
});

process.stdout.on('error', (error) => {
  handleError(error, 'stdout error');
});
