# Functional prompt for a human-reviewed conversion workbench (reusable)

**How to use this file.** Edit only `<project>`. Everything else is project-independent and describes *what the application does for its user*, function by function. The reference values describe Script Modernizer (`purush001/unix-to-python`) as built on 2026-11-11. Send the whole file as the first message to a coding agent, or keep it in the repository and send one function ID per session ("build F7").

This prompt covers behaviour. It does not cover engineering standards (secrets, adapter, guardrails, evals, tracing). For those, use the production standards prompt alongside it; where the two disagree, the standards prompt wins on safety and this prompt wins on what the user sees.

---

<role>
You are a senior product engineer. You build a single-page workbench in which a person pastes an input, receives a machine-made draft, reviews it, changes it, and approves it. You treat every function below as a contract: it is done only when its "Done when" lines can be shown true by a test. You never report a function as working unless you ran that test.
</role>

<project>
Replace the right-hand column for a different project. Refer to these by ID.

| ID | Parameter | Reference value (Script Modernizer) |
|---|---|---|
| P1 | Product name and one-line promise | Script Modernizer. Headline: "SQL and Shell ==> SQL and Python" |
| P2 | User | DBAs, on an internal single-tenant tool |
| P3 | Input | A pasted script: Oracle 19c SQL, PL/SQL, SQL\*Plus, or ksh/bash. At most 200 KB and 5,000 lines |
| P4 | Output | SQL and PL/SQL that run unchanged on Oracle 19c and 26ai; Python 3.11+ in place of shell |
| P5 | Input types offered in the selector | Auto-detect, SQL, PL/SQL, SQL\*Plus, Shell, Mixed shell + SQL |
| P6 | Built-in examples | "ksh + sqlplus heredoc", "PL/SQL cursor loop" |
| P7 | What must be hidden before anything is stored or sent | E-mail addresses, person names, hosts and IP addresses, remote users, passwords and keys, personal values |
| P8 | Output files of one conversion | `target.sql` or `target.py`; `config.ini.template` and `requirements.txt` when needed; `script_runtime.py` for Python |
| P9 | Where an approved result is saved | A dated folder on a data branch in GitHub, with the sanitized source, the output files, a witness and a report |
| P10 | Hard limits of the product | No user script is ever executed. Nothing is final until a person approves it. Nothing is contacted on the user's behalf |
| P11 | Out of scope input | PeopleCode, SQR, COBOL, Application Engine definitions, Data Mover bodies, prose, HTML, JSON, Python, binary files |
| P12 | Working mode without any keys | A deterministic built-in converter (mock) stands in for the model; every provider has a mock |
</project>

<principles>
These hold in every function. If a function seems to need an exception, stop and ask.

1. **The person decides.** The application drafts; a person edits, deletes, asks for fixes and approves.
2. **Say what happened.** After any action, the page states the result in plain words: what was fixed and what was not, what was deleted and what was kept, which version is on screen.
3. **Hide, do not destroy, the review record.** Deleting an entry from a review list removes it from view and keeps it in the stored record, marked as deleted, with a way to restore it. Only "delete a run" and "delete a rule" destroy data, and both ask first.
4. **A check cannot be switched off from the page.** Deleting an error from a list never changes the draft's status. Editing by hand goes through the same checks as a machine draft.
5. **Only cleaned text is stored, shown or sent.** This applies to pasted input, to model output and to what a person types into an editor or a note.
6. **Every version is kept.** A new draft never replaces an older one.
7. **Works with no keys.** Every function below works on the mocks (P12) and has a test that runs without a network.
</principles>

<functions>
Each function has an ID, what the user can do, the rules, and "Done when".

### F1. Unlock
- The page opens on a short intro animation that can be skipped with a button or Escape, plays once per session and is replaced by its end state when reduced motion is requested.
- The workbench is locked until the person enters the shared access token. The token stays in the browser tab only and is sent only to this application.
- Done when: a wrong token shows a clear message and nothing else is reachable; reloading the tab keeps the session.

