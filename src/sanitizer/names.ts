import { Ctx, escapeRe, isReference, NAME_PH, OPS_EMAIL, type Lang } from './context';

const HEADER_KEYS = String.raw`(?:Author|Authors|Created\s+by|Written\s+by|Modified\s+by|Updated\s+by|Changed\s+by|Last\s+modified\s+by|Owner|Contact|Reviewed\s+by|Reviewer|Approved\s+by|Maintainer|Maintained\s+by|Developer|Programmer|Analyst|Requested\s+by|Support)`;
const HEADER_RE = new RegExp(String.raw`^(\s*(?:#+|--+|rem\b|\*+|\/\*+|"""|'''|@\w+)?\s*@?${HEADER_KEYS}\s*[:=-]\s*)(.+)$`, 'gim');
const SERVICE_ACCOUNTS = /^(oracle|grid|root|psoft|psadm\d*|applmgr|appl\w*|batch|ftp|sftp|tomcat|weblogic|wls|nobody|admin|dba|ops|user|users|shared|common|app|apps|peoplesoft|sysadm)$/i;
const NOT_NAMES = /^(unknown|n\/?a|tbd|none|team|dba|dbas?\s+team|oracle|peoplesoft|it|support|operations|ops|the|and|date|name|description|change|changes|version|initial|created|modified)$/i;

