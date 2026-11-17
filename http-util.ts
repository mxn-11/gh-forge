// Shared HTTP plumbing for the forge's surfaces: body reading, JSON replies,
// and the error type handlers throw to answer with a status and a message.

import type { IncomingMessage, ServerResponse } from 'node:http';

/** An error that maps directly onto an HTTP reply: status plus message. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function notFound(message = 'Not Found'): HttpError {
  return new HttpError(404, message);
}

export function unprocessable(message: string): HttpError {
  return new HttpError(422, message);
}

/** Read a whole request body, refusing anything past `limit` bytes. */
export function readBody(req: IncomingMessage, limit = 96 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

/** Parse a request body as JSON; a malformed body is a 400, an empty one {}. */
export function parseJsonBody(raw: Buffer): Record<string, unknown> {
  if (raw.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Malformed JSON in request body');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

/** Send a JSON reply. Every forge reply goes through here or sendBuffer. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  const bytes = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    ...headers,
  });
  res.end(bytes);
}

/** Send a raw buffer reply (git protocol streams, advertisements). */
export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

/** Send a bodyless reply (204). */
export function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, headers);
  res.end();
}

/** The decoded path segments and query of a request URL. */
export interface ParsedUrl {
  readonly path: string;
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
}

/** Characters a request target may hold for the manual parse below. */
const PLAIN_TARGET = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?]*$/;

export function parseUrl(req: IncomingMessage): ParsedUrl {
  const raw = req.url ?? '/';
  // Fast path: an origin-form target with no %-escapes, no backslash, no
  // fragment and no dot segments parses exactly as the URL parser would
  // (decodeURIComponent is the identity without '%'; dot segments are the
  // only ones the URL parser rewrites). Anything else takes the full parse.
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') && !raw.includes('#') && PLAIN_TARGET.test(raw)) {
    const q = raw.indexOf('?');
    const path = q === -1 ? raw : raw.slice(0, q);
    const segments = path.split('/').filter((part) => part !== '');
    if (!segments.some((part) => part === '.' || part === '..')) {
      return { path, segments, query: new URLSearchParams(q === -1 ? '' : raw.slice(q + 1)) };
    }
  }
  const url = new URL(raw, 'http://forge.invalid');
  const segments = url.pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  return { path: url.pathname, segments, query: url.searchParams };
}

/** The absolute origin the client used to reach us, for Link headers. */
export function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'forge.invalid';
  return `http://${host}`;
}
