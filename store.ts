// The forge's state and rules, with no HTTP in it: repositories over one git
// object store each, issues and pull requests sharing one number sequence per
// repository, contents writes as real commits, and squash merges as real
// three-way tree merges.
//
// Determinism is a design rule, not an accident: nothing here reads the wall
// clock or a random source. Timestamps come from a logical clock that starts
// at the scenario epoch and advances one second per mutation; ids are
// counters; commit identities are fixed. Two runs that receive the same
// requests produce the same bytes.

import {
  buildTree,
  flattenTree,
  formatCommit,
  getObject,
  isAncestor,
  mergeBase,
  objectId,
  parseCommit,
  putObject,
  type GitIdentity,
  type ObjectStore,
} from './gitobj.ts';
import { HttpError, notFound, unprocessable } from './http-util.ts';

/** The login the suite's token names (wire.ts: the scenario viewer). */
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The logical clock's base: wire.ts SCENARIO_EPOCH_SEC (2025-01-01T00:00:00Z). */
export const EPOCH_BASE_SEC = 1_735_689_600;

const COMMIT_TZ = '+0000';

/** Memoized isoOf: the conversion is a pure function of the second. */
const isoCache = new Map<number, string>();

/** An ISO-8601 timestamp in GitHub's shape (no milliseconds). */
export function isoOf(sec: number): string {
  const hit = isoCache.get(sec);
  if (hit !== undefined) return hit;
  const text = new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (isoCache.size >= 8192) isoCache.clear();
  isoCache.set(sec, text);
  return text;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  createdSec: number;
  updatedSec: number;
}

export interface IssueRec {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labelNames: string[];
  createdSec: number;
  updatedSec: number;
  comments: CommentRec[];
}

export interface PullRec {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  /** Last known tips, refreshed whenever the refs move. */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAtSec: number | null;
  mergeCommitSha: string | null;
  createdSec: number;
  updatedSec: number;
}

export class Repo {
  readonly id: number;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  readonly createdSec: number;
  updatedSec: number;

  readonly objects: ObjectStore = new Map();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, LabelRec>();
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  /** The number sequence issues and pull requests share (GitHub-style). */
  nextNumber = 1;

  constructor(id: number, name: string, description: string, isPrivate: boolean, defaultBranch: string, nowSec: number) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = defaultBranch;
    this.createdSec = nowSec;
    this.updatedSec = nowSec;
  }

  get fullName(): string {
    return `${VIEWER.login}/${this.name}`;
  }

  branchRef(branch: string): string {
    return `refs/heads/${branch}`;
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(this.branchRef(branch));
  }

  /** The flat path -> blob entry map at a commit (empty for an unborn tip). */
  filesAt(commitSha: string | undefined): Map<string, { sha: string; mode: string }> {
    if (commitSha === undefined) return new Map();
    const commit = getObject(this.objects, commitSha);
    if (commit === undefined || commit.type !== 'commit') return new Map();
    return flattenTree(this.objects, parseCommit(commit.data).tree);
  }

  filesAtRef(ref: string): Map<string, { sha: string; mode: string }> {
    return this.filesAt(this.refs.get(ref));
  }
}

export class Forge {
  private tick = 0;
  private nextRepoId = 5000;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private readonly reposByKey = new Map<string, Repo>();
  private readonly reposById = new Map<number, Repo>();

  /** Advance the logical clock and answer the new time in epoch seconds. */
  stamp(): number {
    this.tick += 1;
    return EPOCH_BASE_SEC + this.tick;
  }

  /** The current logical time without advancing it. */
  nowSec(): number {
    return EPOCH_BASE_SEC + this.tick;
  }

  // -------------------------------------------------------------- repos