const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*`;
const DATE = String.raw`(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}[-\s]${MONTH}[-\s,]+\d{2,4}|${MONTH}\s+\d{1,2},?\s+\d{4})`;
const PERSON = String.raw`(?:[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][A-Za-z'-]+|[A-Z]\.\s?[A-Z][A-Za-z'-]+|[A-Z][a-z]+,\s?[A-Z][a-z]+|[a-z]{2,}[a-z0-9]{1,}|[A-Z][a-z]{2,})`;
const CHANGELOG_DATE_FIRST = new RegExp(String.raw`^(\s*(?:#+|--+|rem\b|\*+)\s*(?:v?\d+(?:\.\d+)*\s+)?${DATE}\s*[-:|]?\s+)(${PERSON})(?=\s{2,}|\s*[-:|]\s|\t)`, 'gim');
const CHANGELOG_NAME_FIRST = new RegExp(String.raw`^(\s*(?:#+|--+|rem\b|\*+)\s*)(${PERSON})(\s*[-:|]?\s+${DATE})`, 'gm');

/** Every reasonable spelling of a person's name, so all of them map to one placeholder. */
function variants(raw: string): string[] {
  const name = raw.trim().replace(/\s+/g, ' ');
  const out = new Set<string>([name]);
  let first = '';
  let last = '';
  let m: RegExpExecArray | null;
  if ((m = /^([A-Za-z'-]+),\s?([A-Za-z'-]+)/.exec(name))) [last, first] = [m[1], m[2]];
  else if ((m = /^([A-Za-z'-]+)\.?\s+(?:[A-Z]\.?\s+)?([A-Za-z'-]+)$/.exec(name))) [first, last] = [m[1], m[2]];
  else if ((m = /^([A-Za-z]+)[._]([A-Za-z]+)$/.exec(name))) [first, last] = [m[1], m[2]];
  if (first && last && last.length > 1) {
    const f = first[0];
    if (first.length > 1) {
      out.add(`${first} ${last}`).add(`${last}, ${first}`).add(`${last},${first}`).add(`${first}.${last}`).add(`${first}_${last}`);
    }
    out.add(`${f}. ${last}`).add(`${f}.${last}`).add(`${f} ${last}`).add(`${f}${last}`);
    if (first.length > 1) out.add(`${last}${f}`);
  }
  return [...out];
}

function cleanHeaderValue(v: string): string[] {
  return v
    .replace(/<[^>]*>|\([^)]*\)|\S+@\S+/g, ' ')
    .replace(new RegExp(String.raw`\s+(?:on\s+)?${DATE}.*$`, 'i'), '')
    .replace(/\s{2,}.*$/, '')
    .replace(/\*\/|"""|'''/g, '')
    .split(/\s*(?:[;/&|]|\band\b|,(?=\s*[A-Z][a-z]+\s+[A-Z]))\s*/)
    .map((s) => s.trim().replace(/[.,;:]+$/, ''))
    .filter((s) => s.length > 1 && s.length < 50 && !NOT_NAMES.test(s) && !NAME_PH.test(s) && /^[A-Za-z][A-Za-z .,'_-]*\d{0,3}$/.test(s));
}

/** Collects names from the places section 8.1 lists. Nothing is replaced here. */
function harvest(text: string, ctx: Ctx, denyList: string[]): string[] {
  const weak: string[] = [];
  for (const d of denyList) if (d.trim()) ctx.name(variants(d));
  let m: RegExpExecArray | null;
  HEADER_RE.lastIndex = 0;
  while ((m = HEADER_RE.exec(text))) for (const n of cleanHeaderValue(m[2])) ctx.name(variants(n));
  for (const re of [CHANGELOG_DATE_FIRST, CHANGELOG_NAME_FIRST]) {
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      const n = m[2].trim();
      if (!NOT_NAMES.test(n) && !NAME_PH.test(n) && !SERVICE_ACCOUNTS.test(n)) ctx.name(variants(n));
    }
  }
  // mail display names: "John Smith" <john.smith@corp.com>
  const display = /["']?([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][A-Za-z'-]+)["']?\s*<[^<>\s@]+@[^<>\s]+>/g;
  while ((m = display.exec(text))) ctx.name(variants(m[1]));
  // email local parts
  const email = /\b([A-Za-z0-9._%+-]+)@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
  while ((m = email.exec(text))) {
    const local = m[1];
    if (/^[a-z]+[._][a-z]+$/i.test(local)) ctx.name(variants(local));
    else if (/^[a-z]{4,}\d{0,2}$/i.test(local) && !SERVICE_ACCOUNTS.test(local)) weak.push(local);
  }
  // home directories
  const home = /(?:\/(?:export\/)?home\/|\/Users\/|~)([A-Za-z][\w.-]*)/g;
  while ((m = home.exec(text))) if (!SERVICE_ACCOUNTS.test(m[1]) && !NAME_PH.test(m[1]) && !isReference(m[1])) ctx.name(variants(m[1]));
  return weak;
}

export function namePass(text: string, ctx: Ctx, _lang: Lang, denyList: string[]): string {
  const weak = harvest(text, ctx, denyList);
  let out = text;

  // 1. emails (user@host forms in transfer commands were already handled by the host pass)
  out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, (m) => {
    if (m.toLowerCase() === OPS_EMAIL || /_(server|user)(_\d+)?(\.|$)/.test(m) || /@(source|target)_server/.test(m)) return m;
    ctx.counts.emails++;
    return OPS_EMAIL;
  });

  // 2. known names, longest spelling first, as whole words
  for (const [name, ph] of ctx.knownNames()) {
    if (name.length < 3) continue;
    const multi = /[\s.,_]/.test(name);
    const re = new RegExp(String.raw`(?<![\w.@-])${escapeRe(name).replace(/\\?\s+/g, String.raw`\s+`)}(?![\w@]|\.\w|-\w)`, multi ? 'gi' : 'g');
    out = out.replace(re, ph);
    if (!multi) {
      // single tokens also appear capitalised differently in paths and comments
      out = out.replace(new RegExp(String.raw`((?:\/(?:export\/)?home\/|\/Users\/|~))${escapeRe(name)}(?![\w.-])`, 'gi'), `$1${ph}`);
    }
  }

  // 3. weak candidates (bare email local parts): only in comments and home paths
  for (const w of weak) {
    const ph = () => ctx.name([w]);
    const re = new RegExp(String.raw`(?<![\w.@-])${escapeRe(w)}(?![\w@.-])`, 'gi');
    out = out
      .split('\n')
      .map((line) => {
        const c = /(^\s*(?:#|--|rem\b|\*)|\s#\s|\s--\s)/i.exec(line);
        if (!c) return line;
        const head = line.slice(0, c.index);
        const tail = line.slice(c.index);
        return re.test(tail) ? head + tail.replace(re, ph()) : line;
      })
      .join('\n');
  }
  return out;
}
