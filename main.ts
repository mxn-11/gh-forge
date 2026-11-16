// Entry point: the env lifecycle from the wire contract, plus a standalone
// development mode used only for local practice runs.
//
// Trial mode (MAKEFUN_ENV_URL set):
//   1. build the HTTP server and listen on port 0 (the kernel picks a port;
//      never 8080, which belongs to the env);
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register until the env accepts
//      (200) or reports a first register already won (409);
//   3. poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true};
//   4. close the server and exit 0.
//
// Dev mode (MAKEFUN_ENV_URL unset): listen on FORGE_DEV_PORT (or an ephemeral
// port) and serve until killed, so the kit's sdk/run.ts can drive the forge
// exactly as the sealed suite would.

import { createApp } from './app.ts';
import type { Server } from 'node:http';

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff between retries: doubling from RETRY_FIRST_MS up to RETRY_CAP_MS. */
function backoffMs(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

/** POST the bound port to the env until it accepts; 400/405 are fatal. */
async function registerWithEnv(envUrl: string, port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let fatal: Error | null = null;
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) {
        await res.arrayBuffer().catch(() => undefined);
        return;
      }
      if (res.status === 400 || res.status === 405) {
        fatal = new Error(`register refused with HTTP ${res.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) fatal = err;
    }
    if (fatal !== null) throw fatal;
    await delay(backoffMs(attempt));
  }
}

/** Poll the env's /done until it reports completion; never return earlier. */
async function waitUntilDone(envUrl: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      } else {
        await res.arrayBuffer().catch(() => undefined);
      }
    } catch {
      // Env not answering yet or the poll timed out: not done, keep polling.
    }
    await delay(backoffMs(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp(process.env.MAKEFUN_SHOP_TOKEN ?? '');
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

  if (envUrl === '') {
    const devPort = Number(process.env.FORGE_DEV_PORT ?? 0);
    const port = await listen(server, Number.isInteger(devPort) && devPort > 0 ? devPort : 0);
    process.stdout.write(`[forge] dev mode, listening on port ${port}\n`);
    return; // Serve until the process is killed.
  }

  const port = await listen(server, 0);
  process.stdout.write(`[forge] listening on port ${port}\n`);
  await registerWithEnv(envUrl, port);
  process.stdout.write('[forge] registered with the env; waiting for done\n');
  await waitUntilDone(envUrl);
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await run();
  if ((process.env.MAKEFUN_ENV_URL ?? '') !== '') process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
