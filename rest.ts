// The REST v3 surface: repositories, contents, branches, commits, labels,
// issues, comments and pull requests, in GitHub's shapes. Every handler works
// on the one store in store.ts, so a file written here is a git object the
// smart-HTTP surface can serve, and a branch made here can be pushed to.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getObject, parseCommit, parseTree } from './gitobj.ts';
import {
  isoOf,
  VIEWER,
  type CommentRec,
  type Forge,
  type IssueRec,
  type LabelRec,
  type PullRec,
  type Repo,
} from './store.ts';
import {
  HttpError,
  notFound,
  originOf,
  parseJsonBody,
  readBody,
  sendBuffer,
  sendEmpty,
  sendJson,
  unprocessable,
  type ParsedUrl,
} from './http-util.ts';

const FAKE_ORIGIN = 'https://forge.invalid';

// ---------------------------------------------------------------- shapes

/** The viewer's JSON shape: one shared object (callers only embed it). */
const USER_JSON: Record<string, unknown> = {
  login: VIEWER.login,
  id: VIEWER.id,
  type: 'User',
  name: VIEWER.name,
  email: VIEWER.email,
  site_admin: false,
  url: `${FAKE_ORIGIN}/api/v3/users/${VIEWER.login}`,
  html_url: `${FAKE_ORIGIN}/${VIEWER.login}`,
};

export function userJson(): Record<string, unknown> {
  return USER_JSON;
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoOf(repo.createdSec),
    updated_at: isoOf(repo.updatedSec),
    pushed_at: isoOf(repo.updatedSec),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: repo.issues.size + repo.pulls.size,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    url: `${FAKE_ORIGIN}/api/v3/repos/${repo.fullName}`,
    html_url: `${FAKE_ORIGIN}/${repo.fullName}`,
    git_url: `git://forge.invalid/${repo.fullName}.git`,
    ssh_url: `git@forge.invalid:${repo.fullName}.git`,
    clone_url: `${FAKE_ORIGIN}/${repo.fullName}.git`,
  };
}

export function labelJson(label: LabelRec): Record<string, unknown> {
  return { name: label.name, color: label.color, default: false, description: label.description };
}

export function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labelNames.map((name) => {
      const label = repo.labels.get(name.toLowerCase());
      return label === undefined ? { name, color: 'ededed', default: false, description: null } : labelJson(label);
    }),
    user: userJson(),
    comments: issue.comments.length,
    created_at: isoOf(issue.createdSec),
    updated_at: isoOf(issue.updatedSec),
    closed_at: issue.state === 'closed' ? isoOf(issue.updatedSec) : null,
    url: `${FAKE_ORIGIN}/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    html_url: `${FAKE_ORIGIN}/${repo.fullName}/issues/${issue.number}`,
    repository_url: `${FAKE_ORIGIN}/api/v3/repos/${repo.fullName}`,
  };
}

export function commentJson(repo: Repo, issueNumber: number, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(),
    created_at: isoOf(comment.createdSec),
    updated_at: isoOf(comment.updatedSec),
    url: `${FAKE_ORIGIN}/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
    html_url: `${FAKE_ORIGIN}/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    issue_url: `${FAKE_ORIGIN}/api/v3/repos/${repo.fullName}/issues/${issueNumber}`,
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRec): Record<string, unknown> {
  forge.syncPullTips(repo, pull);
  const side = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${VIEWER.login}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoJson(repo),
  });
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: side(pull.headRef, pull.headSha),
    base: side(pull.baseRef, pull.baseSha),
    user: userJson(),
    created_at: isoOf(pull.createdSec),
    updated_at: isoOf(pull.updatedSec),
    closed_at: pull.state === 'closed' ? isoOf(pull.updatedSec) : null,
    merged_at: pull.mergedAtSec === null ? null : isoOf(pull.mergedAtSec),
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    url: `${FAKE_ORIGIN}/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `${FAKE_ORIGIN}/${repo.fullName}/pull/${pull.number}`,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const obj = getObject(repo.objects, sha);
  const commit = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const identity = (who: { name: string; email: string; ts: number } | undefined): Record<string, unknown> => ({
    name: who?.name ?? '',
    email: who?.email ?? '',
    date: isoOf(who?.ts ?? 0),
  });
  return {
    sha,
    commit: {
      author: identity(commit?.author),
      committer: identity(commit?.committer),
      message: commit?.message ?? '',
      tree: { sha: commit?.tree ?? '' },
      comment_count: 0,
    },
    parents: (commit?.parents ?? []).map((parent) => ({ sha: parent })),
    url: `${FAKE_ORIGIN}/api/v3/repos/${repo.fullName}/commits/${sha}`,
    html_url: `${FAKE_ORIGIN}/${repo.fullName}/commit/${sha}`,
    author: null,
    committer: null,
  };
}