  createRepo(input: { name: string; description?: string; isPrivate?: boolean; defaultBranch?: string }): Repo {
    const name = input.name;
    if (typeof name !== 'string' || name.trim() === '') throw unprocessable('Repository creation failed: name is required');
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
      throw unprocessable(`Repository creation failed: name "${name}" is not a valid repository name`);
    }
    const key = `${VIEWER.login}/${name}`;
    if (this.reposByKey.has(key)) throw unprocessable('Repository creation failed: name already exists on this account');
    const repo = new Repo(
      this.nextRepoId,
      name,
      input.description ?? '',
      input.isPrivate ?? false,
      input.defaultBranch !== undefined && input.defaultBranch !== '' ? input.defaultBranch : 'main',
      this.stamp(),
    );
    this.nextRepoId += 1;
    this.reposByKey.set(key, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  /** A repo by owner/name; any owner but the viewer's is a 404, never a 403. */
  getRepo(owner: string, name: string): Repo {
    if (owner !== VIEWER.login) throw notFound('Not Found');
    const repo = this.reposByKey.get(`${owner}/${name}`);
    if (repo === undefined) throw notFound('Not Found');
    return repo;
  }

  findRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.reposByKey.get(`${owner}/${name}`);
  }

  repoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  listRepos(): Repo[] {
    return [...this.reposById.values()].sort((a, b) => a.id - b.id);
  }

  deleteRepo(owner: string, name: string): void {
    const repo = this.getRepo(owner, name);
    this.reposByKey.delete(`${VIEWER.login}/${repo.name}`);
    this.reposById.delete(repo.id);
  }

  // -------------------------------------------------------------- commits through the API

  private commitIdentity(sec: number): GitIdentity {
    return { name: VIEWER.name, email: VIEWER.email, ts: sec, tz: COMMIT_TZ };
  }

  /**
   * Apply file changes (path -> new bytes, or null to delete) as one commit on
   * `branch`, creating the branch root when the repository is unborn. Answers
   * the new commit's sha. The branch must exist unless it is the default
   * branch of a commit-less repository.
   */
  commitFiles(repo: Repo, branch: string, changes: ReadonlyMap<string, Buffer | null>, message: string): string {
    const ref = repo.branchRef(branch);
    const tip = repo.refs.get(ref);
    if (tip === undefined && !(branch === repo.defaultBranch && repo.refs.size === 0)) {
      throw notFound('Branch not found');
    }
    const files = new Map<string, string>();
    for (const [path, entry] of repo.filesAt(tip)) files.set(path, entry.sha);
    for (const [path, bytes] of changes) {
      if (bytes === null) files.delete(path);
      else files.set(path, putObject(repo.objects, 'blob', bytes));
    }
    const tree = buildTree(repo.objects, files);
    const sec = this.stamp();
    const identity = this.commitIdentity(sec);
    const commit = formatCommit({
      tree,
      parents: tip === undefined ? [] : [tip],
      author: identity,
      committer: identity,
      message,
    });
    const sha = putObject(repo.objects, 'commit', commit);
    repo.refs.set(ref, sha);
    repo.updatedSec = sec;
    return sha;
  }

  /** Create a branch ref at a commit sha (POST /git/refs). */
  createRef(repo: Repo, ref: string, sha: string): void {
    const target = getObject(repo.objects, sha.toLowerCase());
    if (target === undefined) throw unprocessable('Object does not exist');
    if (repo.refs.has(ref)) throw unprocessable('Reference already exists');
    repo.refs.set(ref, sha.toLowerCase());
    this.stamp();
  }

