import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Language, Parser, type Node as TSNode } from 'web-tree-sitter';

export type PyNode = TSNode;

/** Locations tried for the WASM files: project root in dev/test, traced files on Vercel. */
function wasmCandidates(file: string): string[] {
  const rel = file === 'runtime' ? ['node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'] : ['node_modules', 'tree-sitter-python', 'tree-sitter-python.wasm'];
  return [path.join(/* turbopackIgnore: true */ process.cwd(), ...rel)];
}
async function load(file: 'runtime' | 'python'): Promise<Uint8Array> {
  let last: unknown;
  for (const p of wasmCandidates(file)) {
    try {
      return await readFile(p);
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`Python parser WASM not found (${file}): ${String(last)}`);
}

/**
 * Parses Python with tree-sitter (WASM). Nothing is executed. A parser is built per
 * call; the compiled grammar holds no request data.
 */
export async function parsePython(source: string): Promise<{ root: PyNode; parse: (text: string) => PyNode | null; release: () => void }> {
  const runtime = await load('runtime');
  await Parser.init({ wasmBinary: runtime } as unknown as Parameters<typeof Parser.init>[0]);
  const language = await Language.load(await load('python'));
  const parser = new Parser();
  parser.setLanguage(language);
  const trees: { delete(): void }[] = [];
  const parse = (text: string): PyNode | null => {
    const tree = parser.parse(text);
    if (!tree) return null;
    trees.push(tree);
    return tree.rootNode;
  };
  const root = parse(source);
  if (!root) throw new Error('Python parser returned no tree');
  return {
    root,
    parse,
    release: () => {
      for (const t of trees) t.delete();
      parser.delete();
    },
  };
}

export function walkPy(node: PyNode, visit: (n: PyNode) => void): void {
  visit(node);
  for (const c of node.children) if (c) walkPy(c, visit);
}

/** Top-level chunks of a module, so a syntax error is located inside its own definition. */
export function topLevelChunks(source: string): { startLine: number; text: string }[] {
  const lines = source.split('\n');
  const chunks: { startLine: number; text: string }[] = [];
  let start = 0;
  let inTriple: string | null = null;
  let depth = 0;
  const flush = (end: number) => {
    if (end > start) chunks.push({ startLine: start + 1, text: lines.slice(start, end).join('\n') });
    start = end;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const startsBlock = inTriple === null && depth <= 0 && /^(def |class |async def |@|if __name__|[A-Za-z_][A-Za-z0-9_]* *[:=]|import |from )/.test(l) && !/^@/.test(lines[i - 1] ?? '');
    if (startsBlock && i > start) {
      flush(i);
      depth = 0;
    }
    // track triple-quoted strings and brackets (comments and ordinary strings are skipped roughly)
    let k = 0;
    while (k < l.length) {
      if (inTriple) {
        const e = l.indexOf(inTriple, k);
        if (e === -1) break;
        k = e + 3;
        inTriple = null;
        continue;
      }
      const c = l[k];
      if (c === '#') break;
      if (l.startsWith('"""', k) || l.startsWith("'''", k)) {
        inTriple = l.slice(k, k + 3);
        k += 3;
        continue;
      }
      if (c === '"' || c === "'") {
        const e = l.indexOf(c, k + 1);
        k = e === -1 ? l.length : e + 1;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      k++;
    }
  }
  flush(lines.length);
  return chunks;
}
