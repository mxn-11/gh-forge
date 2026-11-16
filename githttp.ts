// The git smart-HTTP transport, spoken in-process: ref advertisement (v0 and
// protocol v2), v2 ls-refs, fetch (v2 sections, plus a v0 negotiation for
// clients that ask), and receive-pack pushes with report-status in side-band
// frames. Everything reads and writes the same object store REST uses, so a
// branch pushed here is a branch the API can see, and vice versa.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildPack,
  collectFetchObjects,
  getObject,
  isAncestor,
  parsePack,
  parsePktLines,
  peelToCommit,
  pktLine,
  PKT_FLUSH,
  putObject,
  sidebandFrame,
  type GitObject,
} from './gitobj.ts';
import type { Forge, Repo } from './store.ts';
import { parseUrl, readBody, sendBuffer, type ParsedUrl } from './http-util.ts';

const ZERO = '0'.repeat(40);
const UPLOAD_CAPS_V2 = ['version 2', 'fetch=shallow', 'ls-refs', 'object-format=sha1'];
const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow symref=HEAD:%s';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

type Service = 'git-upload-pack' | 'git-receive-pack';

/** A ref line for listings: name, target, and the commit a tag peels to. */
interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
}

/** All refs of a repo, HEAD first, then refs in name order, tags peeled. */
function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (headTip !== undefined) lines.push({ name: 'HEAD', oid: headTip });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { name, oid };
    const target = getObject(repo.objects, oid);
    if (target !== undefined && target.type === 'tag') {
      const commit = peelToCommit(repo.objects, oid);
      if (commit !== null) line.peeled = commit;
    }
    lines.push(line);
  }
  return lines;
}

function sendPkt(res: ServerResponse, status: number, contentType: string, chunks: readonly Buffer[]): void {
  sendBuffer(res, status, Buffer.concat(chunks), contentType);
}

// ---------------------------------------------------------------- advertisement

