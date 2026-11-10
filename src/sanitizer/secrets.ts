import { Ctx, isReference, type Lang } from './context';

const SECRET_NAME = String.raw`\w*(?:PASSWORD|PASSWD|PASSPHRASE|PASSWRD|SECRET|TOKEN|APIKEY|CREDENTIALS?)\w*|\w*_(?:PWD|PASS|PW)|PASS|PW|PWD_\w+|\w*(?:API|SSH|PRIVATE|ACCESS|AUTH|ENCRYPTION|SIGNING)_?KEY\w*`;
const NOT_A_SECRET_NAME = /(_FILE|_PATH|_DIR|_LEN|_LENGTH|_EXPIR\w*|_PROMPT|_POLICY|_URL|_NAME|_ENV|_VAR|_COUNT|_SIZE|_TTL|_TIMEOUT)$/i;

/** Known token shapes that are secrets wherever they appear. */
const TOKEN_SHAPES =
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g;

function envRef(name: string): string {
  const n = name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return `"\${${n}:?set ${n} in the environment}"`;
}

/**
 * Removes passwords, tokens, keys and passphrases, replacing each with a config
 * or environment reference. Deterministic and idempotent.
 */
export function secretPass(text: string, ctx: Ctx, lang: Lang): string {
  const hit = () => {
    ctx.counts.secrets++;
  };
  let out = text;

  // Private key blocks.
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => {
    hit();
    return '${SSH_PRIVATE_KEY:?load the private key from a secrets manager}';
  });

  // URL credentials: scheme://user:password@host
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@"']+):([^\s@/"']+)@/gi, (m, scheme: string, user: string, pw: string) => {
    if (isReference(pw)) return m;
    hit();
    return `${scheme}${user}:\${TARGET_PASSWORD}@`;
  });

  // Oracle connect strings: user/password@db, and user/password after a client program.
  const sqlRef = (line: string) => (/^\s*(conn(ect)?)\b/i.test(line) || lang === 'sql' ? '&&db_password' : '${DB_PASSWORD}');
  out = out
    .split('\n')
    .map((line) => {
      let l = line.replace(/(^|[\s"'=(])([A-Za-z][\w$#]*)\/([^\s@/"'$&{}()]+)@(?=[\w(/"$&{])/g, (m, pre: string, user: string, pw: string) => {
        if (isReference(pw)) return m;
        hit();
        return `${pre}${user}/${sqlRef(line)}@`;
      });
      l = l.replace(
        /(\b(?:sqlplus|sqlldr|expdp|impdp|exp|imp|tkprof|rman\s+target|conn(?:ect)?)\b(?:\s+-\w+)*\s+["']?|\buserid\s*=\s*["']?)([A-Za-z][\w$#]*)\/([^\s@/"'$&{}()]+)(?=["'\s]|$)/gi,
        (m, pre: string, user: string, pw: string) => {
          if (isReference(pw) || /^nolog$/i.test(pw) || /^nolog$/i.test(user)) return m;
          hit();
          return `${pre}${user}/${sqlRef(line)}`;
        },
      );
      return l;
    })
    .join('\n');

  // SQL: IDENTIFIED BY <password>
  out = out.replace(/\b(IDENTIFIED\s+BY\s+(?:VALUES\s+)?)("[^"\n]*"|'[^'\n]*'|[^\s;,]+)/gi, (m, pre: string, pw: string) => {
    if (isReference(pw) || /^"?&/.test(pw)) return m;
    hit();
    return `${pre}"&&db_password"`;
  });

  // PL/SQL: l_password [type] := 'literal'
  out = out.replace(/\b(\w*(?:password|passwd|pwd|passphrase|secret|token)\w*)(\s+[\w()%. ]+?)?(\s*:=\s*)'((?:[^'\n]|'')+)'/gi, (m, name: string, type: string | undefined, op: string, pw: string) => {
    if (isReference(pw)) return m;
    hit();
    return `${name}${type ?? ''}${op}'&&${name.toLowerCase().replace(/^[lvpg]_/, '')}'`;
  });

  // PeopleSoft and other command-line password flags.
  out = out.replace(/(\s-C([PW])\s+)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g, (m, pre: string, which: string, pw: string) => {
    if (isReference(pw)) return m;
    hit();
    return `${pre}"\${${which === 'P' ? 'PS_OPR_PASSWORD' : 'PS_CONNECT_PASSWORD'}}"`;
  });
  out = out.replace(/(\bsshpass\s+-p\s*)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g, (m, pre: string, pw: string) => {
    if (isReference(pw)) return m;
    hit();
    return `${pre}"\${TARGET_PASSWORD}"`;
  });
  out = out.replace(/(--(?:password|passwd|token|secret|api-key|passphrase)[= ])("[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi, (m, pre: string, pw: string) => {
    if (isReference(pw)) return m;
    hit();
    return `${pre}"\${TARGET_PASSWORD}"`;
  });
  out = out.replace(/(\bcurl\b[^\n]*?\s(?:-u|--user)\s+["']?)([^\s:"']+):([^\s"']+)/g, (m, pre: string, user: string, pw: string) => {
    if (isReference(pw)) return m;
    hit();
    return `${pre}${user}:\${API_PASSWORD}`;
  });
  out = out.replace(/(\bAuthorization:\s*(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{8,})/gi, (m, pre: string) => {
    hit();
    return `${pre}\${API_TOKEN}`;
  });

  // .netrc style: password <value>
  out = out.replace(/(\bmachine\s+\S+\s+login\s+\S+\s+password\s+)(\S+)/gi, (m, pre: string, pw: string) => {
    if (isReference(pw)) return m;
    hit();
    return `${pre}\${TARGET_PASSWORD}`;
  });
  // ftp: quote PASS <value>
  out = out.replace(/^(\s*quote\s+PASS\s+)(\S+)/gim, (m, pre: string, pw: string) => {
    if (isReference(pw)) return m;
    hit();
    return `${pre}\${TARGET_PASSWORD}`;
  });

  if (lang === 'shell' || lang === 'text') {
    // Shell assignments, including passwords read from files.
    const assign = new RegExp(String.raw`^(\s*(?:export\s+|typeset\s+(?:-\w+\s+)*|local\s+|readonly\s+|declare\s+(?:-\w+\s+)*)?)(${SECRET_NAME})=("[^"\n]*"|'[^'\n]*'|\$\([^)\n]*\)|` + '`[^`\\n]*`' + String.raw`|[^\s;#]+)`, 'gim');
    out = out.replace(assign, (m, pre: string, name: string, value: string) => {
      if (NOT_A_SECRET_NAME.test(name)) return m;
      const readsFile = /^(\$\(|`)\s*(cat|head|tail|sed|awk|grep|openssl|base64|<)/.test(value);
      if (!readsFile && (isReference(value) || /^["']?(0|1|true|false|yes|no|y|n)["']?$/i.test(value))) return m;
      hit();
      return `${pre}${name}=${envRef(name)}`;
    });
    // echo <password> | sqlplus ... style pipes are covered by connect strings above.
  }

  if (lang === 'python' || lang === 'ini' || lang === 'text') {
    // key = "literal" / key: "literal" / key = literal (ini)
    out = out.replace(
      /^(\s*["']?(?:\w*(?:password|passwd|passphrase|secret|token|api_?key)\w*)["']?\s*[:=]\s*)(?:(["'])((?:(?!\2).)+)\2|([^\s"'#;,(){}[\]]+))\s*(,?)\s*$/gim,
      (m, pre: string, _q: string | undefined, quoted: string | undefined, bare: string | undefined, comma: string) => {
        const v = quoted ?? bare ?? '';
        if (isReference(v)) return m;
        if (lang === 'python' && quoted === undefined) return m; // unquoted in Python is an expression, not a literal
        if (lang === 'python' && /^(password|passwd|database|smtp|source|target|logging|secret|token)$/i.test(v)) return m; // config key names
        hit();
        return `${pre}CHANGE_ME${comma}`;
      },
    );
  }

  out = out.replace(TOKEN_SHAPES, () => {
    hit();
    return '${API_TOKEN}';
  });

  return out;
}
