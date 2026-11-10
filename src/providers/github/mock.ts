import { sha256 } from '@/lib/util';
import type { CommitRequest, CommitResult, GitHubProvider } from '../types';

interface MockGitState {
  commits: (CommitRequest & { sha: string })[];
  failNext: number;
}
/** Test double state. It is the mock's "remote repository", not application state. */
export function mockGitState(): MockGitState {
  const g = globalThis as unknown as { __mockGit?: MockGitState };
  return (g.__mockGit ??= { commits: [], failNext: 0 });
}

export function createMockGitHub(): GitHubProvider {
  return {
    name: 'mock',
    async commitFiles(req: CommitRequest): Promise<CommitResult> {
      const st = mockGitState();
      if (st.failNext > 0) {
        st.failNext--;
        throw new Error('Mock GitHub: simulated save failure');
      }
      const sha = sha256(JSON.stringify(req)).slice(0, 40);
      st.commits.push({ ...req, sha });
      return { sha, url: `https://github.invalid/mock/commit/${sha}`, branch: req.branch };
    },
  };
}
