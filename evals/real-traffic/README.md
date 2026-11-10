# Real-traffic sample

Put genuine scripts here to measure the guardrails' **false-positive rate** (S13): how often
a real, harmless script is rejected at intake or flagged as a leak or a secret.

- One script per file: `.sql`, `.pls`, `.pkb`, `.pks`, `.sh`, `.ksh` or `.bash`.
- **Sanitize every script first.** Paste it into the application and save the sanitized
  source it shows, or copy `source.sanitized.*` from an approved conversion on the data
  branch. `npm run eval` skips any file that still contains a protected item and lists it
  as "skipped as not sanitized".
- Files in this directory are ignored by git (see `.gitignore`); only this README is
  committed. Commit samples deliberately, with `git add -f`, only after a person has read
  each one.

`npm run eval` prints `real-traffic sample: <blocked>/<samples> blocked (false-positive rate N%)`.
With no samples it prints that the rate was not measured.
