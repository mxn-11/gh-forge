// The GraphQL v4 surface: a small but real parser and executor for the
// document shapes gh and github-mcp-server send — operations with variables,
// aliases, inline fragments, input objects, enum lists, introspection of the
// types the clients feature-detect, Relay node(id:) reads, cursor pagination,
// and the issue/pull-request mutations. Everything resolves against the same
// store as REST, so a mutation here is a REST read there.
//
// Global ids are opaque and stable: base64url of "v1:<Type>:<databaseId>".
// They are never the plain database id (a check asserts exactly that).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isoOf, VIEWER, type Forge, type IssueRec, type PullRec, type Repo } from './store.ts';
import { readBody, sendJson } from './http-util.ts';

// ---------------------------------------------------------------- global ids

export function globalId(type: string, databaseId: number): string {
  return Buffer.from(`v1:${type}:${databaseId}`, 'utf8').toString('base64url');
}

function parseGlobalId(id: string): { type: string; databaseId: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const match = /^v1:([A-Za-z]+):(\d+)$/.exec(text);
    if (match === null) return null;
    return { type: match[1] as string, databaseId: Number(match[2]) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (at < source.length) {
    const ch = source[at] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (source.startsWith('...', at)) {
      tokens.push({ kind: 'punct', value: '...' });
      at += 3;
      continue;
    }
    if ('{}()[]:@$=!|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(at + 3, end) });
        at = end + 3;
        continue;
      }
      let value = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\') {
          const esc = source[at + 1] as string;
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(at + 2, at + 6), 16));
            at += 6;
          } else {
            value += simple[esc] ?? esc;
            at += 2;
          }
        } else {
          value += source[at];
          at += 1;
        }
      }
      if (at >= source.length) throw new Error('unterminated string');
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (isNameStart(ch)) {
      const start = at;
      while (at < source.length && isNameChar(source[at] as string)) at += 1;
      tokens.push({ kind: 'name', value: source.slice(start, at) });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const start = at;
      if (source[at] === '-') at += 1;
      while (at < source.length && /[0-9]/.test(source[at] as string)) at += 1;
      let isFloat = false;
      if (source[at] === '.') {
        isFloat = true;
        at += 1;
        while (at < source.length && /[0-9]/.test(source[at] as string)) at += 1;
      }
      if (source[at] === 'e' || source[at] === 'E') {
        isFloat = true;
        at += 1;
        if (source[at] === '+' || source[at] === '-') at += 1;
        while (at < source.length && /[0-9]/.test(source[at] as string)) at += 1;
      }
      const text = source.slice(start, at);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number.parseInt(text, 10) });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in the document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class Parser {
  private readonly tokens: Token[];
  private at = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.at] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.at] as Token;
    this.at += 1;
    return token;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private eatPunct(value: string): boolean {
    if (!this.isPunct(value)) return false;
    this.at += 1;
    return true;
  }

  private expectPunct(value: string): void {
    if (!this.eatPunct(value)) throw new Error(`expected "${value}" in the document`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in the document');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      if (this.isPunct('{')) {
        operations.push({ type: 'query', name: null, variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        const variableDefaults = new Map<string, ValueNode>();
        if (this.isPunct('(')) {
          this.next();
          while (!this.isPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.eatPunct('=')) variableDefaults.set(varName, this.parseValue());
            this.skipDirectives();
          }
          this.next();
        }
        this.skipDirectives();
        operations.push({
          type: keyword === 'mutation' ? 'mutation' : 'query',
          name,
          variableDefaults,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('a fragment needs a type condition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition "${keyword}"`);
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.eatPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.eatPunct('!');
  }

  private skipDirectives(): void {
    while (this.eatPunct('@')) {
      this.expectName();
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.next();
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) selections.push(this.parseSelection());
    this.next();
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        const name = this.expectName();
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.eatPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.next();
    }
    this.skipDirectives();
    const selectionSet = this.isPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct('}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value in the document');
  }
}

// ---------------------------------------------------------------- schema tables (introspection)

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'isViewer'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'isPrivate', 'description',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'createdAt', 'updatedAt',
    'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'url', 'author', 'repository',
    'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'files', 'commits', 'url', 'author', 'createdAt', 'updatedAt', 'closedAt',
    'mergedAt', 'additions', 'deletions', 'changedFiles',
  ],
  Ref: ['id', 'name', 'prefix', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject'],
  IssueCommentEdge: ['cursor', 'node'],
  __Type: ['kind', 'name', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  OrderDirectionEnum: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- views and resolvers

interface View {
  __type: string;
  [key: string]: unknown;
}

const view = (type: string, props: Record<string, unknown>): View => ({ __type: type, ...props });

function repoView(repo: Repo): View {
  return view('Repository', { repo });
}

function issueView(repo: Repo, rec: IssueRec): View {
  return view('Issue', { repo, rec });
}

function pullView(repo: Repo, rec: PullRec): View {
  return view('PullRequest', { repo, rec });
}

function findIssueByDbId(forge: Forge, databaseId: number): { repo: Repo; rec: IssueRec } | null {
  for (const repo of forge.listRepos()) {
    for (const rec of repo.issues.values()) if (rec.id === databaseId) return { repo, rec };
  }
  return null;
}

function findPullByDbId(forge: Forge, databaseId: number): { repo: Repo; rec: PullRec } | null {
  for (const repo of forge.listRepos()) {
    for (const rec of repo.pulls.values()) if (rec.id === databaseId) return { repo, rec };
  }
  return null;
}

/** The cursor for a page position: opaque, and decodable only by us. */
function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: DocumentNode['fragments'];
  errors: { message: string }[];
}

type Resolver = (ctx: ExecCtx, source: View, args: Record<string, unknown>) => unknown;

const issueState = (rec: IssueRec): string => (rec.state === 'open' ? 'OPEN' : 'CLOSED');
const pullState = (rec: PullRec): string => (rec.merged ? 'MERGED' : rec.state === 'open' ? 'OPEN' : 'CLOSED');

function issueConnection(ctx: ExecCtx, repo: Repo, args: Record<string, unknown>): View {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction === 'ASC' ? 'asc' : 'desc';
  let list = [...repo.issues.values()];
  if (states !== null && states.length > 0) {
    list = list.filter((rec) => states.includes(issueState(rec)));
  }
  list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  return paginate(list, args, (rec) => issueView(repo, rec));
  void ctx;
}

function paginate<T>(list: readonly T[], args: Record<string, unknown>, toView: (item: T) => View): View {
  const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : list.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const marker = numberFromCursor(args.after);
    if (marker !== null) {
      const index = list.findIndex((item) => (item as { number: number }).number === marker);
      if (index >= 0) start = index + 1;
    }
  }
  const slice = list.slice(start, start + first);
  const nodes = slice.map(toView);
  const last = slice[slice.length - 1] as { number: number } | undefined;
  return view('Connection', {
    nodes,
    pageInfo: view('PageInfo', {
      hasNextPage: start + slice.length < list.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorOf((slice[0] as { number: number }).number) : null,
      endCursor: last === undefined ? null : cursorOf(last.number),
    }),
    totalCount: list.length,
  });
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => view('User', {}),
    repository: (ctx, _source, args) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== VIEWER.login) return null;
      const repo = ctx.forge.findRepo(owner, name);
      return repo === undefined ? null : repoView(repo);
    },
    node: (ctx, _source, args) => {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (parsed === null) return null;
      if (parsed.type === 'Repository') {
        const repo = ctx.forge.repoById(parsed.databaseId);
        return repo === undefined ? null : repoView(repo);
      }
      if (parsed.type === 'Issue') {
        const found = findIssueByDbId(ctx.forge, parsed.databaseId);
        return found === null ? null : issueView(found.repo, found.rec);
      }
      if (parsed.type === 'PullRequest') {
        const found = findPullByDbId(ctx.forge, parsed.databaseId);
        return found === null ? null : pullView(found.repo, found.rec);
      }
      return null;
    },
    __type: (_ctx, _source, args) => {
      const name = String(args.name ?? '');
      if (!(name in TYPE_FIELDS) && !(name in ENUM_VALUES)) return null;
      return view('__Type', { typeName: name });
    },
    __schema: () => view('__Schema', {}),
  },
  Mutation: {
    createIssue: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed !== null && parsed.type === 'Repository' ? ctx.forge.repoById(parsed.databaseId) : undefined;
      if (repo === undefined) throw new Error('createIssue: the repository id does not resolve');
      const rec = ctx.forge.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      return view('CreateIssuePayload', { issue: issueView(repo, rec) });
    },
    closeIssue: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      const found = parsed !== null && parsed.type === 'Issue' ? findIssueByDbId(ctx.forge, parsed.databaseId) : null;
      if (found === null) throw new Error('closeIssue: the issue id does not resolve');
      const rec = ctx.forge.updateIssue(found.repo, found.rec.number, { state: 'closed' });
      return view('CloseIssuePayload', { issue: issueView(found.repo, rec) });
    },
    createPullRequest: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed !== null && parsed.type === 'Repository' ? ctx.forge.repoById(parsed.databaseId) : undefined;
      if (repo === undefined) throw new Error('createPullRequest: the repository id does not resolve');
      const rec = ctx.forge.createPull(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      return view('CreatePullRequestPayload', { pullRequest: pullView(repo, rec) });
    },
    mergePullRequest: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      const found = parsed !== null && parsed.type === 'PullRequest' ? findPullByDbId(ctx.forge, parsed.databaseId) : null;
      if (found === null) throw new Error('mergePullRequest: the pull request id does not resolve');
      const method = String(input.mergeMethod ?? 'SQUASH');
      if (method !== 'SQUASH' && method !== 'MERGE') throw new Error(`mergePullRequest: merge method ${method} is not supported`);
      ctx.forge.mergePullSquash(found.repo, found.rec);
      return view('MergePullRequestPayload', { pullRequest: pullView(found.repo, found.rec) });
    },
    addComment: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      const found = parsed !== null && parsed.type === 'Issue' ? findIssueByDbId(ctx.forge, parsed.databaseId) : null;
      if (found === null) throw new Error('addComment: the subject id does not resolve to an issue');
      const comment = ctx.forge.addComment(found.repo, found.rec.number, String(input.body ?? ''));
      const node = view('IssueComment', {
        id: globalId('IssueComment', comment.id),
        databaseId: comment.id,
        body: comment.body,
      });
      return view('AddCommentPayload', { commentEdge: view('IssueCommentEdge', { node, cursor: cursorOf(found.rec.number) }) });
    },
  },
  User: {
    id: () => globalId('User', VIEWER.id),
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    url: () => `https://forge.invalid/${VIEWER.login}`,
    avatarUrl: () => 'https://forge.invalid/avatar.png',
    isViewer: () => true,
  },
  Repository: {
    id: (_ctx, source) => globalId('Repository', (source.repo as Repo).id),
    databaseId: (_ctx, source) => (source.repo as Repo).id,
    name: (_ctx, source) => (source.repo as Repo).name,
    nameWithOwner: (_ctx, source) => (source.repo as Repo).fullName,
    owner: () => view('User', {}),
    description: (_ctx, source) => (source.repo as Repo).description,
    isPrivate: (_ctx, source) => (source.repo as Repo).isPrivate,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasProjectsEnabled: () => true,
    hasWikiEnabled: () => true,
    url: (_ctx, source) => `https://forge.invalid/${(source.repo as Repo).fullName}`,
    createdAt: (_ctx, source) => isoOf((source.repo as Repo).createdSec),
    updatedAt: (_ctx, source) => isoOf((source.repo as Repo).updatedSec),
    stargazerCount: () => 0,
    forkCount: () => 0,
    defaultBranchRef: (_ctx, source) => {
      const repo = source.repo as Repo;
      if (repo.branchTip(repo.defaultBranch) === undefined) return null;
      return view('Ref', { name: repo.defaultBranch, prefix: 'refs/heads/' });
    },
    issue: (_ctx, source, args) => {
      const repo = source.repo as Repo;
      const rec = repo.issues.get(Number(args.number));
      return rec === undefined ? null : issueView(repo, rec);
    },
    issues: (ctx, source, args) => issueConnection(ctx, source.repo as Repo, args),
    pullRequest: (_ctx, source, args) => {
      const repo = source.repo as Repo;
      const rec = repo.pulls.get(Number(args.number));
      return rec === undefined ? null : pullView(repo, rec);
    },
    pullRequests: (ctx, source, args) => {
      const repo = source.repo as Repo;
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      let list = [...repo.pulls.values()];
      if (states !== null && states.length > 0) list = list.filter((rec) => states.includes(pullState(rec)));
      list.sort((a, b) => b.number - a.number);
      const connection = paginate(list, args, (rec) => pullView(repo, rec));
      connection.__type = 'PullRequestConnection';
      return connection;
      void ctx;
    },
  },
  Issue: {
    id: (_ctx, source) => globalId('Issue', (source.rec as IssueRec).id),
    databaseId: (_ctx, source) => (source.rec as IssueRec).id,
    number: (_ctx, source) => (source.rec as IssueRec).number,
    title: (_ctx, source) => (source.rec as IssueRec).title,
    state: (_ctx, source) => issueState(source.rec as IssueRec),
    body: (_ctx, source) => (source.rec as IssueRec).body,
    url: (_ctx, source) => `https://forge.invalid/${(source.repo as Repo).fullName}/issues/${(source.rec as IssueRec).number}`,
    author: () => view('User', {}),
    repository: (_ctx, source) => repoView(source.repo as Repo),
    createdAt: (_ctx, source) => isoOf((source.rec as IssueRec).createdSec),
    updatedAt: (_ctx, source) => isoOf((source.rec as IssueRec).updatedSec),
    closedAt: (_ctx, source) => {
      const rec = source.rec as IssueRec;
      return rec.state === 'closed' ? isoOf(rec.updatedSec) : null;
    },
    labels: (_ctx, source) => {
      const rec = source.rec as IssueRec;
      return view('Connection', { nodes: rec.labelNames.map((name) => view('Label', { name })), pageInfo: view('PageInfo', { hasNextPage: false, endCursor: null }), totalCount: rec.labelNames.length });
    },
    comments: (_ctx, source) => {
      const rec = source.rec as IssueRec;
      return view('Connection', {
        nodes: rec.comments.map((comment) => view('IssueComment', { id: globalId('IssueComment', comment.id), databaseId: comment.id, body: comment.body })),
        pageInfo: view('PageInfo', { hasNextPage: false, endCursor: null }),
        totalCount: rec.comments.length,
      });
    },
  },
  PullRequest: {
    id: (_ctx, source) => globalId('PullRequest', (source.rec as PullRec).id),
    databaseId: (_ctx, source) => (source.rec as PullRec).id,
    number: (_ctx, source) => (source.rec as PullRec).number,
    title: (_ctx, source) => (source.rec as PullRec).title,
    body: (_ctx, source) => (source.rec as PullRec).body,
    state: (_ctx, source) => pullState(source.rec as PullRec),
    merged: (_ctx, source) => (source.rec as PullRec).merged,
    mergeable: (ctx, source) => {
      const rec = source.rec as PullRec;
      if (rec.state !== 'open') return 'UNKNOWN';
      return ctx.forge.pullMergeable(source.repo as Repo, rec) ? 'MERGEABLE' : 'CONFLICTING';
    },
    headRefName: (_ctx, source) => (source.rec as PullRec).headRef,
    baseRefName: (_ctx, source) => (source.rec as PullRec).baseRef,
    url: (_ctx, source) => `https://forge.invalid/${(source.repo as Repo).fullName}/pull/${(source.rec as PullRec).number}`,
    author: () => view('User', {}),
    createdAt: (_ctx, source) => isoOf((source.rec as PullRec).createdSec),
    updatedAt: (_ctx, source) => isoOf((source.rec as PullRec).updatedSec),
    closedAt: (_ctx, source) => {
      const rec = source.rec as PullRec;
      return rec.state === 'closed' ? isoOf(rec.updatedSec) : null;
    },
    mergedAt: (_ctx, source) => {
      const rec = source.rec as PullRec;
      return rec.mergedAtSec === null ? null : isoOf(rec.mergedAtSec);
    },
    files: (ctx, source, args) => {
      const repo = source.repo as Repo;
      const rec = source.rec as PullRec;
      const changes = ctx.forge.pullFiles(repo, rec);
      const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : changes.length;
      return view('PullRequestChangedFileConnection', {
        nodes: changes.slice(0, first).map((change) => view('PullRequestChangedFile', { path: change.path, additions: change.additions, deletions: change.deletions, changeType: change.status.toUpperCase() })),
        pageInfo: view('PageInfo', { hasNextPage: changes.length > first, endCursor: null }),
        totalCount: changes.length,
      });
    },
    additions: (ctx, source) => ctx.forge.pullFiles(source.repo as Repo, source.rec as PullRec).reduce((sum, change) => sum + change.additions, 0),
    deletions: (ctx, source) => ctx.forge.pullFiles(source.repo as Repo, source.rec as PullRec).reduce((sum, change) => sum + change.deletions, 0),
    changedFiles: (ctx, source) => ctx.forge.pullFiles(source.repo as Repo, source.rec as PullRec).length,
    commits: () => view('Connection', { nodes: [], pageInfo: view('PageInfo', { hasNextPage: false, endCursor: null }), totalCount: 0 }),
  },
  Ref: {
    id: (_ctx, source) => globalId('Ref', 1),
    name: (_ctx, source) => source.name as string,
    prefix: (_ctx, source) => (source.prefix as string) ?? 'refs/heads/',
    target: () => null,
  },
  __Type: {
    kind: (_ctx, source) => ((source.typeName as string) in ENUM_VALUES ? 'ENUM' : 'OBJECT'),
    name: (_ctx, source) => source.typeName as string,
    description: () => null,
    fields: (_ctx, source) => {
      const names = TYPE_FIELDS[source.typeName as string] ?? [];
      return names.map((name) => view('__Field', { fieldName: name }));
    },
    enumValues: (_ctx, source) => {
      const names = ENUM_VALUES[source.typeName as string] ?? [];
      return names.map((name) => view('__EnumValue', { valueName: name }));
    },
    possibleTypes: () => [],
    inputFields: () => [],
    ofType: () => null,
  },
  __Field: {
    name: (_ctx, source) => source.fieldName as string,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
    type: () => null,
  },
  __EnumValue: {
    name: (_ctx, source) => source.valueName as string,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
};