### F2. Provide the input
- A source editor for pasting; a "Script type" selector (P5); a "Generate config file" tick box; "Load example" buttons (P6); "New script" clears everything.
- Empty input and input over the size limit (P3) are refused with a message that states the limit.
- Done when: Convert is disabled while the editor is empty; an oversize paste returns the size message.

### F3. Detect the input type
- "Auto-detect" decides the type by rules, with no model call. It accepts full scripts and everyday fragments: one statement with no terminator, or a few commands with no interpreter line.
- Text that reads like prose is refused, including prose that contains command words. Wrong content types (P11) are refused, and the selector cannot override that.
- After a conversion the page shows what was decided: "Detected: <type>" (or "Converted as: <type>" when the person chose).
- A refusal tells the person to pick the type in the selector and convert again.
- Done when: a table of at least fifteen accepted fragments and eight prose samples passes; a refused input shows the hint.

### F4. Clean the input
- Before anything else, protected items (P7) are replaced with placeholders. The person sees counts only ("2 emails, 1 host replaced"), never the mapping.
- After conversion the source editor shows the cleaned text, and says so.
- Items hidden by encoding tricks (invisible characters, percent-encoding, full-width characters) are found, and a warning says they were normalized.
- If cleaning fails, the run stops before any provider is called.
- Done when: seeded names, hosts and secrets appear nowhere in the draft, the lists, the stored run or the saved files.

### F5. Convert and show progress
- "Convert" runs fixed stages and shows each as waiting, active, done or skipped: intake, generate, validate, repair, review, results.
- A long conversion that runs out of time is resumed automatically from the next stage; the person sees one continuous run.
- A provider failure before any draft shows the provider's real error. A failure after a draft keeps the last usable draft and says so.
- Done when: all six stages reach a final state for both examples; a forced timeout resumes and finishes.

### F6. Read the draft
- Two editors side by side: cleaned source on a light surface, target on a dark surface, with syntax colours.
- A label shows Draft, "Approved, not saved" or Final; the version ("version 2 of 3"); and the status: ok, ok with warnings, or failed.
- Tabs for each output file (P8); a version switcher; "Diff" against the source or any earlier version; "Copy" and "Download".
- Done when: every file of a conversion can be opened, diffed, copied and downloaded; switching versions changes both the target and the review lists.

### F7. Review record
- **Change list:** one item per change with a rule ID, the lines, a one-line summary, the reason and a risk level (low, medium, high).
- **Sanitization:** the counts from F4.
- **Warnings by code:** each code with its severity, count and lines.
- **Suggestions:** ideas that were deliberately not applied, labelled "not applied".
- The run ID is shown here, with a note to quote it when reporting a problem.
- Done when: every change in the target appears in the change list; no rule ID is shown that was not supplied to the model or built in.

### F8. Feedback panel
- Every finding of the current draft in plain language: severity, code, where it is, what it means and the next step.
- The same finding on several lines is one entry with a button per line. Findings with different messages stay separate.
- Selecting an entry jumps to its line in the target and marks the matching source line.
- Each entry has four actions:
  - **Change output:** opens the target for editing at that line (F9).
  - **Ask for a fix:** requests a new draft with a note built from the entry's code, line, message and next step. Afterwards a banner says **Fixed** or **Not fixed** for that entry, decided by looking at the new draft. "Not fixed" points to "Change output".
  - **Report a problem:** sends the entry, with an optional comment, as feedback.
  - **Delete:** removes the entry from the list (F11). It works on errors too.
- Done when: a fixable entry shows "Fixed" and is gone from the new draft; an unfixable one shows "Not fixed"; a finding on two lines is one entry.

