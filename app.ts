// The HTTP front door: one server that routes health checks, the REST API,
// the git transport, GraphQL and MCP to their surfaces, gates everything but
// /healthz behind the environment's bearer token, stamps every response with
// a request id, and keeps every failure JSON-shaped.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { HttpError, parseUrl, sendJson } from './http-util.ts';

/** Create the forge's HTTP server. `token` is the expected bearer token. */
export function createApp(token: string): Server {
  const forge = new Forge();
  let requestSeq = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestSeq += 1;
    res.setHeader('x-github-request-id', `forge-${requestSeq.toString(36).toUpperCase().padStart(4, '0')}`);
    void (async (): Promise<void> => {
      try {
        const parsed = parseUrl(req);
        const segments = parsed.segments;

        if (segments.length === 1 && segments[0] === 'healthz' && (req.method ?? 'GET') === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Every other surface requires the environment's bearer token; a
        // missing or wrong one is a 401 with a JSON body, never a redirect.
        if (token !== '') {
          const header = req.headers.authorization;
          if (header !== `Bearer ${token}`) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
        }

        if (segments[0] === 'api' && segments[1] === 'v3') {
          await handleRest(forge, req, res, segments.slice(2), parsed);
          return;
        }
        if (segments[0] === 'api' && segments[1] === 'graphql') {
          await handleGraphql(forge, req, res);
          return;
        }
        if (segments[0] === 'mcp') {
          await handleMcp(forge, req, res);
          return;
        }
        if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
          const name = (segments[1] as string).slice(0, -'.git'.length);
          await handleGit(forge, req, res, segments[0] as string, name, segments.slice(2));
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (error instanceof HttpError) {
          sendJson(res, error.status, { message: error.message });
          return;
        }
        process.stderr.write(`forge: unhandled error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        sendJson(res, 500, { message: 'Internal Server Error' });
      }
    })();
  });
  return server;
}
