# Working on Manual for anything

Read `README.md` for setup and how it works.

## Product and scope

One photo becomes plain, useful, IKEA-style instructions played on a browser canvas. Support many domains,
including cooking, woodworking, bricks, yarn, repairs and written problems. Keep tools, operations and solvers
general. Captions should give usable amounts, times and measurements. Do not invent measurements or confirmation.
The project is for Meta's Global AI Developer Hackathon and is MIT licensed; fonts have separate OFL licenses.

## Current architecture

- `src/server/` serves the app, starts generation jobs and streams events/program updates (`server.mjs`), and holds
  accounts, access control, job limits and persistence. `repository.mjs` persists films in SQLite; `storage.mjs` uses
  local files in development and Azure in production. User data is Git-ignored.
- `src/pipeline/` turns a photo into saved assets and timing information for browser playback (`run.mjs`), including
  planning and validation (`plan.mjs`, `plan-schema.mjs`, `validate.mjs`).
- `src/film/` builds animation programs (`engine.mjs`) and assembles them from available assets (`film.mjs`).
- `src/solvers/` solves geometry (`layout.mjs`, `scene.mjs`, `joints.mjs` and others). `contracts.mjs` and
  `operations.mjs` describe and check operation semantics.
- `src/kit/` is the browser drawing kit, built from `programKit.ts`. `assets/fonts/` holds the fonts.
- `public/` is the browser app; `public/player.js` plays programs in a sandboxed iframe. `prompts/` holds model prompts.
- `examples/` holds the saved films and photos used for offline examples.
- `benchmarks/` holds benchmark tools and published data. `scripts/` holds operator and developer commands.
- `tests/` holds all tests, with shared helpers and data in `tests/support/`.

The native renderer, MP4 export and image critic were removed. Use browser playback and recording-canvas checks.
The old render-count estimator was also removed: its motion-blur counts did not measure browser playback cost.
Segmentation always uses Meta's SAM API (`src/pipeline/segment.mjs`), and `sharp` handles images. The project needs only
Node: keep it runnable on Windows, macOS and Linux with `npm install`. No Python, local model or GPU is used.

## Models and credentials

Generation uses the Meta API exclusively, configured by `MODEL_API_KEY` and `META_MODEL` in the root ignored
`.env.local`. Environment variables take precedence. Never print or commit credentials. The optional CLI backend
and finale comparison override have been removed. All physical plans, including saved examples, must declare
contract version 2; unversioned plans and unresolved numeric assemblies are rejected.

Paid calls need explicit authorization: do not make real model calls, run paid planner benchmarks, generate new
films or run full paid pipelines without it. Mocked HTTP and recording-canvas tests are allowed.

## Development checks

Keep browser playback responsive. Avoid extra full-canvas passes, large filters/gradients and unnecessary animation.
Run relevant offline tests; the full Node suite normally finishes within a minute:

```sh
node --test tests/*.test.mjs
```

`node scripts/frames.mjs --all` checks saved fixtures without model calls or native rendering. Treat real model
quality and latency as unverified unless tested; historical critic scores are not evidence about current code.
Checks should finish within one minute. Do not run long sweeps, frame-by-frame image rendering or background wait
loops. Check the test process's exit code before committing.

## Repository rules

- Preserve existing user changes. Do not push or create a GitHub repository unless explicitly asked.
- Generated code is untrusted. A refused-word filter is not a sandbox. Do not evaluate generated code in Node outside the demonstration vm check; the browser player is its sandbox.
- Report what was actually tested and distinguish offline validation from fresh provider/visual validation.