/**
 * The serialized body of one issue, cached per record: the read workload
 * hammers a single issue thousands of times, and an issue's JSON only changes
 * when the issue itself does — the stamp covers every mutation path (PATCH
 * bumps updatedSec and state; a comment changes the count).
 */
const issueBodyCache = new WeakMap<IssueRec, { stamp: string; body: Buffer }>();

function issueBodyBuffer(repo: Repo, issue: IssueRec): Buffer {
  const stamp = `${issue.updatedSec}|${issue.state}|${issue.comments.length}|${issue.title.length}`;
  const cached = issueBodyCache.get(issue);
  if (cached !== undefined && cached.stamp === stamp) return cached.body;
  const body = Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8');
  issueBodyCache.set(issue, { stamp, body });
  return body;
}

function commitSummaryJson(repo: Repo, sha: string): Record<string, unknown> {
  const full = commitJson(repo, sha);
  const commit = full.commit as Record<string, unknown>;
  return {
    sha,
    author: commit.author,
    committer: commit.committer,
    message: commit.message,
    tree: commit.tree,
    parents: full.parents,
    url: full.url,
    html_url: full.html_url,
  };
}

// ---------------------------------------------------------------- pagination

interface Page {
  items: unknown[];
  link: string | null;
}

/** Slice `items` by page/per_page and build the Link header (next/last/prev/first). */
function paginate(req: IncomingMessage, parsed: ParsedUrl, items: readonly unknown[]): Page {
  const perPageRaw = Number(parsed.query.get('per_page') ?? 30);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(parsed.query.get('page') ?? 1);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const urlFor = (p: number): string => {
    const query = new URLSearchParams(parsed.query);
    query.set('page', String(p));
    query.set('per_page', String(perPage));
    return `${originOf(req)}${parsed.path}?${query.toString()}`;
  };
  const links: string[] = [];
  if (page < lastPage) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`, `<${urlFor(lastPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(page - 1)}>; rel="prev"`, `<${urlFor(1)}>; rel="first"`);
  }
  return { items: slice, link: links.length === 0 ? null : links.join(', ') };
}

function sendPage(res: ServerResponse, page: Page): void {
  sendJson(res, 200, page.items, page.link === null ? {} : { link: page.link });
}

// ---------------------------------------------------------------- contents helpers

/** Walk a tree to the entry at `path` (file or directory), if it exists. */
function treeEntryAt(repo: Repo, rootTreeSha: string, path: string): { type: 'file' | 'dir'; sha: string; size: number } | null {
  const parts = path.split('/').filter((part) => part !== '');
  let current = rootTreeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const tree = getObject(repo.objects, current);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    if (i === parts.length - 1) {
      if (isDir) return { type: 'dir', sha: entry.sha, size: 0 };
      const blob = getObject(repo.objects, entry.sha);
      return { type: 'file', sha: entry.sha, size: blob?.data.length ?? 0 };
    }
    if (!isDir) return null;
    current = entry.sha;
  }
  return { type: 'dir', sha: rootTreeSha, size: 0 };
}

/** The commit sha a contents `ref` names: a branch, or a raw commit sha. */
function resolveRef(repo: Repo, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '') return repo.branchTip(repo.defaultBranch);
  const branch = repo.branchTip(ref);
  if (branch !== undefined) return branch;
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const obj = getObject(repo.objects, ref.toLowerCase());
    if (obj !== undefined && obj.type === 'commit') return ref.toLowerCase();
  }
  return undefined;
}

function contentsFileJson(repo: Repo, path: string, sha: string): Record<string, unknown> {
  const blob = getObject(repo.objects, sha);
  const bytes = blob?.data ?? Buffer.alloc(0);
  const name = path.slice(path.lastIndexOf('/') + 1);
  return {
    name,
    path,
    sha,
    size: bytes.length,
    type: 'file',
    encoding: 'base64',
    content: bytes.toString('base64'),
    url: `${FAKE_ORIGIN}/api/v3/repos/${repo.fullName}/contents/${path}`,
    html_url: `${FAKE_ORIGIN}/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
    git_url: `${FAKE_ORIGIN}/api/v3/repos/${repo.fullName}/git/blobs/${sha}`,
    download_url: `${FAKE_ORIGIN}/${repo.fullName}/raw/${repo.defaultBranch}/${path}`,
  };
}

