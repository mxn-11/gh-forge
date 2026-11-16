// The git object model, implemented from the format itself: objects are
// sha1("<type> <len>\0" + content), trees and commits are the usual text/binary
// layouts, packs are version-2 with ofs/ref deltas, and the wire framing is
// pkt-lines. No git binary is involved anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjType;
  readonly data: Buffer;
}

/** An object store: sha (lowercase hex) to object. One per repository. */
export type ObjectStore = Map<string, GitObject>;

const TYPE_IDS: Readonly<Record<GitObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: readonly GitObjType[] = ['', 'commit', 'tree', 'blob', 'tag'] as const;

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id an object with this type and content has, without storing it. */
export function objectId(type: GitObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Store an object and answer its id. */
export function putObject(store: ObjectStore, type: GitObjType, data: Buffer): string {
  const sha = objectId(type, data);
  if (!store.has(sha)) store.set(sha, { type, data });
  return sha;
}

export function getObject(store: ObjectStore, sha: string): GitObject | undefined {
  return store.get(sha.toLowerCase());
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  /** '100644' | '100755' | '120000' for files, '40000' for directories. */
  mode: string;
  name: string;
  sha: string;
}

const isTreeMode = (mode: string): boolean => mode === '40000' || mode === '040000';

/** Git's tree order: by name, with directories comparing as name + '/'. */
function treeSortKey(entry: TreeEntry): string {
  return isTreeMode(entry.mode) ? `${entry.name}/` : entry.name;
}

export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const ka = treeSortKey(a);
  const kb = treeSortKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export function serializeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const mode = entry.mode === '040000' ? '40000' : entry.mode;
    parts.push(Buffer.from(`${mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', at, space);
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    at = nul + 21;
  }
  return entries;
}

/** Flatten a tree (recursively) into path -> {sha, mode} for files. */
export function flattenTree(store: ObjectStore, treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  const tree = getObject(store, treeSha);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isTreeMode(entry.mode)) flattenTree(store, entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
  return out;
}

/** Build (and store) a tree from a flat path -> blob sha map; answers its sha. */
export function buildTree(store: ObjectStore, files: ReadonlyMap<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, sha] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1] as string, sha);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sha] of node.files) entries.push({ mode: '100644', name, sha });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: emit(child) });
    return putObject(store, 'tree', serializeTree(entries));
  };
  return emit(root);
}

// ---------------------------------------------------------------- commits and tags

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
  /** Seconds since the epoch. */
  readonly ts: number;
  readonly tz: string;
}

export interface CommitData {
  tree: string;
  parents: string[];
  author: GitIdentity;
  committer: GitIdentity;
  message: string;
}

function formatIdentity(id: GitIdentity): string {
  return `${id.name} <${id.email}> ${id.ts} ${id.tz}`;
}

function parseIdentity(text: string): GitIdentity {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(text);
  if (match === null) return { name: text, email: '', ts: 0, tz: '+0000' };
  return { name: match[1] as string, email: match[2] as string, ts: Number(match[3]), tz: match[4] as string };
}

export function formatCommit(commit: CommitData): Buffer {
  let head = `tree ${commit.tree}\n`;
  for (const parent of commit.parents) head += `parent ${parent}\n`;
  head += `author ${formatIdentity(commit.author)}\n`;
  head += `committer ${formatIdentity(commit.committer)}\n`;
  head += '\n';
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(commit.message, 'utf8')]);
}

export function parseCommit(data: Buffer): CommitData {
  const split = data.indexOf('\n\n');
  const head = data.toString('utf8', 0, split === -1 ? data.length : split);
  const message = split === -1 ? '' : data.toString('utf8', split + 2);
  const commit: CommitData = {
    tree: '',
    parents: [],
    author: { name: '', email: '', ts: 0, tz: '+0000' },
    committer: { name: '', email: '', ts: 0, tz: '+0000' },
    message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) commit.author = parseIdentity(line.slice(7));
    else if (line.startsWith('committer ')) commit.committer = parseIdentity(line.slice(10));
  }
  return commit;
}

export interface TagData {
  object: string;
  type: GitObjType;
  tag: string;
  tagger: GitIdentity | null;
  message: string;
}

export function parseTag(data: Buffer): TagData {
  const split = data.indexOf('\n\n');
  const head = data.toString('utf8', 0, split === -1 ? data.length : split);
  const tag: TagData = { object: '', type: 'commit', tag: '', tagger: null, message: split === -1 ? '' : data.toString('utf8', split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) tag.object = line.slice(7).trim();
    else if (line.startsWith('type ')) tag.type = line.slice(5).trim() as GitObjType;
    else if (line.startsWith('tag ')) tag.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tag.tagger = parseIdentity(line.slice(7));
  }
  return tag;
}

/** Peel a possibly-tagged sha to the commit it names, if any. */
export function peelToCommit(store: ObjectStore, sha: string): string | null {
  let current = sha;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = getObject(store, current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- commit graph

/**
 * Parsed commits, memoized per store: commit objects are immutable, so a
 * parse never goes stale, and the graph walks below (ancestry, merge base,
 * fetch collection) re-read the same commits constantly.
 */
const commitParseCache = new WeakMap<ObjectStore, Map<string, CommitData>>();

export function parseCommitCached(store: ObjectStore, sha: string): CommitData | null {
  let perStore = commitParseCache.get(store);
  if (perStore === undefined) {
    perStore = new Map();
    commitParseCache.set(store, perStore);
  }
  const hit = perStore.get(sha);
  if (hit !== undefined) return hit;
  const obj = getObject(store, sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  perStore.set(sha, parsed);
  return parsed;
}

/** Every commit reachable from `tip` (including it), following all parents. */
export function commitAncestors(store: ObjectStore, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const commit = parseCommitCached(store, sha);
    if (commit === null) continue;
    seen.add(sha);
    for (const parent of commit.parents) stack.push(parent);
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return commitAncestors(store, descendant).has(ancestor);
}

/** Longest path (in edges) from the commit to a root, memoized per call set. */
function commitDepths(store: ObjectStore, tips: readonly string[]): Map<string, number> {
  const depths = new Map<string, number>();
  const depthOf = (sha: string, guard: Set<string>): number => {
    const known = depths.get(sha);
    if (known !== undefined) return known;
    if (guard.has(sha)) return 0;
    guard.add(sha);
    const commit = parseCommitCached(store, sha);
    if (commit === null) {
      depths.set(sha, 0);
      return 0;
    }
    const parents = commit.parents;
    const depth = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((p) => depthOf(p, guard)));
    guard.delete(sha);
    depths.set(sha, depth);
    return depth;
  };
  for (const tip of tips) depthOf(tip, new Set());
  return depths;
}

/** The best common ancestor of two commits (deepest; ties broken by sha for determinism). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = commitAncestors(store, a);
  const depths = commitDepths(store, [a, b]);
  let best: string | null = null;
  let bestDepth = -1;
  for (const candidate of commitAncestors(store, b)) {
    if (!ancestorsA.has(candidate)) continue;
    const depth = depths.get(candidate) ?? 0;
    if (depth > bestDepth || (depth === bestDepth && best !== null && candidate < best)) {
      best = candidate;
      bestDepth = depth;
    }
  }
  return best;
}

/**
 * Objects a fetch should send: everything reachable from `wants`, minus what
 * `haves` already reach. With `depth`, commit history is cut at that many
 * edges from the wants and the cut commits are reported as shallow.
 *
 * `clientShallow` lists the commits the client already holds as shallow: a
 * "have" naming one of them excludes the commit and its tree but NOT its
 * ancestors (the client does not hold those — that is what deepen sends).
 * The walk still traverses through have-excluded commits so a deepened
 * boundary can be reached; `unshallow` reports client-shallow commits the
 * walk passed through that are no longer on the boundary.
 */
export function collectFetchObjects(
  store: ObjectStore,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  clientShallow: readonly string[] = [],
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const shallowHeld = new Set(clientShallow.map((sha) => sha.toLowerCase()));
  const haveObjects = new Set<string>();
  const markHave = (sha: string): void => {
    if (haveObjects.has(sha)) return;
    const obj = getObject(store, sha);
    if (obj === undefined) return;
    haveObjects.add(sha);
    if (obj.type === 'commit') {
      const commit = parseCommitCached(store, sha);
      if (commit === null) return;
      markHave(commit.tree);
      if (!shallowHeld.has(sha)) {
        for (const parent of commit.parents) markHave(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) markHave(entry.sha);
    } else if (obj.type === 'tag') {
      markHave(parseTag(obj.data).object);
    }
  };
  for (const have of haves) {
    const commit = peelToCommit(store, have);
    if (commit !== null) markHave(commit);
    markHave(have);
  }

  const objects = new Map<string, GitObject>();
  const shallow: string[] = [];
  const includeTree = (treeSha: string): void => {
    if (objects.has(treeSha) || haveObjects.has(treeSha)) return;
    const tree = getObject(store, treeSha);
    if (tree === undefined) return;
    objects.set(treeSha, tree);
    for (const entry of parseTree(tree.data)) {
      if (isTreeMode(entry.mode)) includeTree(entry.sha);
      else if (!objects.has(entry.sha) && !haveObjects.has(entry.sha)) {
        const blob = getObject(store, entry.sha);
        if (blob !== undefined) objects.set(entry.sha, blob);
      }
    }
  };
  const includeTag = (tagSha: string): void => {
    if (objects.has(tagSha) || haveObjects.has(tagSha)) return;
    const tag = getObject(store, tagSha);
    if (tag === undefined) return;
    objects.set(tagSha, tag);
  };

  // Breadth-first over commits so depth is the shortest distance from a want.
  // Have-excluded commits are traversed (their distance still counts) but not
  // re-sent; the boundary rule stops the walk at `depth` edges.
  const distance = new Map<string, number>();
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const want of wants) {
    const commit = peelToCommit(store, want);
    if (commit === null) continue;
    if (want !== commit) includeTag(want);
    if (!distance.has(commit)) {
      distance.set(commit, 0);
      queue.push(commit);
    }
  }
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (visited.has(sha)) continue;
    visited.add(sha);
    const dist = distance.get(sha) as number;
    const obj = getObject(store, sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommitCached(store, sha) ?? parseCommit(obj.data);
    const excluded = haveObjects.has(sha);
    if (!excluded) {
      objects.set(sha, obj);
      includeTree(commit.tree);
    }
    const atBoundary = depth !== null && dist >= depth - 1;
    if (atBoundary) {
      if (!excluded && commit.parents.length > 0) shallow.push(sha);
      continue;
    }
    for (const parent of commit.parents) {
      if (!distance.has(parent)) {
        distance.set(parent, dist + 1);
        queue.push(parent);
      }
    }
  }
  const unshallow = [...shallowHeld].filter((sha) => visited.has(sha) && !shallow.includes(sha));
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------- packs

/** Find the exact end of the zlib stream starting at `offset`. */
function inflateExact(buf: Buffer, offset: number): { data: Buffer; next: number } {
  // Fast path: zlib reports how many input bytes the stream consumed, so one
  // call finds the end. The binary search below is the fallback for a zlib
  // build without that report.
  try {
    const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const written = result.engine.bytesWritten;
    if (written > 0) return { data: result.buffer, next: offset + written };
  } catch {
    // fall through to the search
  }
  let lo = offset;
  let hi = buf.length;
  // hi must be a succeeding prefix: the rest of the buffer always is, since
  // inflate ignores trailing bytes; verify once up front.
  inflateSync(buf.subarray(offset));
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  return { data: inflateSync(buf.subarray(offset, hi)), next: hi };
}

/** Apply a git delta buffer to a base object body. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at] as number;
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} != ${base.length}`);
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at] as number;
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[at] as number; at += 1; }
      if (op & 0x02) { offset |= (delta[at] as number) << 8; at += 1; }
      if (op & 0x04) { offset |= (delta[at] as number) << 16; at += 1; }
      if (op & 0x08) { offset |= (delta[at] as number) << 24; at += 1; }
      if (op & 0x10) { size = delta[at] as number; at += 1; }
      if (op & 0x20) { size |= (delta[at] as number) << 8; at += 1; }
      if (op & 0x40) { size |= (delta[at] as number) << 16; at += 1; }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      parts.push(delta.subarray(at, at + op));
      produced += op;
      at += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface PackEntry {
  type: GitObjType;
  data: Buffer;
  baseSha?: string;
  baseOffset?: number;
}