  /** Commits reachable from a ref or sha, tip first (git-log order). */
  listCommits(repo: Repo, startSha: string): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (sha: string): void => {
      if (seen.has(sha)) return;
      const obj = getObject(repo.objects, sha);
      if (obj === undefined || obj.type !== 'commit') return;
      seen.add(sha);
      order.push(sha);
      for (const parent of parseCommit(obj.data).parents) visit(parent);
    };
    visit(startSha);
    return order;
  }

  // -------------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color: string, description: string | null): LabelRec {
    if (typeof name !== 'string' || name.trim() === '') throw unprocessable('Validation failed: name is required');
    const key = name.toLowerCase();
    if (repo.labels.has(key)) throw unprocessable('Validation failed: a label with that name already exists');
    const label: LabelRec = { name, color: color !== '' ? color : 'ededed', description };
    repo.labels.set(key, label);
    this.stamp();
    return label;
  }

  labelByName(repo: Repo, name: string): LabelRec | undefined {
    return repo.labels.get(name.toLowerCase());
  }

  // -------------------------------------------------------------- issues

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: readonly string[] }): IssueRec {
    const title = input.title;
    if (typeof title !== 'string' || title === '') throw unprocessable('Validation failed: title is required');
    const labelNames: string[] = [];
    for (const name of input.labels ?? []) {
      const label = this.labelByName(repo, name);
      if (label === undefined) throw unprocessable(`Validation failed: label "${name}" does not exist`);
      labelNames.push(label.name);
    }
    const sec = this.stamp();
    const issue: IssueRec = {
      kind: 'issue',
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body: input.body ?? '',
      state: 'open',
      labelNames,
      createdSec: sec,
      updatedSec: sec,
      comments: [],
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): IssueRec {
    const issue = repo.issues.get(number);
    if (issue === undefined) throw notFound('Not Found');
    return issue;
  }

  listIssues(repo: Repo, filter: { state: 'open' | 'closed' | 'all'; direction: 'asc' | 'desc' }): IssueRec[] {
    const all = [...repo.issues.values()].filter((issue) => filter.state === 'all' || issue.state === filter.state);
    all.sort((a, b) => (filter.direction === 'asc' ? a.number - b.number : b.number - a.number));
    return all;
  }

  updateIssue(repo: Repo, number: number, patch: { state?: 'open' | 'closed'; title?: string; body?: string }): IssueRec {
    const issue = this.getIssue(repo, number);
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.state !== undefined) issue.state = patch.state;
    issue.updatedSec = this.stamp();
    return issue;
  }

  addComment(repo: Repo, number: number, body: string): CommentRec {
    const issue = this.getIssue(repo, number);
    const sec = this.stamp();
    const comment: CommentRec = { id: this.nextCommentId, body, createdSec: sec, updatedSec: sec };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------- pull requests

  createPull(repo: Repo, input: { title: string; body?: string; head: string; base: string }): PullRec {
    const headTip = repo.branchTip(input.head);
    if (headTip === undefined) throw unprocessable(`Validation failed: head branch "${input.head}" does not exist`);
    const baseTip = repo.branchTip(input.base);
    if (baseTip === undefined) throw unprocessable(`Validation failed: base branch "${input.base}" does not exist`);
    if (typeof input.title !== 'string' || input.title === '') throw unprocessable('Validation failed: title is required');
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
        throw unprocessable('Validation failed: a pull request already exists for this head and base');
      }
    }
    const sec = this.stamp();
    const pull: PullRec = {
      kind: 'pull',
      id: this.nextIssueId,
      number: repo.nextNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      headRef: input.head,
      baseRef: input.base,
      headSha: headTip,
      baseSha: baseTip,
      merged: false,
      mergedAtSec: null,
      mergeCommitSha: null,
      createdSec: sec,
      updatedSec: sec,
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRec {
    const pull = repo.pulls.get(number);
    if (pull === undefined) throw notFound('Not Found');
    return pull;
  }

  listPulls(repo: Repo, state: 'open' | 'closed' | 'all'): PullRec[] {
    const all = [...repo.pulls.values()].filter((pull) => state === 'all' || pull.state === state);
    all.sort((a, b) => b.number - a.number);
    return all;
  }

  /** Refresh a pull's head/base shas from the live refs (tips move). */
  syncPullTips(repo: Repo, pull: PullRec): void {
    const head = repo.branchTip(pull.headRef);
    if (head !== undefined) pull.headSha = head;
    const base = repo.branchTip(pull.baseRef);
    if (base !== undefined) pull.baseSha = base;
  }

  /** The changed paths of a pull: merge base -> head tip, with line counts. */
  pullFiles(repo: Repo, pull: PullRec): PullFileChange[] {
    this.syncPullTips(repo, pull);
    const base = mergeBase(repo.objects, pull.headSha, pull.baseSha);
    const from = repo.filesAt(base ?? undefined);
    const to = repo.filesAt(pull.headSha);
    return diffFileMaps(repo, from, to);
  }

  /** Whether a pull can merge cleanly right now (three-way, file level). */
  pullMergeable(repo: Repo, pull: PullRec): boolean {
    this.syncPullTips(repo, pull);
    return planSquash(repo, pull).ok;
  }

  /**
   * Squash-merge a pull onto its base branch: one commit whose tree is the
   * three-way merge of (merge base, base tip, head tip). A path both sides
   * changed to different bytes is a conflict and answers 405.
   */
  mergePullSquash(repo: Repo, pull: PullRec): { sha: string; message: string } {
    if (pull.merged) throw new HttpError(405, 'Pull Request is not mergeable: already merged');
    this.syncPullTips(repo, pull);
    const plan = planSquash(repo, pull);
    if (!plan.ok) throw new HttpError(405, 'Pull Request is not mergeable: conflict');
    const files = new Map<string, string>();
    for (const [path, entry] of plan.files) files.set(path, entry.sha);
    const tree = buildTree(repo.objects, files);
    const sec = this.stamp();
    const identity = this.commitIdentity(sec);
    const message = `${pull.title} (#${pull.number})`;
    const commit = formatCommit({ tree, parents: [pull.baseSha], author: identity, committer: identity, message });
    const sha = putObject(repo.objects, 'commit', commit);
    repo.refs.set(repo.branchRef(pull.baseRef), sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAtSec = sec;
    pull.mergeCommitSha = sha;
    pull.updatedSec = sec;
    pull.baseSha = sha;
    return { sha, message: 'Pull Request successfully merged' };
  }
}

// ---------------------------------------------------------------- tree diffs and merges

export interface PullFileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string | null;
  previousSha: string | null;
}

