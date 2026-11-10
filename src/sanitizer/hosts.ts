import { Ctx, escapeRe, HOST_PH, isReference, type Lang, type Role } from './context';

const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const TLD = String.raw`(?:com|net|org|edu|gov|mil|int|local|lan|corp|internal|intranet|priv|cloud|io|biz|info|co|ac)(?:\.[a-z]{2})?`;
const FQDN_RE = new RegExp(String.raw`(?<![\w.@/-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+${TLD})(?![\w-]|\.[a-z])`, 'gi');
const IPV4_RE = /(?<![\w.])((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?![\w]|\.\d)/g;
// github.com is where approved conversions are committed; commit links are application metadata, not script content
const SAFE_HOSTS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.\d+|script\.com|github\.com)$/i;

const OPTS_WITH_ARG: Record<string, RegExp> = {
  ssh: /^-[iopFJbcemSWwLRDlE]$/,
  scp: /^-[iPoFclSJ]$/,
  sftp: /^-[oPiBbcFlRSs]$/,
  rsync: /^(-e|--rsh|--exclude|--include|--files-from|--password-file|--port|--bwlimit|--log-file|--timeout)$/,
  ftp: /^-[Pw]$/,
};

function validHost(v: string): boolean {
  if (isReference(v) || SAFE_HOSTS.test(v)) return false;
  if (/^\d+(\.\d+){3}$/.test(v)) return true;
  return HOSTNAME.test(v) && /[A-Za-z]/.test(v) && !/^\d/.test(v.split('.').pop() ?? '');
}

/** Decides the role of an ftp/sftp session from the commands in its heredoc. */
function sessionRole(body: string[]): Role | 'ambiguous' {
  const text = body.join('\n');
  if (/^\s*(m?put|send|append)\b/im.test(text)) return 'target';
  if (/^\s*(m?get|recv|reget)\b/im.test(text)) return 'source';
  return 'ambiguous';
}

function splitArgs(s: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  const re = /"[^"]*"|'[^']*'|[^\s]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push({ text: m[0], start: m.index });
  return out;
}