// ---------------------------------------------------------------- executor

function resolveValue(node: ValueNode, ctx: ExecCtx, defaults: Map<string, ValueNode>): unknown {
  switch (node.kind) {
    case 'variable': {
      if (node.name in ctx.variables) return ctx.variables[node.name];
      const fallback = defaults.get(node.name);
      return fallback === undefined ? undefined : resolveValue(fallback, ctx, defaults);
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, ctx, defaults));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, ctx, defaults);
      return out;
    }
  }
}

function isView(value: unknown): value is View {
  return typeof value === 'object' && value !== null && typeof (value as View).__type === 'string';
}

function executeSelectionSet(ctx: ExecCtx, source: View, selections: readonly SelectionNode[], defaults: Map<string, ValueNode>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === source.__type || selection.typeCondition === 'Node') {
        Object.assign(out, executeSelectionSet(ctx, source, selection.selectionSet, defaults));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === source.__type)) {
        Object.assign(out, executeSelectionSet(ctx, source, fragment.selectionSet, defaults));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = source.__type;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = resolveValue(arg.value, ctx, defaults);
    const resolver = RESOLVERS[source.__type]?.[selection.name];
    let value: unknown;
    if (resolver !== undefined) {
      try {
        value = resolver(ctx, source, args);
      } catch (error) {
        ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
        value = null;
      }
    } else if (selection.name in source) {
      value = source[selection.name];
    } else {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${source.__type}'` });
      value = null;
    }
    out[key] = completeValue(ctx, value, selection, defaults);
  }
  return out;
}