function advertise(res: ServerResponse, repo: Repo, service: Service, v2: boolean): void {
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && v2) {
    // A v2 answer opens with the version line itself, no service preamble.
    sendPkt(res, 200, contentType, [...UPLOAD_CAPS_V2.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
    return;
  }
  const chunks: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const lines = refLines(repo);
  const headRef = `refs/heads/${repo.defaultBranch}`;
  if (service === 'git-upload-pack') {
    const caps = UPLOAD_CAPS_V0.replace('%s', headRef);
    if (lines.length === 0) {
      chunks.push(pktLine(`${ZERO} capabilities^{}\0${caps}`));
    } else {
      lines.forEach((line, index) => {
        const suffix = index === 0 ? `\0${caps}` : '';
        chunks.push(pktLine(`${line.oid} ${line.name}${suffix}`));
        if (line.peeled !== undefined) chunks.push(pktLine(`${line.peeled} ${line.name}^{}`));
      });
    }
  } else {
    if (lines.length === 0) {
      chunks.push(pktLine(`${ZERO} capabilities^{}\0${RECEIVE_CAPS}`));
    } else {
      lines.forEach((line, index) => {
        const suffix = index === 0 ? `\0${RECEIVE_CAPS}` : '';
        chunks.push(pktLine(`${line.oid} ${line.name}${suffix}`));
        if (line.peeled !== undefined) chunks.push(pktLine(`${line.peeled} ${line.name}^{}`));
      });
    }
  }
  chunks.push(PKT_FLUSH);
  sendPkt(res, 200, contentType, chunks);
}

// ---------------------------------------------------------------- ls-refs (v2)

function lsRefs(repo: Repo, args: readonly string[]): Buffer[] {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const chunks: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  for (const line of refLines(repo)) {
    if (!keep(line.name)) continue;
    let text = `${line.oid} ${line.name}`;
    if (symrefs && line.name === 'HEAD') text += ` symref-target:${headRef}`;
    if (peel && line.peeled !== undefined) text += ` peeled:${line.peeled}`;
    chunks.push(pktLine(`${text}\n`));
  }
  if (repo.refs.get(headRef) === undefined && unborn && keep('HEAD')) {
    chunks.push(pktLine(`unborn HEAD symref-target:${headRef}\n`));
  }
  chunks.push(PKT_FLUSH);
  return chunks;
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

/**
 * Built packs, memoized: a pack is a pure function of the object store and
 * the request's want/have/depth sets, and stored objects never change — so a
 * pack built once (say, a shallow clone's tip snapshot) is byte-correct
 * forever. The clone workload asks for the same pack 50 times concurrently;
 * this turns those into one build and 49 buffer replays.
 */
const packCache = new Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>();
const PACK_CACHE_LIMIT = 128;

function fetchPack(repo: Repo, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const key = [
    repo.id,
    [...args.wants].sort().join(','),
    [...args.haves].sort().join(','),
    [...args.shallow].sort().join(','),
    args.depth === null ? 'full' : String(args.depth),
  ].join('|');
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const { objects, shallow, unshallow } = collectFetchObjects(repo.objects, args.wants, args.haves, args.depth, args.shallow);
  const built = { pack: buildPack([...objects.values()]), shallow, unshallow };
  if (packCache.size >= PACK_CACHE_LIMIT) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, built);
  return built;
}

function fetchResponse(repo: Repo, args: FetchArgs, v2: boolean): Buffer[] {
  const { pack, shallow, unshallow } = fetchPack(repo, args);
  const chunks: Buffer[] = [];
  if (v2) {
    const acks: string[] = [];
    if (args.haves.length === 0) acks.push('NAK');
    else {
      acks.push(`ACK ${args.haves[0]}`);
      acks.push('ready');
    }
    chunks.push(pktLine('acknowledgments\n'), ...acks.map((line) => pktLine(`${line}\n`)), PKT_FLUSH);
    if (shallow.length > 0 || unshallow.length > 0) {
      chunks.push(pktLine('shallow-info\n'));
      for (const sha of shallow) chunks.push(pktLine(`shallow ${sha}\n`));
      for (const sha of unshallow) chunks.push(pktLine(`unshallow ${sha}\n`));
      chunks.push(PKT_FLUSH);
    }
    chunks.push(pktLine('packfile\n'));
    chunks.push(...sidebandFrame(1, pack));
    chunks.push(PKT_FLUSH);
    return chunks;
  }
  // v0: shallow lines, a NAK line, then the pack in side-band frames.
  for (const sha of shallow) chunks.push(pktLine(`shallow ${sha}\n`));
  for (const sha of unshallow) chunks.push(pktLine(`unshallow ${sha}\n`));
  chunks.push(pktLine('NAK\n'));
  chunks.push(...sidebandFrame(1, pack));
  chunks.push(PKT_FLUSH);
  return chunks;
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: Repo, body: Buffer): Buffer[] {
  let commands: PushCommand[] = [];
  let packBytes: Buffer = Buffer.alloc(0);
  let parseError: string | null = null;
  try {
    const { items, next } = parsePktLines(body, 0);
    packBytes = body.subarray(next);
    for (const item of items) {
      if (item.kind !== 'data') continue;
      let text = item.data.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\0');
      if (nul >= 0) text = text.slice(0, nul); // first line carries the capabilities
      const parts = text.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: (parts[0] as string).toLowerCase(), newOid: (parts[1] as string).toLowerCase(), ref: parts.slice(2).join(' ') });
      }
    }
  } catch {
    parseError = 'malformed command list';
  }

  // Unpack first: the objects land in the store even for refs that are then
  // refused (git keeps them too), and validation reads them from the store.
  let unpackError: string | null = parseError;
  if (unpackError === null && packBytes.length > 0) {
    try {
      const objects: GitObject[] = parsePack(packBytes, (sha) => getObject(repo.objects, sha));
      for (const object of objects) putObject(repo.objects, object.type, object.data);
    } catch (error) {
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }

  const report: string[] = [];
  report.push(unpackError === null ? 'unpack ok' : `unpack ${unpackError}`);
  if (unpackError === null) {
    for (const command of commands) {
      report.push(applyPushCommand(repo, command));
    }
  } else {
    for (const command of commands) report.push(`ng ${command.ref} unpack failed`);
  }

  const reportStream = Buffer.concat([...report.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  return [...sidebandFrame(1, reportStream), PKT_FLUSH];
}

/** Apply one push command, answering its report-status line. */
function applyPushCommand(repo: Repo, command: PushCommand): string {
  const { oldOid, newOid, ref } = command;
  const fail = (reason: string): string => `ng ${ref} ${reason}`;
  if (!ref.startsWith('refs/')) return fail('invalid ref');
  const current = repo.refs.get(ref);

  if (newOid === ZERO) {
    // Delete: the ref must exist; objects are never needed.
    if (current === undefined) return fail('ref does not exist');
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const target = getObject(repo.objects, newOid);
  if (target === undefined) return fail('missing object');
  if (current === undefined) {
    if (oldOid !== ZERO) return fail('reference not found');
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  if (oldOid !== ZERO && oldOid !== current) return fail('stale info');
  if (current === newOid) return `ok ${ref}`;
  // Update: fast-forward only, judged on commits (tags peel to theirs).
  const currentCommit = peelToCommit(repo.objects, current);
  const newCommit = peelToCommit(repo.objects, newOid);
  if (currentCommit !== null && newCommit !== null && !isAncestor(repo.objects, currentCommit, newCommit)) {
    return fail('non-fast-forward');
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}

// ---------------------------------------------------------------- the handler

/** Handle one git smart-HTTP request. `tail` is the path after /<owner>/<repo>.git. */
export async function handleGit(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  tail: readonly string[],
): Promise<void> {
  const parsed: ParsedUrl = parseUrl(req);
  const repo = forge.findRepo(owner, name);
  const method = req.method ?? 'GET';

  if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
    if (repo === undefined) {
      sendBuffer(res, 404, Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'), 'application/json');
      return;
    }
    const service: Service = parsed.query.get('service') === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack';
    const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    advertise(res, repo, service, v2);
    return;
  }

  if (tail.length === 1 && (tail[0] === 'git-upload-pack' || tail[0] === 'git-receive-pack') && method === 'POST') {
    if (repo === undefined) {
      sendBuffer(res, 404, Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'), 'application/json');
      return;
    }
    const service = tail[0] as Service;
    const body = await readBody(req);
    const resultType = `application/x-${service}-result`;
    if (service === 'git-receive-pack') {
      sendPkt(res, 200, resultType, receivePack(repo, body));
      return;
    }
    // upload-pack: a v2 command request or a v0 negotiation.
    const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    let items;
    try {
      items = parsePktLines(body, 0).items;
    } catch {
      sendBuffer(res, 400, Buffer.from('malformed pkt-line request\n', 'utf8'), 'text/plain');
      return;
    }
    const lines = items.filter((item) => item.kind === 'data').map((item) => item.data.toString('utf8').replace(/\n$/, ''));
    if (v2) {
      const command = lines.find((line) => line.startsWith('command='));
      const args = lines.filter((line) => !line.startsWith('command=') && !line.startsWith('agent=') && !line.startsWith('object-format='));
      if (command === 'command=ls-refs') {
        sendPkt(res, 200, resultType, lsRefs(repo, args));
        return;
      }
      if (command === 'command=fetch') {
        const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
        for (const arg of args) {
          if (arg.startsWith('want ')) fetchArgs.wants.push(arg.slice(5).trim().toLowerCase());
          else if (arg.startsWith('have ')) fetchArgs.haves.push(arg.slice(5).trim().toLowerCase());
          else if (arg.startsWith('shallow ')) fetchArgs.shallow.push(arg.slice(8).trim().toLowerCase());
          else if (arg.startsWith('deepen ')) fetchArgs.depth = Number(arg.slice(7).trim());
          else if (arg === 'done') fetchArgs.done = true;
        }
        sendPkt(res, 200, resultType, fetchResponse(repo, fetchArgs, true));
        return;
      }
      sendBuffer(res, 400, Buffer.from('unsupported command\n', 'utf8'), 'text/plain');
      return;
    }
    // v0: wants in the first section, haves after the flush (parsePktLines
    // stops at the first flush, so parse the remainder as a second section).
    const first = parsePktLines(body, 0);
    const second = parsePktLines(body, first.next);
    const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
    const readSection = (section: typeof first, isFirst: boolean): void => {
      for (const item of section.items) {
        if (item.kind !== 'data') continue;
        const line = item.data.toString('utf8').replace(/\n$/, '');
        if (line.startsWith('want ')) fetchArgs.wants.push(line.slice(5, 45).toLowerCase());
        else if (line.startsWith('have ')) fetchArgs.haves.push(line.slice(5, 45).toLowerCase());
        else if (line.startsWith('shallow ')) fetchArgs.shallow.push(line.slice(8, 48).toLowerCase());
        else if (line.startsWith('deepen ')) fetchArgs.depth = Number(line.slice(7).trim());
        else if (line === 'done') fetchArgs.done = true;
        void isFirst;
      }
    };
    readSection(first, true);
    readSection(second, false);
    sendPkt(res, 200, resultType, fetchResponse(repo, fetchArgs, false));
    return;
  }

  sendBuffer(res, 404, Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'), 'application/json');
}
