# samohost — Claude Code guidance

<!-- SAMO-DEV-PRINCIPLES:START (synced block — update the canonical source then re-sync; do not edit in place) -->
## Development principles

Accumulated, non-negotiable working principles for SAMO projects. Canonical source: Tanya301/SAMO-Platform-Onboarding > PRINCIPLES.md. Keep this block in sync.

### 1. Re-review after ANY post-review change — green CI is not "reviewed"
Once a reviewer (samorev) approves an MR/PR, **any** later commit invalidates that approval — **including a commit that fixes the review's own findings**. Re-review the change (at minimum the new delta) **before** merge. Never merge a post-review commit on the strength of the prior PASS plus a green pipeline: a passing pipeline proves it builds and tests pass, not that it was reviewed.

Order: review → fix-commit → **re-review the delta** → merge.  (NOT: review → fix-commit → merge.)
<!-- SAMO-DEV-PRINCIPLES:END -->
