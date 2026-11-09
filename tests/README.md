# Tests

```bash
npm test                # legacy scripts/test-*.mjs, then the Vitest suite
npm run test:unit       # Vitest only
npm run test:coverage   # Vitest with the coverage report and floor (what CI runs)
npx vitest run tests/server/api/hls.test.js   # one file
```

CI (`.github/workflows/ci.yml`) runs lint, both test sets and the build on every pull request
to `master`, and fails if coverage drops under the floor in `vitest.config.mjs`.

## Layout

| Folder | Project | What it covers |
|---|---|---|
| `tests/server/core/` | `server` (Node) | `db.js`, `watchTracking.js`, `timeline.js`, `hlsGateways.js`, `videoStatus.js`, `watch-durations.cjs` |
| `tests/server/api/` | `server` (Node) | every `server.js` endpoint, through supertest |
| `tests/player/main/` | `player` (jsdom) | `src/main.js`, booted against a fake Video.js player |
| `tests/player/modules/` | `player` (jsdom) | the other `src/` modules |
| `tests/_infra/` | `server` | checks on the harness itself |

## How the harness works

- Every test file runs in its own process, so module state never leaks between files.
- **Mongo:** one in-memory `mongod` per run (`tests/setup/mongo-global.js`), with a fresh database per
  file. The server code uses its real `db.js` against it. Seed and inspect rows with
  `tests/helpers/mongo.js`.
- **No secrets, no network:** `tests/setup/node.js` disables dotenv, clears the env vars the code
  reads and sets test values. `fetch` throws unless a test stubs it (`vi.stubGlobal('fetch', ...)`).
- **CommonJS code** (`server.js`, `db.js`, ...) is loaded with `createRequire`. `vi.mock` does not
  reach its internal `require` calls, so replace dependencies through `require.cache` (see
  `tests/server/core/_helpers/load.js`). `server.js` is booted by `tests/server/api/_helpers/loadServer.js`,
  which captures the Express app instead of listening on a port.
- **Time:** fake only `Date` in server tests (`vi.useFakeTimers({ toFake: ['Date'] })`); faking all
  timers stalls the Mongo driver and supertest.

## Expectations for pull requests

- A change to business logic lands with tests for it in the same PR.
- A test that fails on behaviour you did not mean to change is a bug report: fix the code, not the test.
- Raise the coverage floor in `vitest.config.mjs` when coverage goes up; never lower it to get a PR through.
- Known bugs are pinned as `it.skip('BUG: ...')` tests that assert the correct behaviour. Fixing
  the bug means removing `.skip` in the same PR.
