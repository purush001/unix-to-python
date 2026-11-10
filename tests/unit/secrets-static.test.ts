import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkSecrets } from '../../scripts/check-secrets';

describe('static secret-handling check', () => {
  it('passes on this repository', () => {
    expect(checkSecrets()).toEqual([]);
  });

  it('fails when a file other than the accessor reads a secret variable, or keeps a client or secret at module scope', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'secrets-check-'));
    mkdirSync(path.join(root, 'src', 'config'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'config', 'env.ts'), 'export const getSecret = (n: string) => process.env[n];\n');
    writeFileSync(path.join(root, 'src', 'lib', 'a.ts'), "export function f() {\n  return process.env.ANTHROPIC_API_KEY;\n}\n");
    writeFileSync(path.join(root, 'src', 'lib', 'b.ts'), "import { getSecret } from '../config/env';\nconst KEY = getSecret('GITHUB_TOKEN');\nexport const use = () => KEY;\n");
    writeFileSync(path.join(root, 'src', 'lib', 'c.ts'), "import Anthropic from '@anthropic-ai/sdk';\nexport const client = new Anthropic({ apiKey: 'x' });\n");
    writeFileSync(path.join(root, 'src', 'lib', 'ok.ts'), "import { getSecret } from '../config/env';\n// process.env in a comment is fine\nexport const lazy = () => getSecret('GITHUB_TOKEN');\nexport function g() {\n  const k = getSecret('X');\n  return k;\n}\n");
    const problems = checkSecrets(root);
    rmSync(root, { recursive: true, force: true });
    expect(problems).toHaveLength(3);
    expect(problems.find((p) => p.startsWith(path.join('src', 'lib', 'a.ts')))).toMatch(/reads process\.env/);
    expect(problems.find((p) => p.startsWith(path.join('src', 'lib', 'b.ts')))).toMatch(/module scope/);
    expect(problems.find((p) => p.startsWith(path.join('src', 'lib', 'c.ts')))).toMatch(/module scope/);
  });
});