### F9. Edit the target by hand
- "Edit <file>" under the target editor makes the file editable. "Save as version N" stores the edit as a new draft version. "Cancel" discards it.
- The edit goes through cleaning (F4) and the same checks as a machine draft. No model is called, and the new version carries a warning that the independent review did not run on it.
- The change list gains an entry that says the file was edited by the reviewer.
- Only the latest version of an unapproved draft can be edited. Files the application writes itself (for example the shared runtime) cannot be edited.
- Switching file or version, or opening the diff, cancels an edit in progress.
- Done when: an edit becomes a new version and the old one is unchanged; a broken edit shows an error; a typed secret or host is replaced and reported.

### F10. Request changes
- "Request changes" takes a note and produces a new draft from the original input. Earlier drafts and the notes are kept and listed.
- Done when: the new version shows the note that produced it.

### F11. Delete from the review lists
- Every change-list item and every feedback entry has **Delete**. Deleted items move to a collapsed "Deleted" list with **Restore**.
- Nothing is destroyed: deleted items stay in the stored draft and are marked as deleted in the saved report.
- Deleting an error hides it only. The draft's status stays "failed" until the error is fixed.
- Delete and Restore stay available after approval. A report already saved is not rewritten.
- Done when: delete, reload and restore each behave as described; the status pill is unchanged by deleting an error.

### F12. Approve and save
- "Approve version N" is a separate, deliberate action. It marks the version final and saves it (P9).
- If saving fails, the run stays approved, the error is shown, and "Retry save" tries again. The approved output is never lost.
- Every file is scanned again immediately before saving; any protected item stops the save.
- Done when: a forced save failure shows "Approved, not saved" and a retry reaches "Final".

### F13. Rate
- After approval the person can rate the result from 1 (unusable) to 5 (excellent), with an optional comment.
- Done when: the rating is stored with the run and shown in the status view.

### F14. Status view
- Opened by a "Status" button. Shows which providers are real or mock; runs by state; repair and retry rates; save failures; stage durations (p50, p95); failures by code; rating distribution; memory retrieval figures.
- **Recent runs:** one row per run with state, type, target, draft status, repairs, rating and creation time. Each row has **Delete**, which asks "Delete for good" or "Keep". Deleting removes the run and its feedback from storage for good. A copy already saved (P9) is kept. A run that is still converting is refused. If the deleted run is on screen, the workbench is cleared.
- **Learned rules:** each rule with its status, guidance, where it came from and its witness report. A promoted rule can be **Disabled** (kept but switched off). Any rule can be **Deleted** with the same confirm step; it leaves the search index first, and if the index cannot be reached the delete is refused.
- Done when: both deletes need two clicks, report what was kept, and are covered by a browser test.

### F15. Learning loop
- After an approval with a signal (a reviewer note, more than one draft, a repair, a low rating or a problem report), the application proposes a candidate rule.
- A background job tests each candidate against the eval suite, with and without it, and promotes it only if nothing regresses and something improves. Otherwise it is rejected with a reason.
- Learned rules guide drafting only. They never change cleaning, checks or guardrails.
- Done when: a rejected candidate shows its reason and a promoted one shows its witness report.

### F16. Output standard
- State, for P4, the rules every output must meet, and check them in code. Reference:
  - SQL and PL/SQL use only syntax common to both database releases; anything else is an error with the replacement named.
  - Results, side effects, transaction boundaries, error behaviour and exit codes are preserved.
  - Every owned PL/SQL unit records the failing line and message, then re-raises.
- **Keep generated code short.** Boilerplate that is the same in every output lives in one shared file written by the application (`script_runtime.py`), delivered next to the output. A converted script holds only its own logic and calls the shared entry point. The model is shown the shared file's interface, never its body.
- Done when: for the reference fixtures a converted Python script is under 140 lines, repeats none of the shared file, and uses no name it does not define or import.

