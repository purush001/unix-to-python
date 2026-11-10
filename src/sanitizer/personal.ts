import { Ctx, isReference, type Lang } from './context';

const COLS: Record<string, string> = {
  EMPLID: 'EMPLID', EMPL_ID: 'EMPLID', EMPLOYEE_ID: 'EMPLID', SUPERVISOR_ID: 'EMPLID', MANAGER_ID: 'EMPLID', REPORTS_TO_EMPLID: 'EMPLID', EMPLID_INT: 'EMPLID',
  OPRID: 'OPRID', OPRDEFNDESC: 'OPRID', USERID: 'OPRID', RUNCNTLID: '', ROWSECCLASS: '',
  NATIONAL_ID: 'NATIONAL_ID', SSN: 'NATIONAL_ID', SIN: 'NATIONAL_ID', NID: 'NATIONAL_ID',
  NAME: 'NAME', FIRST_NAME: 'NAME', LAST_NAME: 'NAME', MIDDLE_NAME: 'NAME', NAME_DISPLAY: 'NAME', NAME_FORMAL: 'NAME', FULL_NAME: 'NAME',
  ADDRESS1: 'ADDRESS', ADDRESS2: 'ADDRESS', ADDRESS3: 'ADDRESS', ADDRESS4: 'ADDRESS', STREET: 'ADDRESS',
  PHONE: 'PHONE', PHONE_NBR: 'PHONE', MOBILE: 'PHONE',
  BIRTHDATE: 'DATE', DOB: 'DATE', DATE_OF_BIRTH: 'DATE', BIRTH_DT: 'DATE',
  EMAIL_ADDR: '', EMAILID: '',
};
const COL_RE = new RegExp(String.raw`\b((?:\w+\.)?(${Object.keys(COLS).filter((k) => COLS[k]).join('|')}))(\s*(?:=|<>|!=|<=|>=|<|>|\bNOT\s+LIKE\b|\bLIKE\b|\bNOT\s+IN\b|\bIN\b|\bBETWEEN\b)\s*)`, 'gi');

function syntheticDate(lit: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(lit)) return '1900-01-01' + lit.slice(10).replace(/\d/g, '0');
  if (/^\d{4}\/\d{2}\/\d{2}/.test(lit)) return '1900/01/01';
  if (/^\d{2}-[A-Za-z]{3}-\d{4}$/.test(lit)) return '01-JAN-1900';
  if (/^\d{2}-[A-Za-z]{3}-\d{2}$/.test(lit)) return '01-JAN-00';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(lit)) return '01/01/1900';
  if (/^\d{8}$/.test(lit)) return '19000101';
  return '1900-01-01';
}

function synth(kind: string, original: string, ctx: Ctx): string {
  if (kind === 'NAME') return ctx.name([original]);
  if (kind === 'PHONE') {
    ctx.personal('PHONE', original);
    return '555-555-0100';
  }
  if (kind === 'DATE') {
    const s = syntheticDate(original);
    if (s !== original) ctx.personal('DATE', original);
    return s;
  }
  return ctx.personal(kind, original);
}
const isSynthetic = (v: string) => /^(EMPLID|OPRID|NATIONAL_ID|ADDRESS)_\d+$/.test(v) || /^dev\d+$/.test(v) || v === '555-555-0100' || /^(1900[-/]01[-/]01|01-JAN-1900|01-JAN-00|01\/01\/1900|19000101)/.test(v) || v === '000-00-0000';

/** Personal data in literal values. Identifiers, column names and keywords are never changed. */
export function personalPass(text: string, ctx: Ctx, lang: Lang): string {
  let out = text;

  // Literals compared with a personal-data column: EMPLID = '12345', NAME LIKE 'Smith%', EMPLID IN ('1','2')
  const ITEM = String.raw`(?:TO_DATE\s*\(\s*'[^'\n]*'\s*(?:,\s*'[^'\n]*'\s*)?\)|(?:DATE\s+)?'(?:[^'\n]|'')*')`;
  out = out.replace(new RegExp(COL_RE.source + String.raw`((?:\(\s*)?${ITEM}(?:\s*(?:,|\bAND\b)\s*${ITEM})*)`, 'gi'), (m, colFull: string, col: string, op: string, lits: string) => {
    const kind = COLS[col.toUpperCase()];
    if (!kind) return m;
    const replaced = lits.replace(/(TO_DATE\s*\(\s*|DATE\s+)?'((?:[^'\n]|'')*)'(\s*,\s*'[^'\n]*'\s*\))?/gi, (lm: string, pre: string | undefined, v: string, fmt: string | undefined) => {
      if (fmt && !/^TO_DATE/i.test(pre ?? '')) {
        // two plain literals in a list, not a TO_DATE format: handle the first, leave the rest to the next match
        return lm.replace(/'((?:[^'\n]|'')*)'/g, (_x, one: string) => `'${fix(one)}'`);
      }
      return `${pre ?? ''}'${fix(v)}'${fmt ?? ''}`;
    });
    return `${colFull}${op}${replaced}`;

    function fix(v: string): string {
      const core = v.replace(/[%_]+$/, '').replace(/^[%]+/, '');
      // concatenated dynamic SQL ('''' || p_emplid || '''') is code, not a literal value
      if (core.trim() === '' || isReference(core) || isSynthetic(core) || /\|\||''/.test(v)) return v;
      return v.replace(core, synth(kind, core, ctx));
    }
  });

  if (lang === 'shell' || lang === 'text') {
    // Shell variables holding an employee or operator id
    out = out.replace(/^(\s*(?:export\s+)?(EMPLID|EMPL_ID|OPRID|PS_OPRID|OPERATOR(?:_ID)?)=)(["']?)([^\s"';$`]+)\3/gim, (m, pre: string, name: string, q: string, v: string) => {
      if (isReference(v) || isSynthetic(v)) return m;
      return `${pre}${q}${ctx.personal(/EMPL/i.test(name) ? 'EMPLID' : 'OPRID', v)}${q}`;
    });
    // PeopleSoft operator on the command line: -CO VP1
    out = out.replace(/(\s-CO\s+)(["']?)([^\s"'$`]+)\2/g, (m, pre: string, q: string, v: string) => {
      if (isReference(v) || isSynthetic(v)) return m;
      return `${pre}${q}${ctx.personal('OPRID', v)}${q}`;
    });
  }

  // National ID and phone number shapes anywhere in literals or comments
  out = out.replace(/(?<![\w-])\d{3}-\d{2}-\d{4}(?![\w-])/g, (m) => {
    if (m === '000-00-0000') return m;
    ctx.personal('NATIONAL_ID_VALUE', m);
    return '000-00-0000';
  });
  out = out.replace(/(?<![\w.-])(?:\+?1[ .-])?(?:\(\d{3}\)\s?|\d{3}[ .-])\d{3}[ .-]\d{4}(?![\w-]|\.\d)/g, (m) => {
    if (m === '555-555-0100') return m;
    ctx.personal('PHONE', m);
    return '555-555-0100';
  });
  return out;
}
