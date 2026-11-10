import type { Platform } from './types';

const SQL_TAGS: [string, RegExp][] = [
  ['cursor-loop', /\b(cursor\b[\s\S]{0,400}?\bloop\b|for\s+\w+\s+in\s*\()/i],
  ['commit-in-loop', /\bloop\b[\s\S]{0,2000}?\bcommit\b[\s\S]{0,400}?\bend\s+loop\b/i],
  ['dynamic-sql', /\bexecute\s+immediate\b|\bdbms_sql\b/i],
  ['dynamic-sql-concat', /execute\s+immediate[\s\S]{0,300}?\|\|/i],
  ['when-others-null', /when\s+others\s+then\s+null/i],
  ['existence-check', /\b(user_tables|all_tables|user_objects|all_objects|user_indexes|user_sequences|user_tab_columns)\b/i],
  ['count-existence', /select\s+count\s*\(\s*\*\s*\)\s+into/i],
  ['sqlplus-spool', /^\s*spo(ol)?\s+\S/im],
  ['whenever-sqlerror', /^\s*whenever\s+sqlerror/im],
  ['substitution-variable', /&&?\w+/],
  ['dbms-job', /\bdbms_job\b/i],
  ['traditional-audit', /^\s*(no)?audit\s+(?!policy)/im],
  ['utl-file', /\butl_file\b/i],
  ['merge', /\bmerge\s+into\b/i],
  ['bulk-collect', /\bbulk\s+collect\b|\bforall\b/i],
  ['ddl', /^\s*(create|alter|drop)\s+(table|index|sequence|view|synonym)\b/im],
  ['package', /create\s+(or\s+replace\s+)?package\b/i],
  ['trigger', /create\s+(or\s+replace\s+)?trigger\b/i],
  ['peoplesoft-record', /\bPS_[A-Z0-9_]+\b/],
];
const SHELL_TAGS: [string, RegExp][] = [
  ['sqlplus-heredoc', /\bsqlplus\b[^\n]*<</],
  ['sftp', /(^|[\s;|&])sftp\s/m],
  ['scp', /(^|[\s;|&])scp\s/m],
  ['ssh', /(^|[\s;|&])ssh\s/m],
  ['ftp', /(^|[\s;|&])ftp\s/m],
  ['mailx', /\b(mailx|sendmail)\b|(^|[\s;|&])mail\s+-s/m],
  ['psae', /\bpsae\b/],
  ['data-mover', /\bpsdmtx\b/],
  ['sqr', /\bpssqr\b/],
  ['sqlldr', /\bsqlldr\b/],
  ['datapump', /\b(expdp|impdp)\b/],
  ['rman', /\brman\b/],
  ['exit-code-check', /\$\?/],
  ['set-e', /^\s*set\s+-\w*e/m],
  ['trap', /^\s*trap\s/m],
  ['getopts', /\bgetopts\b/],
  ['text-pipeline', /\b(grep|sed|awk|cut|sort|uniq|wc)\b[^\n]*\|/],
  ['file-ops', /(^|[\s;|&])(find|cp|mv|rm|tar|gzip)\s/m],
  ['lock-file', /\b(lock|\.lck|flock)\b/i],
  ['date-arithmetic', /\bdate\s+(-d|\+)/],
  ['background-jobs', /&\s*$|\bwait\b/m],
  ['cron', /\bcron(tab)?\b/i],
];

/** Tags for the constructs present in a unit. Used for memory retrieval and rule triggers. */
export function detectConstructs(text: string, platform: Platform): string[] {
  const table = platform === 'plsql' ? SQL_TAGS : [...SHELL_TAGS, ...SQL_TAGS.filter(([t]) => ['peoplesoft-record', 'sqlplus-spool', 'whenever-sqlerror'].includes(t))];
  return table.filter(([, re]) => re.test(text)).map(([t]) => t);
}
