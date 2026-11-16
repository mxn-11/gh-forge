// The MCP surface: Model Context Protocol over Streamable HTTP at /mcp,
// JSON-RPC 2.0 in and out. The server speaks the 2026-07-28 revision
// (server/discover, no handshake, no session) and still answers the legacy
// initialize handshake for older clients. The six tools are the
// github-mcp-server core set and act on the same store as REST and GraphQL —
// an issue created here is the same issue REST reads, with the same id.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, type Forge } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { HttpError, readBody } from './http-util.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const CAPABILITIES = { tools: {} };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

// ---------------------------------------------------------------- the tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  run: (forge: Forge, args: Record<string, unknown>) => Record<string, unknown>;
}

const str = (description: string): { type: string; description: string } => ({ type: 'string', description });

function argString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function repoOf(forge: Forge, args: Record<string, unknown>) {
  return forge.getRepo(argString(args, 'owner') || VIEWER.login, argString(args, 'repo'));
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('The repository name.'),
        description: str('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (forge, args) => {
      const repo = forge.createRepo({
        name: argString(args, 'name'),
        description: argString(args, 'description'),
        isPrivate: args.private === true,
      });
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: str('The repository owner login.'), repo: str('The repository name.') },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => repoJson(repoOf(forge, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        title: str('The issue title.'),
        body: str('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const rec = forge.createIssue(repo, { title: argString(args, 'title'), body: argString(args, 'body') });
      return issueJson(repo, rec);
    },
  },
  {
    name: 'list_issues',
    description: 'List a repository’s issues, optionally filtered by state (open, closed or all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        state: str('Filter by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const stateParam = argString(args, 'state');
      const state = stateParam === 'closed' || stateParam === 'all' ? stateParam : 'open';
      const issues = forge.listIssues(repo, { state, direction: 'desc' });
      return { issues: issues.map((rec) => issueJson(repo, rec)) };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        title: str('The pull request title.'),
        body: str('The pull request body.'),
        head: str('The head branch name.'),
        base: str('The base branch name.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const rec = forge.createPull(repo, {
        title: argString(args, 'title'),
        body: argString(args, 'body'),
        head: argString(args, 'head'),
        base: argString(args, 'base'),
      });
      return pullJson(forge, repo, rec);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const rec = forge.getPull(repo, number);
      forge.mergePullSquash(repo, rec);
      return pullJson(forge, repo, rec);
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** The tools/list payload, built once so two calls answer byte-identically. */
const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
};

// ---------------------------------------------------------------- JSON-RPC

interface RpcRequest {
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function dispatch(forge: Forge, request: RpcRequest): Record<string, unknown> | null {
  const id = (request.id ?? null) as string | number | null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  // Notifications (no id) are accepted and answered with silence.
  if (request.id === undefined) return null;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: CAPABILITIES, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST_RESULT);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS_BY_NAME.get(name);
      if (tool === undefined) return rpcError(id, INVALID_PARAMS, `unknown tool: ${name === '' ? '(unnamed)' : name}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) return rpcError(id, INVALID_PARAMS, `missing required argument(s): ${missing.join(', ')}`);
      try {
        return rpcResult(id, toolResult(tool.run(forge, args)));
      } catch (error) {
        if (error instanceof HttpError) return rpcResult(id, toolErrorResult(error.message));
        return rpcResult(id, toolErrorResult(error instanceof Error ? error.message : String(error)));
      }
    }
    default:
      if (method === '') return rpcError(id, INVALID_REQUEST, 'the request carries no method');
      return rpcError(id, METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}

/** Handle one POST /mcp. */
export async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    const body = JSON.stringify(rpcError(null, PARSE_ERROR, 'Parse error'));
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => dispatch(forge, (entry ?? {}) as RpcRequest)).filter((entry) => entry !== null);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(results));
    return;
  }
  const result = dispatch(forge, (parsed ?? {}) as RpcRequest);
  if (result === null) {
    // A notification: accepted, no body owed.
    res.writeHead(202);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
}