/** Split text into lines the way diff counts them (a trailing newline ends the last line). */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Line-level diff counts via a longest-common-subsequence table. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  // Keep the DP table one row wide; file bodies in this forge are small.
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = 0;
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    [prev, curr] = [curr, prev];
  }
  const lcs = prev[b.length] as number;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

function blobText(repo: Repo, sha: string | null): string {
  if (sha === null) return '';
  const obj = getObject(repo.objects, sha);
  return obj === undefined ? '' : obj.data.toString('utf8');
}

/** The file-level diff between two flat file maps. */
export function diffFileMaps(
  repo: Repo,
  from: ReadonlyMap<string, { sha: string; mode: string }>,
  to: ReadonlyMap<string, { sha: string; mode: string }>,
): PullFileChange[] {
  const changes: PullFileChange[] = [];
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before !== undefined && after !== undefined && before.sha === after.sha) continue;
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    const counts = lineDiffCounts(blobText(repo, before?.sha ?? null), blobText(repo, after?.sha ?? null));
    changes.push({
      path,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: after?.sha ?? null,
      previousSha: before?.sha ?? null,
    });
  }
  return changes;
}

interface SquashPlan {
  ok: boolean;
  files: Map<string, { sha: string; mode: string }>;
}

/**
 * The three-way merge plan: start from the merge base's files; a path the
 * head changed and the base did not takes the head's version (and the mirror
 * image); a path both changed to different blobs is a conflict.
 */
function planSquash(repo: Repo, pull: PullRec): SquashPlan {
  const base = mergeBase(repo.objects, pull.headSha, pull.baseSha);
  const baseFiles = repo.filesAt(base ?? undefined);
  const headFiles = repo.filesAt(pull.headSha);
  const tipFiles = repo.filesAt(pull.baseSha);
  const merged = new Map(tipFiles);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const inBase = baseFiles.get(path)?.sha;
    const inHead = headFiles.get(path)?.sha;
    const inTip = tipFiles.get(path)?.sha;
    if (inHead === inBase) continue; // the head did not change it
    if (inTip !== inBase && inTip !== inHead) return { ok: false, files: merged }; // both changed it, differently
    if (inHead === undefined) merged.delete(path);
    else merged.set(path, { sha: inHead, mode: headFiles.get(path)?.mode ?? '100644' });
  }
  return { ok: true, files: merged };
}

/** The sha a blob with these bytes would have (contents API identity). */
export function blobId(bytes: Buffer): string {
  return objectId('blob', bytes);
}