function contentsPutResponse(repo: Repo, path: string, blobSha: string, commitSha: string): Record<string, unknown> {
  const blob = getObject(repo.objects, blobSha);
  const name = path.slice(path.lastIndexOf('/') + 1);
  return {
    content: {
      name,
      path,
      sha: blobSha,
      size: blob?.data.length ?? 0,
      type: 'file',
      encoding: 'base64',
      url: `${FAKE_ORIGIN}/api/v3/repos/${repo.fullName}/contents/${path}`,
      html_url: `${FAKE_ORIGIN}/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
      git_url: `${FAKE_ORIGIN}/api/v3/repos/${repo.fullName}/git/blobs/${blobSha}`,
      download_url: `${FAKE_ORIGIN}/${repo.fullName}/raw/${repo.defaultBranch}/${path}`,
    },
    commit: commitSummaryJson(repo, commitSha),
  };
}

// ---------------------------------------------------------------- the router

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseNumber(segment: string): number {
  const value = Number(segment);
  if (!Number.isInteger(value) || value < 1) throw notFound('Not Found');
  return value;
}

/** Handle one /api/v3 request. `segments` are the path parts after /api/v3. */
export async function handleRest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  segments: readonly string[],
  parsed: ParsedUrl,
): Promise<void> {
  const method = req.method ?? 'GET';
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const body: Record<string, unknown> = needsBody ? parseJsonBody(await readBody(req)) : {};

  // Root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') throw notFound('Not Found');
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', user_repositories_url: '/api/v3/user/repos', repository_url: '/api/v3/repos/{owner}/{repo}' },
      { 'x-oauth-scopes': 'repo, read:org, write:org' },
    );
    return;
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') throw notFound('Not Found');
    sendJson(res, 200, { installed_version: '1.0.0', hooks: [], git: {}, api: {}, pages: {}, importer: {}, actions: {}, packages: {} });
    return;
  }

  // The viewer.
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') throw notFound('Not Found');
    sendJson(res, 200, userJson());
    return;
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      sendPage(res, paginate(req, parsed, forge.listRepos().map((repo) => repoJson(repo))));
      return;
    }
    if (method === 'POST') {
      const repo = forge.createRepo({
        name: asString(body.name) ?? '',
        description: asString(body.description) ?? '',
        isPrivate: asBool(body.private) ?? false,
        defaultBranch: asString(body.default_branch),
      });
      sendJson(res, 201, repoJson(repo));
      return;
    }
    throw notFound('Not Found');
  }

  if (segments[0] !== 'repos' || segments.length < 3) throw notFound('Not Found');
  const owner = segments[1] as string;
  const name = segments[2] as string;
  const repo = forge.getRepo(owner, name); // 404 for foreign owners and misses
  const tail = segments.slice(3);

  // The repository itself.
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const description = asString(body.description);
      if (description !== undefined) repo.description = description;
      const isPrivate = asBool(body.private);
      if (isPrivate !== undefined) repo.isPrivate = isPrivate;
      const defaultBranch = asString(body.default_branch);
      if (defaultBranch !== undefined && defaultBranch !== '') repo.defaultBranch = defaultBranch;
      repo.updatedSec = forge.stamp();
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      sendEmpty(res, 204);
      return;
    }
    throw notFound('Not Found');
  }

  // Branches and commits.
  if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    sendPage(res, paginate(req, parsed, branches));
    return;
  }
  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    const start = resolveRef(repo, parsed.query.get('sha') ?? undefined);
    if (start === undefined) throw new HttpError(409, 'Git Repository is empty.');
    const shas = forge.listCommits(repo, start);
    sendPage(res, paginate(req, parsed, shas.map((sha) => commitJson(repo, sha))));
    return;
  }
  if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2 && method === 'POST') {
    const ref = asString(body.ref) ?? '';
    const sha = (asString(body.sha) ?? '').toLowerCase();
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) throw unprocessable('Validation failed: ref and sha are required');
    forge.createRef(repo, ref, sha);
    const target = getObject(repo.objects, sha);
    sendJson(res, 201, { ref, object: { sha, type: target?.type ?? 'commit' } });
    return;
  }

  // Contents.
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') {
      const tip = resolveRef(repo, parsed.query.get('ref') ?? undefined);
      if (tip === undefined) throw notFound('Not Found');
      const commit = getObject(repo.objects, tip);
      if (commit === undefined || commit.type !== 'commit') throw notFound('Not Found');
      const treeSha = parseCommit(commit.data).tree;
      if (path === '') {
        const rootTree = getObject(repo.objects, treeSha);
        if (rootTree === undefined) throw notFound('Not Found');
        const entries = parseTree(rootTree.data).map((entry) => {
          const isDir = entry.mode === '40000' || entry.mode === '040000';
          const blob = isDir ? undefined : getObject(repo.objects, entry.sha);
          return {
            name: entry.name,
            path: entry.name,
            sha: entry.sha,
            size: isDir ? 0 : (blob?.data.length ?? 0),
            type: isDir ? 'dir' : 'file',
          };
        });
        sendJson(res, 200, entries);
        return;
      }
      const found = treeEntryAt(repo, treeSha, path);
      if (found === null) throw notFound('Not Found');
      if (found.type === 'file') {
        sendJson(res, 200, contentsFileJson(repo, path, found.sha));
        return;
      }
      const dirTree = getObject(repo.objects, found.sha);
      if (dirTree === undefined) throw notFound('Not Found');
      const entries = parseTree(dirTree.data).map((entry) => {
        const isDir = entry.mode === '40000' || entry.mode === '040000';
        const blob = isDir ? undefined : getObject(repo.objects, entry.sha);
        return {
          name: entry.name,
          path: `${path}/${entry.name}`,
          sha: entry.sha,
          size: isDir ? 0 : (blob?.data.length ?? 0),
          type: isDir ? 'dir' : 'file',
        };
      });
      sendJson(res, 200, entries);
      return;
    }
    if (method === 'PUT') {
      const message = asString(body.message);
      const content = asString(body.content);
      if (message === undefined || content === undefined) throw unprocessable('Validation failed: message and content are required');
      const branch = asString(body.branch) ?? repo.defaultBranch;
      const bytes = Buffer.from(content, 'base64');
      const current = repo.filesAt(repo.branchTip(branch)).get(path);
      const givenSha = asString(body.sha)?.toLowerCase();
      if (current !== undefined) {
        if (givenSha === undefined) throw unprocessable('Validation failed: sha is required when updating a file');
        if (givenSha !== current.sha) throw new HttpError(409, `${path} does not match ${givenSha}`);
      } else if (givenSha !== undefined) {
        throw unprocessable('Validation failed: sha supplied for a file that does not exist');
      }
      const commitSha = forge.commitFiles(repo, branch, new Map([[path, bytes]]), message);
      const blobSha = repo.filesAt(repo.branchTip(branch)).get(path)?.sha as string;
      sendJson(res, current === undefined ? 201 : 200, contentsPutResponse(repo, path, blobSha, commitSha));
      return;
    }
    if (method === 'DELETE') {
      const message = asString(body.message) ?? 'Delete file';
      const branch = asString(body.branch) ?? repo.defaultBranch;
      const current = repo.filesAt(repo.branchTip(branch)).get(path);
      if (current === undefined) throw notFound('Not Found');
      const givenSha = asString(body.sha)?.toLowerCase();
      if (givenSha !== undefined && givenSha !== current.sha) throw new HttpError(409, `${path} does not match ${givenSha}`);
      const commitSha = forge.commitFiles(repo, branch, new Map([[path, null]]), message);
      sendJson(res, 200, { content: null, commit: commitSummaryJson(repo, commitSha) });
      return;
    }
    throw notFound('Not Found');
  }

  // Labels.
  if (tail[0] === 'labels' && tail.length === 1) {
    if (method === 'POST') {
      const label = forge.createLabel(repo, asString(body.name) ?? '', asString(body.color) ?? '', asString(body.description) ?? null);
      sendJson(res, 201, labelJson(label));
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(label)));
      return;
    }
    throw notFound('Not Found');
  }
  if (tail[0] === 'labels' && tail.length === 2 && method === 'GET') {
    const label = forge.labelByName(repo, tail[1] as string);
    if (label === undefined) throw notFound('Not Found');
    sendJson(res, 200, labelJson(label));
    return;
  }

  // Issues and their comments.
  if (tail[0] === 'issues' && tail.length === 1) {
    if (method === 'POST') {
      const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
      const issue = forge.createIssue(repo, { title: asString(body.title) ?? '', body: asString(body.body) ?? '', labels });
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const stateParam = parsed.query.get('state') ?? 'open';
      const state = stateParam === 'closed' || stateParam === 'all' ? stateParam : 'open';
      const direction = parsed.query.get('direction') === 'asc' ? 'asc' : 'desc';
      const issues = forge.listIssues(repo, { state, direction });
      sendPage(res, paginate(req, parsed, issues.map((issue) => issueJson(repo, issue))));
      return;
    }
    throw notFound('Not Found');
  }
  if (tail[0] === 'issues' && tail.length >= 2) {
    const number = parseNumber(tail[1] as string);
    if (tail.length === 2) {
      if (method === 'GET') {
        const issue = forge.getIssue(repo, number);
        sendBuffer(res, 200, issueBodyBuffer(repo, issue), 'application/json');
        return;
      }
      if (method === 'PATCH') {
        const stateParam = asString(body.state);
        const issue = forge.updateIssue(repo, number, {
          state: stateParam === 'closed' || stateParam === 'open' ? stateParam : undefined,
          title: asString(body.title),
          body: asString(body.body),
        });
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      throw notFound('Not Found');
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (method === 'POST') {
        const comment = forge.addComment(repo, number, asString(body.body) ?? '');
        sendJson(res, 201, commentJson(repo, number, comment));
        return;
      }
      if (method === 'GET') {
        const issue = forge.getIssue(repo, number);
        sendPage(res, paginate(req, parsed, issue.comments.map((comment) => commentJson(repo, number, comment))));
        return;
      }
      throw notFound('Not Found');
    }
    throw notFound('Not Found');
  }

  // Pull requests.
  if (tail[0] === 'pulls' && tail.length === 1) {
    if (method === 'POST') {
      const headRaw = asString(body.head) ?? '';
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const pull = forge.createPull(repo, {
        title: asString(body.title) ?? '',
        body: asString(body.body) ?? '',
        head,
        base: asString(body.base) ?? repo.defaultBranch,
      });
      sendJson(res, 201, pullJson(forge, repo, pull));
      return;
    }
    if (method === 'GET') {
      const stateParam = parsed.query.get('state') ?? 'open';
      const state = stateParam === 'closed' || stateParam === 'all' ? stateParam : 'open';
      const pulls = forge.listPulls(repo, state);
      sendPage(res, paginate(req, parsed, pulls.map((pull) => pullJson(forge, repo, pull))));
      return;
    }
    throw notFound('Not Found');
  }
  if (tail[0] === 'pulls' && tail.length >= 2) {
    const number = parseNumber(tail[1] as string);
    if (tail.length === 2 && method === 'GET') {
      sendJson(res, 200, pullJson(forge, repo, forge.getPull(repo, number)));
      return;
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      const pull = forge.getPull(repo, number);
      const files = forge.pullFiles(repo, pull).map((change) => ({
        filename: change.path,
        sha: change.sha ?? '',
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
      }));
      sendPage(res, paginate(req, parsed, files));
      return;
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      const pull = forge.getPull(repo, number); // 404 for an unknown pull
      const mergeMethod = asString(body.merge_method) ?? 'merge';
      if (mergeMethod === 'squash' || mergeMethod === 'merge') {
        const result = forge.mergePullSquash(repo, pull);
        sendJson(res, 200, { sha: result.sha, merged: true, message: result.message });
        return;
      }
      throw new HttpError(405, `Merge method "${mergeMethod}" is not supported`);
    }
    throw notFound('Not Found');
  }

  throw notFound('Not Found');
}
