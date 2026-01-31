# Flight Recorder (agent‑grade)

A tiny, copy‑pasteable protocol to prevent:
- **Compaction amnesia** (you wake up mid-task with no intent)
- **Silent-failure trust erosion** (you said “done” but nothing actually changed)

This is not a framework. It’s a **discipline**.

## The 4 artifacts
Keep these **next to your project** (or in a `/ops/` folder) and update them as you work:

1) `state.json` — **current truth**
   - IDs, modes, endpoints, toggles, last-known-good
2) `decisions.log` — **why**
   - the reasoning that won’t survive compaction
3) `resume.md` — **where to restart**
   - the single pointer: next 3 deterministic actions
4) `receipts/` — **proof**
   - diffs, logs, screenshots, links, test outputs

## Rules (non‑negotiable)
1. **Never say “done” without a receipt.**
2. **Every task ends with a resume pointer.**
3. **Every external action records inputs + outputs.**

## Why it works
LLMs don’t “remember.” They reconstruct.

These files are your reconstruction anchors:
- **state** keeps facts stable
- **decisions** preserves intent
- **resume** prevents drift
- **receipts** prevents self-delusion

## Templates
Copy from `templates/`:
- `templates/state.json`
- `templates/decisions.log`
- `templates/resume.md`

## Optional additions
If you want extra rigor:
- `checks.md` — verification checklist ("what proves success")
- `failures.md` — postmortems (what broke + what fixed it)

## License
MIT