/** Hosts and remote users in ssh, scp, sftp, ftp and rsync command lines and their heredocs. */
function commandPass(text: string, ctx: Ctx): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(#|--|rem\b)/i.test(line)) continue;
    const cm = /(^\s*|[;|&(`]\s*|\b(?:then|do|else|exec|time|nohup|sudo)\s+)(ssh|scp|sftp|rsync|ftp|lftp)(\s+)(?=\S)/.exec(line);
    if (!cm) continue;
    const cmd = cm[2] === 'lftp' ? 'ftp' : cm[2];
    const argStart = cm.index + cm[0].length;
    const tailEnd = (() => {
      const m = /(\s<<|\s*[|;]|\s&&|\s\|\|)/.exec(line.slice(argStart));
      return m ? argStart + m.index : line.length;
    })();
    const argText = line.slice(argStart, tailEnd);
    const args = splitArgs(argText);

    // heredoc body, if any
    let body: string[] = [];
    let bodyStart = -1;
    let bodyEnd = -1;
    const hd = /<<-?\s*["']?(\w+)["']?/.exec(line.slice(argStart));
    if (hd) {
      bodyStart = i + 1;
      bodyEnd = lines.findIndex((l, k) => k > i && l.trim() === hd[1]);
      if (bodyEnd === -1) bodyEnd = lines.length;
      body = lines.slice(bodyStart, bodyEnd);
    }

    // positional arguments (options with a value are skipped)
    const pos: { text: string; start: number }[] = [];
    let loginIdx = -1;
    for (let a = 0; a < args.length; a++) {
      const t = args[a].text;
      if (t.startsWith('-')) {
        if (cmd === 'ssh' && t === '-l') loginIdx = a + 1;
        if (OPTS_WITH_ARG[cmd]?.test(t)) a++;
        continue;
      }
      pos.push(args[a]);
    }

    let role: Role | 'ambiguous';
    if (cmd === 'ssh') role = 'target';
    else if (cmd === 'scp' || cmd === 'rsync') {
      const last = pos[pos.length - 1]?.text ?? '';
      role = /^[^/\s:]+:/.test(last.replace(/^["']/, '')) ? 'target' : 'source';
    } else role = hd ? sessionRole(body) : 'ambiguous';
    const userRole: Role = role === 'source' ? 'source' : 'target';

    const edits: { start: number; end: number; text: string }[] = [];
    const mapSpec = (arg: { text: string; start: number }, specRole: Role | 'ambiguous', requireColon: boolean) => {
      const m = /^(["']?)(?:([^@\s:"']+)@)?([^@\s:"'/]+)(:.*)?$/.exec(arg.text);
      if (!m) return;
      const [, q, user, host, rest] = m;
      if (requireColon && !rest) return;
      const uRole: Role = specRole === 'source' ? 'source' : 'target';
      const newUser = user && !isReference(user) ? ctx.user(user, uRole) : user;
      const newHost = validHost(host) ? ctx.host(host, specRole) : host;
      if (newUser === user && newHost === host) return;
      edits.push({ start: argStart + arg.start, end: argStart + arg.start + arg.text.length, text: `${q}${newUser ? newUser + '@' : ''}${newHost}${rest ?? ''}` });
    };

    if (cmd === 'scp' || cmd === 'rsync') {
      pos.forEach((p, k) => mapSpec(p, k === pos.length - 1 ? 'target' : 'source', true));
    } else if (pos[0]) {
      mapSpec(pos[0], role, false);
    }
    if (loginIdx > 0 && args[loginIdx] && !isReference(args[loginIdx].text)) {
      const a = args[loginIdx];
      edits.push({ start: argStart + a.start, end: argStart + a.start + a.text.length, text: ctx.user(a.text, userRole) });
    }
    if (edits.length) {
      let l = line;
      for (const e of edits.sort((x, y) => y.start - x.start)) l = l.slice(0, e.start) + e.text + l.slice(e.end);
      lines[i] = l;
    }

    // ftp / sftp session commands
    if (hd && (cmd === 'ftp' || cmd === 'sftp')) {
      const pwName = userRole === 'source' ? 'SOURCE_PASSWORD' : 'TARGET_PASSWORD';
      for (let k = bodyStart; k < bodyEnd; k++) {
        lines[k] = lines[k]
          .replace(/^(\s*open\s+)(\S+)/i, (m, pre: string, host: string) => (validHost(host) ? pre + ctx.host(host, role) : m))
          .replace(/^(\s*(?:quote\s+USER|user)\s+)(\S+)(\s+)?(\S+)?/i, (m, pre: string, user: string, sp: string | undefined, pw: string | undefined) => {
            const u = isReference(user) ? user : ctx.user(user, userRole);
            let p = pw ?? '';
            if (pw && !isReference(pw)) {
              ctx.counts.secrets++;
              p = `\${${pwName}}`;
            }
            return `${pre}${u}${sp ?? ''}${p}`;
          });
      }
    }
  }
  return lines.join('\n');
}

const TARGET_HINT = /(REMOTE|TARGET|TGT|DEST|DST|FTP|SFTP|SCP|SSH|VENDOR|BANK|PARTNER|PUSH|OUTBOUND|UPLOAD|DR_|STANDBY)/i;
const SOURCE_HINT = /(SOURCE|SRC|DB_|ORACLE|ORA_|LOCAL|PRIMARY|INBOUND|DOWNLOAD|THIS_)/i;

/** Variable assignments such as FTP_HOST=..., REMOTE_USER=... */
function assignmentPass(text: string, ctx: Ctx): string {
  return text.replace(
    /^(\s*(?:export\s+|typeset\s+|local\s+|readonly\s+)?)([A-Za-z_]\w*)=(["']?)([^\s"';#]+)\3/gm,
    (m, pre: string, name: string, q: string, value: string) => {
      if (isReference(value)) return m;
      const role: Role | 'ambiguous' = TARGET_HINT.test(name) ? 'target' : SOURCE_HINT.test(name) ? 'source' : 'ambiguous';
      if (/(HOST|HOSTNAME|SERVER|NODE|MACHINE|_IP|IPADDR\w*)$/i.test(name) && validHost(value)) {
        return `${pre}${name}=${q}${ctx.host(value, role)}${q}`;
      }
      if (/(USER|USERNAME|USERID|LOGIN|ACCOUNT|ACCT)$/i.test(name) && /(REMOTE|TARGET|TGT|DEST|DST|FTP|SFTP|SCP|SSH|RSYNC|VENDOR|BANK|PARTNER|SOURCE|SRC)/i.test(name)) {
        return `${pre}${name}=${q}${ctx.user(value, role === 'source' ? 'source' : 'target')}${q}`;
      }
      return m;
    },
  );
}

/** Connect strings, URLs, mounts, then any remaining IP address or FQDN. */
function structuredPass(text: string, ctx: Ctx, lang: Lang): string {
  let out = text;
  // TNS descriptor
  out = out.replace(/(\(\s*HOST\s*=\s*)([^)\s]+)(\s*\))/gi, (m, a: string, host: string, b: string) => (validHost(host) ? a + ctx.host(host, 'source') + b : m));
  // JDBC thin and EZConnect: @host:port/service, @//host:port/service, @host:port:sid
  out = out.replace(/(@(?:\/\/)?)([A-Za-z0-9][\w.-]*)(:\d{2,5}[:/])/g, (m, a: string, host: string, b: string) => (validHost(host) ? a + ctx.host(host, 'source') + b : m));
  out = out.replace(/(@\/\/)([A-Za-z0-9][\w.-]*)(\/[\w.$#-]+)/g, (m, a: string, host: string, b: string) => (validHost(host) ? a + ctx.host(host, 'source') + b : m));
  // hostname comparisons: the host the script runs on
  out = out.replace(/((?:hostname|uname\s+-n)[^\n]*?(?:==?|!=)\s*["']?)([A-Za-z0-9][\w.-]*)/g, (m, a: string, host: string) => (validHost(host) ? a + ctx.host(host, 'source') : m));
  // URLs
  out = out.replace(/\b((?:https?|s?ftp|ftps|ldaps?|smtps?|ssh|nfs|smb|cifs):\/\/(?:[^\s/@"']+@)?)([A-Za-z0-9][\w.-]*)/gi, (m, a: string, host: string) => {
    if (!validHost(host)) return m;
    const scheme = a.toLowerCase();
    return a + ctx.host(host, /^(s?ftp|ftps|ssh)/.test(scheme) ? 'target' : 'ambiguous');
  });
  // CIFS / NFS mounts
  out = out.replace(/(^|[\s"'=])(\/\/)([A-Za-z0-9][\w.-]*)(\/[\w$.-]+)/g, (m, pre: string, a: string, host: string, b: string) => (validHost(host) ? pre + a + ctx.host(host, 'ambiguous') + b : m));
  if (lang === 'shell' || lang === 'text') {
    out = out.replace(/^([^\n#]*\bmount\b[^\n]*?\s)([A-Za-z0-9][\w.-]*)(:\/[^\s]*)/gm, (m, a: string, host: string, b: string) => (validHost(host) ? a + ctx.host(host, 'ambiguous') + b : m));
  }
  // any remaining IP address (Oracle home version paths such as product/19.3.0.0 are not addresses)
  out = out.replace(IPV4_RE, (m, ip: string, offset: number) => {
    if (SAFE_HOSTS.test(ip)) return m;
    const before = out.slice(Math.max(0, offset - 24), offset);
    if (/(product\/|version\s*[:=]?\s*|release\s*[:=]?\s*|\bv|\/)$/i.test(before) && !/:\/\/$/.test(before)) return m;
    return ctx.host(ip, 'ambiguous');
  });
  // any remaining fully qualified name. Dotted identifiers in code look like host names, so a
  // two-label name must use a classic TLD and, in SQL, sit inside a string literal.
  out = out.replace(FQDN_RE, (m, host: string, offset: number) => {
    if (SAFE_HOSTS.test(host) || HOST_PH.test(host)) return m;
    const labels = host.split('.');
    const tld = labels[labels.length - 1].toLowerCase();
    const twoPartTld = labels.length >= 3 && /^(co|com|ac|org|net|gov)$/i.test(labels[labels.length - 2]) && tld.length === 2;
    const names = labels.length - (twoPartTld ? 2 : 1);
    if (names < 2) {
      if (!twoPartTld && !/^(com|net|org|edu|gov|mil)$/.test(tld)) return m;
      if (host !== host.toLowerCase()) return m;
      if (labels[0].length < 4 && !/[\d-]/.test(labels[0])) return m; // a.net, jrn.org: table alias and column
      if (lang === 'sql') {
        const lineStart = out.lastIndexOf('\n', offset) + 1;
        if ((out.slice(lineStart, offset).match(/'/g) ?? []).length % 2 === 0) return m;
      }
    } else if (tld.length === 2 && !twoPartTld) return m;
    return ctx.host(host, 'ambiguous');
  });
  return out;
}

/** Makes every other mention of an already-mapped host consistent. */
function consistencyPass(text: string, ctx: Ctx): string {
  let out = text;
  for (const [orig, ph] of ctx.knownHosts().sort((a, b) => b[0].length - a[0].length)) {
    const forms = [orig];
    const short = orig.split('.')[0];
    if (orig.includes('.') && !/^\d+$/.test(short) && short.length >= 5 && /\d/.test(short)) forms.push(short);
    for (const f of forms) {
      if (f.length < 4 && !/\d/.test(f)) continue;
      out = out.replace(new RegExp(String.raw`(?<![\w.-])${escapeRe(f)}(?![\w-]|\.\w)`, 'gi'), ph);
    }
  }
  return out;
}

export function hostPass(text: string, ctx: Ctx, lang: Lang): string {
  let out = text;
  if (lang === 'shell' || lang === 'text') {
    out = commandPass(out, ctx);
    out = assignmentPass(out, ctx);
  }
  out = structuredPass(out, ctx, lang);
  return consistencyPass(out, ctx);
}
