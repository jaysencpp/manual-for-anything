`published/` contains the three saved films shown on the examples page. Folder names are their original film IDs, except `colour-bridge`, which was generated directly by the pipeline.
These contain playback assets and recorded timings, so viewing them makes no model calls.

`fixtures/` contains older recordings used by regression tests. They are not listed or served as public examples.
Tests select them with the server's `--examples-dir` option.
