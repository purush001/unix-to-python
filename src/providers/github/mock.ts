import { getConfigInt } from '@/config/env';
import { sha256 } from '@/lib/util';
import type { CommitRequest, CommitResult, GitHubProvider } from '../types';

interface MockGitState {
  commits: (CommitRequest & { sha: string })[];
  failNext: number;
  /** Failures already simulated for MOCK_GITHUB_FAILURES. */
  simulated: number;
}
/** Test double state. It is the mock's "remote repository", not application state. */
export function mockGitState(): MockGitState {
  const g = globalThis as unknown as { __mockGit?: MockGitState };
  return (g.__mockGit ??= { commits: [], failNext: 0, simulated: 0 });
}

export function createMockGitHub(): GitHubProvider {
  return {
    name: 'mock',
    async commitFiles(req: CommitRequest): Promise<CommitResult> {
      const st = mockGitState();
      if (st.simulated < getConfigInt('MOCK_GITHUB_FAILURES')) {
        st.simulated++;
        throw new Error('Mock GitHub: simulated save failure');
      }
      if (st.failNext > 0) {
        st.failNext--;
        throw new Error('Mock GitHub: simulated save failure');
      }
      const sha = sha256(JSON.stringify(req)).slice(0, 40);
      st.commits.push({ ...req, sha });
      return { sha, url: `https://github.com/mock-owner/mock-repo/commit/${sha}`, branch: req.branch };
    },
  };
}
