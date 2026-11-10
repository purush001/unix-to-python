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
export async function parsePython(source: string): Promise<{ root: PyNode; release: () => void }> {
  const runtime = await load('runtime');
  await Parser.init({ wasmBinary: runtime } as unknown as Parameters<typeof Parser.init>[0]);
  const language = await Language.load(await load('python'));
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  if (!tree) throw new Error('Python parser returned no tree');
  return {
    root: tree.rootNode,
    release: () => {
      tree.delete();
      parser.delete();
    },
  };
}

export function walkPy(node: PyNode, visit: (n: PyNode) => void): void {
  visit(node);
  for (const c of node.children) if (c) walkPy(c, visit);
}
