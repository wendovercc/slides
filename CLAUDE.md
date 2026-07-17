# Claude Code — Project Notes

## Commits
Do not commit changes unless explicitly asked to. Stage and propose, but wait for the prompt.
When asked to commit, commit directly on `main` — do not create a feature branch.

## Slide design
Before editing or adding slide templates, consult `docs/design-conventions.md`. It covers the layout bases, design tokens, carousel/table component classes, and numeric/empty-state conventions. New slides should follow these — don't introduce parallel patterns.

## UI verification
Don't drive the browser (Playwright/screenshots) to visually verify UI changes — the user does that themselves. After a UI edit, a syntax check (e.g. `node --check`) and a plain description of what changed is enough; skip the headless-browser walkthrough unless explicitly asked. Still verify non-visual logic (data/build/merge) programmatically as normal.
