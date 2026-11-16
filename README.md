# gh-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/mxn-11/gh-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/mxn-11/gh-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in a single Node 22 process: git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API, GraphQL v4 and an MCP endpoint, all served from its own store — no UI, no database, no git binary. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty.

## Run it

```sh
node main.ts
```

The forge binds an ephemeral port and registers it with the suite at `$MAKEFUN_ENV_URL`; it is driven by the make.fun conformance suite as its only client.

---

<sub>Entered on [make.fun](https://make.fun/?ref=cqm0y9a1&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
