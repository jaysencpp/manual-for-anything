`published/` contains the four saved films shown on the examples page. Folder names are their original film IDs, except `colour-bridge` and `pencil-cat`, which were generated directly by the pipeline. `pencil-cat` was made from a photo of a blank sheet and a note giving each part of the cat's position and size. Its layout was then solved again offline with the sheet-orientation fix in the same change; no model output was edited.
These contain playback assets and recorded timings, so viewing them makes no model calls.

`fixtures/` contains older recordings used by regression tests. They are not listed or served as public examples.
Tests select them with the server's `--examples-dir` option.