function completeValue(ctx: ExecCtx, value: unknown, selection: FieldNode, defaults: Map<string, ValueNode>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, selection, defaults));
  if (isView(value)) {
    if (selection.selectionSet === null) return value;
    return executeSelectionSet(ctx, value, selection.selectionSet, defaults);
  }
  return value;
}

function executeOperation(forge: Forge, document: DocumentNode, operation: OperationNode, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecCtx = { forge, variables, fragments: document.fragments, errors: [] };
  const root = view(operation.type === 'mutation' ? 'Mutation' : 'Query', {});
  const data = executeSelectionSet(ctx, root, operation.selectionSet, operation.variableDefaults);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

// ---------------------------------------------------------------- the handler

interface OperationRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function runOne(forge: Forge, request: OperationRequest): Record<string, unknown> {
  if (typeof request.query !== 'string' || request.query === '') {
    return { errors: [{ message: 'a GraphQL request needs a query string' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(request.query).parseDocument();
  } catch (error) {
    return { errors: [{ message: `could not parse the document: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  if (document.operations.length === 0) return { errors: [{ message: 'the document holds no operation' }] };
  let operation = document.operations[0] as OperationNode;
  if (typeof request.operationName === 'string' && request.operationName !== '') {
    const named = document.operations.find((candidate) => candidate.name === request.operationName);
    if (named !== undefined) operation = named;
  } else if (document.operations.length > 1) {
    return { errors: [{ message: 'the document holds several operations and names none' }] };
  }
  const variables = (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Record<string, unknown>;
  return executeOperation(forge, document, operation, variables);
}

/** Handle one POST /api/graphql (single operation or a batched array). */
export async function handleGraphql(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'the request body is not JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => runOne(forge, (entry ?? {}) as OperationRequest));
    sendJson(res, 200, results);
    return;
  }
  const result = runOne(forge, (parsed ?? {}) as OperationRequest);
  sendJson(res, 200, result);
}