/**
 * Parse a pack stream into fully resolved objects. `lookup` finds delta bases
 * that live outside the pack (thin packs), by sha.
 */
export function parsePack(pack: Buffer, lookup: (sha: string) => GitObject | undefined): GitObject[] {
  if (pack.length < 12 + 20 || pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`pack version ${version} is not supported`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');

  const entries: (PackEntry & { offset: number })[] = [];
  const byOffset = new Map<number, number>();
  let at = 12;
  for (let i = 0; i < count; i += 1) {
    const start = at;
    let byte = pack[at] as number;
    at += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at] as number;
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseSha: string | undefined;
    let baseOffset: number | undefined;
    if (typeId === 6) {
      // ofs-delta: negative offset varint with the quirky continuation bit.
      let byte2 = pack[at] as number;
      at += 1;
      let offset = byte2 & 0x7f;
      while (byte2 & 0x80) {
        byte2 = pack[at] as number;
        at += 1;
        offset = ((offset + 1) << 7) | (byte2 & 0x7f);
      }
      baseOffset = start - offset;
    } else if (typeId === 7) {
      baseSha = pack.toString('hex', at, at + 20);
      at += 20;
    }
    const inflated = inflateExact(pack, at);
    at = inflated.next;
    if (inflated.data.length !== size) throw new Error('pack object size mismatch');
    const type = typeId === 6 || typeId === 7 ? ('' as GitObjType) : ID_TYPES[typeId];
    entries.push({ type: type as GitObjType, data: inflated.data, baseSha, baseOffset, offset: start });
    byOffset.set(start, entries.length - 1);
  }

  // Resolve in passes: plain objects first, then deltas whose bases are known
  // (a base may itself be a delta earlier in the pack, or live outside it).
  const resolved = new Array<GitObject | null>(entries.length).fill(null);
  const bySha = new Map<string, GitObject>();
  const noteResolved = (index: number, object: GitObject): void => {
    resolved[index] = object;
    bySha.set(objectId(object.type, object.data), object);
  };
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] as PackEntry & { offset: number };
    if (entry.baseSha === undefined && entry.baseOffset === undefined) {
      noteResolved(i, { type: entry.type, data: entry.data });
    }
  }
  let pending = entries.length - resolved.filter((entry) => entry !== null).length;
  while (pending > 0) {
    let progressed = false;
    for (let i = 0; i < entries.length; i += 1) {
      if (resolved[i] !== null) continue;
      const entry = entries[i] as PackEntry & { offset: number };
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) {
        const baseIndex = byOffset.get(entry.baseOffset);
        if (baseIndex !== undefined && resolved[baseIndex] !== null) base = resolved[baseIndex] as GitObject;
      } else if (entry.baseSha !== undefined) {
        base = bySha.get(entry.baseSha) ?? lookup(entry.baseSha);
      }
      if (base === undefined) continue;
      noteResolved(i, { type: base.type, data: applyDelta(base.data, entry.data) });
      pending -= 1;
      progressed = true;
    }
    if (!progressed) throw new Error('pack has a delta whose base cannot be resolved');
  }
  return resolved as GitObject[];
}

