/**
 * Static secret-handling check (fails `npm test` and `npm run build`):
 *  1. Only src/config/env.ts may read process.env.
 *  2. No secret, and no provider client, may be assigned at module scope.
 * Run: npm run check-secrets
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOTS = ['src', 'evals', 'skills', 'scripts'];
const ENV_MODULE = path.join('src', 'config', 'env.ts');
const SELF = path.join('scripts', 'check-secrets.ts');
const CLIENT_FACTORIES = /\b(new\s+(Anthropic|CloudClient|ChromaClient|Pool)\b|postgres\s*\(|nodemailer\.createTransport\s*\(|create(Providers|AnthropicLlm|RealGitHub|RealSmtp|SupabaseStorage|ChromaMemory|VoyageEmbeddings)\s*\(|(get|require)Secret\s*\(|currentSecretValues\s*\()/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' || name === 'fixtures' ? [] : files(p);
    return /\.(ts|tsx|mts|js|mjs)$/.test(name) ? [p] : [];
  });
}

/** Blanks out strings and comments so braces inside them are not counted. */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, (m) => m.replace(/[^\n]/g, ' '));
}

export function checkSecrets(root = process.cwd()): string[] {
  const problems: string[] = [];
  for (const r of ROOTS) {
    let list: string[] = [];
    try {
      list = files(path.join(root, r));
    } catch {
      continue;
    }
    for (const abs of list) {
      const rel = path.relative(root, abs);
      if (rel === SELF) continue;
      const raw = readFileSync(abs, 'utf8');
      const code = strip(raw);
      if (rel !== ENV_MODULE && /\bprocess\s*\.\s*env\b/.test(code)) {
        const line = code.split('\n').findIndex((l) => /\bprocess\s*\.\s*env\b/.test(l)) + 1;
        problems.push(`${rel}:${line} reads process.env; only ${ENV_MODULE} may (use getSecret/getConfig)`);
      }
      // walk top-level statements: depth 0 outside any braces/parens
      let depth = 0;
      let stmtStart = 0;
      for (let i = 0; i < code.length; i++) {
        const c = code[i];
        if (c === '{' || c === '(' || c === '[') depth++;
        else if (c === '}' || c === ')' || c === ']') depth--;
        if ((c === ';' || c === '\n') && depth === 0) {
          const stmt = code.slice(stmtStart, i);
          const m = /^\s*(?:export\s+)?(?:const|let|var)\s+[\w${}\s,:[\]]+?=\s*([\s\S]*)$/.exec(stmt);
          if (m) {
            // only the part evaluated at import time counts: stop at a function body
            const eager = m[1].split(/=>|\bfunction\b/)[0];
            if (CLIENT_FACTORIES.test(eager)) problems.push(`${rel}:${raw.slice(0, stmtStart).split('\n').length + (stmt.match(/^\s*\n/) ? 1 : 0)} assigns a secret or provider client at module scope`);
          }
          stmtStart = i + 1;
        }
      }
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SELF)) {
  const problems = checkSecrets();
  if (problems.length) {
    console.error('Secret-handling check FAILED:\n' + problems.map((p) => '  ' + p).join('\n'));
    process.exit(1);
  }
  console.log('Secret-handling check passed.');
}
