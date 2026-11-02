# Manual for Anything

Take a photo of what you have, and get plain, IKEA-style instructions for making something from it, animated in your
browser. It handles recipes, woodworking, bricks, yarn, repairs and written problems. Built for Meta's Global AI
Developer Hackathon 2026.

## Run locally

You need [Node.js 24 or newer](https://nodejs.org). It works the same on Windows, macOS and Linux.

```sh
npm install
npm start
```

Open <http://localhost:8080> to watch the saved examples. No API key needed.

To make manuals from your own photos, run this instead. It asks for your Meta Model API key the first time and saves it
in `.env.local`. Uploads make paid API calls.

```sh
npm run live
```

## How it works

| Step | Model | What it does |
| --- | --- | --- |
| Recognize | Muse Wonder, minimal effort | Lists the objects in the photo |
| Segment | SAM 3.1 | Cuts each object out of the photo |
| Plan | Muse Wonder, low effort | Designs the project and writes structured steps, which are validated and repaired |
| Draw | Muse Wonder, minimal effort | Turns each cut-out into a vector drawing |

Deterministic solvers then work out the geometry from the plan, and a fixed engine animates every step. Films play on a
browser canvas, with model-written drawing code running in a sandboxed iframe. Written problems skip segmentation and go
straight to an explanation.

**Why minimal effort for drawing?** More thinking didn't reliably make better drawings. In our
[comparison](http://localhost:8080/comparisons) (open it while the app is running), Muse Wonder sometimes drew better at
minimal effort: its rope kept the open loops that max effort filled in, and its scissors had cleaner handles. Minimal
took 8–15 s and about $0.03–0.05 per drawing, against 22–38 s and $0.08–0.12 at max. Each effort level has one attempt
per object, so this shows examples, not a success rate.

[MIT license](LICENSE). Bundled fonts use the SIL Open Font License.
