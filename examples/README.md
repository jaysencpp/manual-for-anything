`published/` contains the five saved films shown on the examples page. Folder names are their original film IDs, except `colour-bridge`, `pencil-cat` and `ladder-problem`, which were generated directly by the pipeline. `ladder-problem` was made from a photo of a printed ladder problem and a note asking for it to be drawn and the ladder to slide; it is kept exactly as the pipeline wrote it, apart from a local photo path. `pencil-cat` was made from a photo of a blank sheet and a note giving each part of the cat's position and size. Its layout was then solved again offline with the sheet-orientation fix in the same change; no model output was edited.
These contain playback assets and recorded timings, so viewing them makes no model calls.

`fixtures/` contains older recordings used by regression tests. They are not listed or served as public examples.
Tests select them with the server's `--examples-dir` option.
