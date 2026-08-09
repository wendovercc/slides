# Claude Code — Project Notes

## Commits
Do not commit changes unless explicitly asked to. Stage and propose, but wait for the prompt.
When asked to commit, commit directly on `main` — do not create a feature branch.

**"Commit this" applies to that one change, in that one turn.** It is never standing
approval for whatever comes next. In particular, do not commit because:
- an earlier change in the session was approved for commit;
- the work is finished, tested and obviously correct;
- it's a follow-up, a hotfix, or the tail of an incident that's still in progress.

Each change gets reviewed before it lands, however urgent it looks. Finish the work,
`git add` it, summarise the diff, and stop.

## Slide design
Before editing or adding slide templates, consult `docs/design-conventions.md`. It covers the layout bases, design tokens, carousel/table component classes, and numeric/empty-state conventions. New slides should follow these — don't introduce parallel patterns.

## UI verification
Don't drive the browser (Playwright/screenshots) to visually verify UI changes — the user does that themselves. After a UI edit, a syntax check (e.g. `node --check`) and a plain description of what changed is enough; skip the headless-browser walkthrough unless explicitly asked. Still verify non-visual logic (data/build/merge) programmatically as normal.
