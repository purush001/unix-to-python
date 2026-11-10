import { getConfig, requireSecret } from '@/config/env';
import { ProviderError } from '@/lib/errors';
import type { CommitRequest, CommitResult, GitHubProvider } from '../types';

/** Commits several files in one commit through the Git Data API. Creates the data branch (orphan) if missing. */
export function createRealGitHub(): GitHubProvider {
  return {
    name: 'github',
    async commitFiles(req: CommitRequest): Promise<CommitResult> {
      const repo = getConfig('GITHUB_REPO');
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_REPO must be set to owner/name');
      const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
        let res: Response;
        try {
          res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${requireSecret('GITHUB_TOKEN')}`,
              accept: 'application/vnd.github+json',
              'x-github-api-version': '2022-11-28',
              'user-agent': 'script-modernizer',
              ...(body ? { 'content-type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(20000),
          });
        } catch {
          throw new ProviderError('github', 'network', 502, 'Could not reach GitHub');
        }
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return { status: res.status, json };
      };
      const must = (r: { status: number; json: Record<string, unknown> }, what: string) => {
        if (r.status >= 300) throw new ProviderError('github', 'http', r.status, `GitHub ${what} failed with HTTP ${r.status}`);
        return r.json;
      };

      const ref = await api('GET', `/git/ref/heads/${encodeURIComponent(req.branch)}`);
      let parentSha: string | null = null;
      let baseTree: string | undefined;
      if (ref.status === 200) {
        parentSha = (ref.json.object as { sha: string }).sha;
        const parent = must(await api('GET', `/git/commits/${parentSha}`), 'read commit');
        baseTree = (parent.tree as { sha: string }).sha;
      } else if (ref.status !== 404) {
        must(ref, 'read branch');
      }
      const tree = must(
        await api('POST', '/git/trees', {
          ...(baseTree ? { base_tree: baseTree } : {}),
          tree: req.files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
        }),
        'create tree',
      );
      const commit = must(await api('POST', '/git/commits', { message: req.message, tree: tree.sha, parents: parentSha ? [parentSha] : [] }), 'create commit');
      const sha = commit.sha as string;
      if (parentSha) must(await api('PATCH', `/git/refs/heads/${encodeURIComponent(req.branch)}`, { sha, force: false }), 'update branch');
      else must(await api('POST', '/git/refs', { ref: `refs/heads/${req.branch}`, sha }), 'create branch');
      return { sha, url: `https://github.com/${repo}/commit/${sha}`, branch: req.branch };
    },
  };
}
