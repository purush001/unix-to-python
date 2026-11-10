import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { reproducibleCodes } from '@/agents/orchestrator';
import { sha256 } from '@/lib/util';
import type { OutputFile, Witness } from '@/pipeline/types';
import { langOfFile, scanSanitized } from '@/sanitizer';

export interface WitnessCheck {
  ok: boolean;
  problems: string[];
  codes: string[];
}

/**
 * Re-runs the validators on a committed conversion directory and compares the result
 * with witness.json: input hash, output hashes, issue codes and sanitizer hits.
 */
export async function verifyWitnessDir(dir: string): Promise<WitnessCheck> {
  const problems: string[] = [];
  const names = readdirSync(dir);
  const read = (n: string) => readFileSync(path.join(dir, n), 'utf8');
  const witness = JSON.parse(read('witness.json')) as Witness;
  const sourceName = names.find((n) => n.startsWith('source.sanitized.'));
  if (!sourceName) return { ok: false, problems: ['source.sanitized.* is missing'], codes: [] };
  const source = read(sourceName);
  if (sha256(source) !== witness.inputHash) problems.push('input hash differs from the witness');
  const order = ['target.sql', 'target.py', 'config.ini.template', 'requirements.txt'];
  const files: OutputFile[] = order.filter((n) => names.includes(n)).map((n) => ({ name: n, kind: n.endsWith('.sql') ? 'sql' : n.endsWith('.py') ? 'python' : n.startsWith('config') ? 'config' : 'requirements', content: read(n) }));
  if (files.length === 0) return { ok: false, problems: ['no target file found'], codes: [] };
  for (const f of files) {
    if (witness.outputHashes[f.name] !== sha256(f.content)) problems.push(`hash of ${f.name} differs from the witness`);
  }
  for (const n of Object.keys(witness.outputHashes)) if (!files.some((f) => f.name === n)) problems.push(`${n} is listed in the witness but missing`);
  const codes = await reproducibleCodes(witness.platform, source, files);
  if (JSON.stringify(codes) !== JSON.stringify(witness.finalCodes)) problems.push(`issue codes differ: witness [${witness.finalCodes.join(', ')}], now [${codes.join(', ')}]`);
  const hits = files.reduce((s, f) => s + scanSanitized(f.content, langOfFile(f.name)).length, 0);
  if (hits !== witness.sanitizer.afterHits) problems.push(`sanitizer hits differ: witness ${witness.sanitizer.afterHits}, now ${hits}`);
  return { ok: problems.length === 0, problems, codes };
}
