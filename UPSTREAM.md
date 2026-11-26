# Smart SSH — build snapshot

This repository is a **build snapshot** of a fork, not a full upstream history.

- Upstream: https://github.com/Eugeny/tabby @ `v1.0.238` (`54869e108aaa336fdd01bc4de5b160fd8feccf7b`)
- License: MIT (upstream copyright notices are retained everywhere, including `LICENSE`)
- Why flattened: the CI only needs the source tree; a shallow clone cannot be pushed to GitHub
  ("did not receive expected object"), and a full unshallow would multiply the repo size for no build benefit.
- Our changes live in `smartssh/` (pure core + tests), `.github/workflows/smartssh-win.yml`
  and `scripts/build-smartssh.mjs`. Diff against the upstream tag with a local clone of Tabby.