/** Build a version-2 pack holding `objects` (no deltas), with its sha1 trailer. */
export function buildPack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    let size = object.data.length;
    const typeId = TYPE_IDS[object.type];
    const bytes: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    bytes.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pkt-lines

/** Frame one pkt-line (payload up to 65516 bytes). */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'latin1');
export const PKT_DELIM = Buffer.from('0001', 'latin1');
export const PKT_RESPONSE_END = Buffer.from('0002', 'latin1');

export type PktItem =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Parse pkt-lines from `buf` starting at `offset`; answers the items and the end offset. */
export function parsePktLines(buf: Buffer, offset = 0): { items: PktItem[]; next: number } {
  const items: PktItem[] = [];
  let at = offset;
  while (at + 4 <= buf.length) {
    const length = Number.parseInt(buf.toString('latin1', at, at + 4), 16);
    if (Number.isNaN(length)) throw new Error('invalid pkt-line length');
    if (length === 0) {
      items.push({ kind: 'flush' });
      at += 4;
      break;
    }
    if (length === 1) {
      items.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      items.push({ kind: 'response-end' });
      at += 4;
      continue;
    }
    if (length === 3) {
      at += 4;
      continue;
    }
    if (at + length > buf.length) throw new Error('pkt-line overruns the buffer');
    items.push({ kind: 'data', data: buf.subarray(at + 4, at + length) });
    at += length;
  }
  return { items, next: at };
}

/** Side-band channel framing: channel byte + payload, chunked into pkt-lines. */
export function sidebandFrame(channel: number, data: Buffer, chunkSize = 65_512): Buffer[] {
  const frames: Buffer[] = [];
  for (let at = 0; at < data.length; at += chunkSize) {
    const slice = data.subarray(at, at + chunkSize);
    frames.push(pktLine(Buffer.concat([Buffer.from([channel]), slice])));
  }
  return frames;
}
