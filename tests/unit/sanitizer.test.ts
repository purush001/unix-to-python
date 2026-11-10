import { describe, expect, it } from 'vitest';
import { loadFixtures, SEEDS } from '@evals/suite';
import { classify } from '@/agents/orchestrator';
import { countSummary, sanitize, scanSanitized, scanSecrets } from '@/sanitizer';

const S = (text: string, lang: 'shell' | 'sql' = 'shell') => sanitize(text, lang, []);

describe('sanitizer', () => {
  it('maps the same name to the same placeholder everywhere, in order of first appearance', () => {
    const r = S(`#!/bin/sh
# Author: Margaret Okafor
# Modified by: Rajesh Venkataraman
# 2018-04-02  M. Okafor   first version
# 2019-01-10  Okafor, Margaret  fix
cd /home/mokafor/bin
cp /home/rvenkat/x /tmp
# contact margaret.okafor@northwind-hr.com or rvenkat@northwind-hr.com
# Owner: rvenkat
`);
    expect(r.text).toContain('# Author: dev1');
    expect(r.text).toContain('# Modified by: dev2');
    expect(r.text).toContain('# 2018-04-02  dev1 ');
    expect(r.text).toContain('# 2019-01-10  dev1 ');
    expect(r.text).toContain('/home/dev1/bin');
    expect(r.text).toContain('/home/dev3/x'); // a user id cannot be tied to a full name, so it is its own person
    expect(r.text).not.toMatch(/Okafor|mokafor|Venkataraman|rvenkat|northwind/i);
    expect(r.text.match(/ops@script\.com/g)).toHaveLength(2);
    expect(r.text).toContain('# Owner: dev3');
    expect(r.counts.names).toBe(3);
    expect(r.counts.emails).toBe(2);
  });

  it('assigns source and target roles to hosts and users', () => {
    const r = S(`#!/bin/sh
scp batchusr@dbhost07.corp.example.com:/exports/in.dat /tmp/in.dat
scp /tmp/out.dat pushusr@10.9.8.7:/inbound/
ssh -l opsadm apphost22.corp.example.com "ls"
if [ "$(hostname)" = "dbhost07" ]; then echo ok; fi
sqlplus -s sysadm/\${DB_PASSWORD}@//dbhost07.corp.example.com:1521/HCMPRD @x.sql
`);
    expect(r.text).toContain('scp source_user@source_server:/exports/in.dat /tmp/in.dat');
    expect(r.text).toContain('scp /tmp/out.dat target_user@target_server:/inbound/');
    expect(r.text).toContain('ssh -l target_user_2 target_server_2 "ls"');
    expect(r.text).toContain('= "source_server"');
    expect(r.text).toContain('@//source_server:1521/HCMPRD');
    expect(r.text).toContain('sysadm/'); // schema names are kept
    expect(r.counts.hosts).toBe(3);
    expect(r.counts.users).toBe(3);
  });

  it('decides ftp/sftp roles from put and get, and warns when the role is ambiguous', () => {
    const r = S(`#!/bin/sh
ftp -n files.partner-bank.com <<END
user bankusr S3cr3t!pw
get statement.txt
END
curl -s https://wiki.corp.example.com/runbook
`);
    expect(r.text).toContain('ftp -n source_server <<END');
    expect(r.text).toContain('user source_user ${SOURCE_PASSWORD}');
    expect(r.warnings.map((w) => w.code)).toEqual(['SANITIZE_HOST_ROLE_AMBIGUOUS']);
    expect(r.text).toContain('https://target_server/runbook');
    expect(r.highlightLines).toEqual([6]);
  });

  it('removes every secret and replaces it with a config or environment reference', () => {
    const r = S(`#!/bin/sh
DB_PASS=Welcome123
export FTP_PASSWORD='p@ss w0rd'
API_TOKEN=$(cat /secure/.token)
sqlplus -s sysadm/Secr3t9@HRPRD @run.sql
sqlldr userid=sysadm/Secr3t9@FINPRD control=x.ctl
psae -CT ORACLE -CD HRPRD -CO VP1 -CP Secr3t9 -R X -AI Y
`);
    expect(r.text).not.toMatch(/Welcome123|p@ss w0rd|Secr3t9|\.token/);
    expect(r.text).toContain('DB_PASS="${DB_PASS:?set DB_PASS in the environment}"');
    expect(r.text).toContain('sysadm/${DB_PASSWORD}@HRPRD');
    expect(r.text).toContain('-CP "${PS_OPR_PASSWORD}"');
    expect(r.counts.secrets).toBe(6);
    expect(scanSecrets(r.text, 'shell')).toEqual([]);
  });

  it('replaces personal values but never identifiers, column names or keywords', () => {
    const r = S(
      `SELECT EMPLID, NAME, OPRID FROM PS_PERSONAL_DATA
 WHERE EMPLID = '104522' AND NAME LIKE 'Smith,John%' AND NATIONAL_ID = '521-44-9031'
   AND BIRTHDATE = TO_DATE('1984-07-23','YYYY-MM-DD') AND OPRID IN ('JSMITH','MJONES');
ALTER USER BATCH1 IDENTIFIED BY Tiger99x;
`,
      'sql',
    );
    expect(r.text).toContain('SELECT EMPLID, NAME, OPRID FROM PS_PERSONAL_DATA');
    expect(r.text).toContain("EMPLID = 'EMPLID_1'");
    expect(r.text).toContain("NAME LIKE 'dev1%'");
    expect(r.text).toContain("TO_DATE('1900-01-01','YYYY-MM-DD')");
    expect(r.text).toContain("OPRID IN ('OPRID_1','OPRID_2')");
    expect(r.text).toContain('IDENTIFIED BY "&&db_password"');
    expect(r.text).not.toMatch(/104522|Smith|521-44|1984|JSMITH|MJONES|Tiger99x/);
  });

  it('does not treat Oracle home versions, dotted identifiers or placeholders as hosts', () => {
    const text = `export ORACLE_HOME=/u01/app/oracle/product/19.3.0.0/dbhome_1
sqlplus -s / as sysdba <<SQL
SELECT a.net, b.org, c.info FROM PS_LEDGER a, PS_DEPT_TBL b, PS_X c WHERE a.deptid = b.deptid;
SQL
scp x target_user@target_server:/in/
`;
    const r = S(text);
    expect(r.text).toBe(text);
    expect(countSummary(r.counts)).toBe('Nothing needed replacing');
  });

  it('is idempotent: scanning sanitized text finds nothing', () => {
    for (const fx of loadFixtures().filter((f) => !f.expectReject)) {
      const t = classify(fx.source).type;
      const lang = t === 'shell' || t === 'mixed' ? 'shell' : 'sql';
      const r = sanitize(fx.source, lang, []);
      expect(scanSanitized(r.text, lang, []), fx.id).toEqual([]);
      expect(scanSecrets(r.text, lang), fx.id).toEqual([]);
      for (const seed of SEEDS) expect(r.text.includes(seed), `${fx.id}: ${seed}`).toBe(false);
    }
  });

  it('honours the organisation deny-list', () => {
    const r = sanitize('echo "ask Zebulon about the Bluebird project"\n', 'shell', ['Zebulon', 'Bluebird']);
    expect(r.text).toBe('echo "ask dev1 about the dev2 project"\n');
  });

  it('reports counts only', () => {
    const r = S('#!/bin/sh\n# Author: Jane Roe\nscp a.dat xfer@10.1.2.3:/in/\nmailx -s done jane.roe@corp.example.com < /dev/null\nPASSWORD=abc12345\n');
    expect(countSummary(r.counts)).toBe('1 email, 1 name, 1 host, 1 user, 1 password replaced');
    expect(JSON.stringify(r)).not.toMatch(/Jane|10\.1\.2\.3|xfer@|abc12345/);
  });
});