### F17. Built-in converter (mock)
- With no model configured, a deterministic converter produces real drafts for common inputs and marks what it cannot convert.
- It acts on a small, named set of fix requests by rule (reference: add a spool file; move a stand-alone commit out of a loop; add a missing statement terminator). For everything else it changes nothing, and F8 reports "Not fixed".
- Done when: each rule-based fix has a test, and an unsupported request leaves the draft unchanged.

### F18. Messages
- Every finding has a code from one closed list, a severity, a plain explanation and a next step. Code compares codes, never text.
- Every error response has a code, a message and, where there is one, the run ID.
- Done when: the catalogue in the README is generated from the code list and matches it.

### F19. Look and feel
- One page. A dark hero with the product name, the headline (P1), one supporting sentence, three short promises and an illustration; below it a light workbench of rounded cards.
- Primary actions use one accent treatment; destructive confirmation uses the error colour.
- Every text and background pair meets WCAG AA, measured, not estimated. Focus is always visible. The layout works at phone width.
- System fonts only; no third-party scripts.
- Done when: contrast figures are recorded next to the palette, and the page is checked at 1440 and 390 pixels wide in each main state.
</functions>

<api>
One route per action. All need the access token except health and scheduled jobs.

| Route | Function |
|---|---|
| `POST /api/convert` | F5 |
| `POST /api/runs/:id/resume` | F5 |
| `GET /api/runs/:id` | reload recovery |
| `DELETE /api/runs/:id` | F14 |
| `POST /api/runs/:id/revise` | F8 "Ask for a fix", F10 |
| `POST /api/runs/:id/edit` | F9 |
| `POST /api/runs/:id/dismiss` | F11 (one or several items) |
| `POST /api/runs/:id/approve` | F12 |
| `POST /api/runs/:id/feedback` | F8 "Report a problem", F13 |
| `GET /api/runs/:id/trace` | support: spans, cost and scores for a run ID |
| `GET /api/status` | F14 |
| `POST /api/rules/:id/disable`, `DELETE /api/rules/:id` | F14 |
| `GET /api/health` | which providers are real or mock |
</api>

<decisions_to_confirm>
These were settled by the product owner during the reference build. Ask before changing any of them.

1. Delete in the review lists hides and can be restored; it is not permanent (F11).
2. Errors can be deleted from the feedback panel, and that does not change the status (F11).
3. Delete stays available after approval (F11).
4. "Ask for a fix" starts again from the original input, so it does not keep an earlier hand edit (F8, F9).
5. Deleting a run or a rule keeps the copy already saved elsewhere (F14).
6. Converted Python needs the shared runtime file beside it (F16).
7. The real model is off; the product runs on the built-in converter until the owner turns the model on (P12).
</decisions_to_confirm>

<workflow>
1. Read the repository and its rules. List anything in `<project>` you cannot map to the code.
2. Build or change one function at a time, in this order when starting from nothing: F1, F2, F4, F3, F5, F6, F7, F8, F10, F12, F9, F11, F13, F14, F15, F16, F17, F18, F19.
3. For each function: write the test from "Done when", make it pass on mocks, then check the page in a browser.
4. Never weaken a check or a test to make a function pass. If a function conflicts with a principle, stop and ask.
5. After each function, update the README section that describes it.
</workflow>

<acceptance>
The work is done when every line is true and has evidence.

- Every function F1 to F19 has at least one passing test named after it.
- A browser test covers, in one flow: convert, edit by hand, delete and restore a change and a feedback entry, delete an error, ask for a fix (one fixed, one not fixed), approve with a failed save and a retry, rate, delete a rule, delete the run.
- Seeded protected values (P7) appear in no output, list, stored run or saved file.
- The page was checked at desktop and phone width.
- The README describes each function as built, and lists what is not done.
</acceptance>

<reporting>
End each session with this report and nothing else.

```
Function: <ID and name>
Done: <files changed, one line each>
Evidence: <commands run and their summary lines>
Not done: <item and reason>
Decision needed from you: <question, or "none">
```
</reporting>
