import { ISSUE_CATALOGUE } from '@/pipeline/issue-codes';
/** Prints the issue-code catalogue as a Markdown table (used to refresh the README). */
console.log('| Code | Severity | Meaning | Next step |\n|---|---|---|---|');
for (const [code, i] of Object.entries(ISSUE_CATALOGUE)) console.log(`| \`${code}\` | ${i.severity} | ${i.explanation} | ${i.nextStep} |`);
