# gh-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/mxn-11/gh-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/mxn-11/gh-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in a single Node 22 process: git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API, GraphQL v4 and an MCP endpoint, all served from its own store — no UI, no database, no git binary. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty.

## Run it

```sh
node main.ts
```

Node 22, standard library only — there is nothing to install. In the suite's
trial mode (`MAKEFUN_ENV_URL` set) the forge binds an ephemeral port, POSTs it
to `$MAKEFUN_ENV_URL/register`, serves until the env answers
`GET $MAKEFUN_ENV_URL/done`, then exits 0. Every surface sits behind
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN` except `GET /healthz`.

For local development, leave `MAKEFUN_ENV_URL` unset and pick a port:

```sh
FORGE_DEV_PORT=8791 MAKEFUN_SHOP_TOKEN=dev-token node --experimental-strip-types main.ts
```

then drive it with the bounty kit's suite
(`node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:8791 --token dev-token [--perf]`),
with curl, or with any git/GraphQL/MCP client.

## Layout

- `main.ts` — the env lifecycle (bind, register, poll done, exit 0)
- `app.ts` — the HTTP front door: routing, the bearer-token gate, request ids
- `store.ts` — forge state and rules: repos, issues, pulls, contents commits,
  squash merges; a logical clock and counter ids keep runs deterministic
- `gitobj.ts` — the git object model: sha1 objects, trees, commits, tags,
  pack read/write with ofs/ref deltas, pkt-lines
- `githttp.ts` — smart HTTP: protocol v2 advertisement and ls-refs, fetch
  (shallow, deepen, incremental), receive-pack with report-status
- `rest.ts` — the REST v3 surface
- `graphql.ts` — a small GraphQL parser/executor with introspection,
  `node(id:)`, cursor pagination and the issue/pull mutations
- `mcp.ts` — MCP over Streamable HTTP: `server/discover` (2026-07-28),
  the legacy `initialize` handshake, and six tools on the shared store

---

<sub>Entered on [make.fun](https://make.fun/?ref=cqm0y9a1&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
