import { PROJECT_API_URL } from '../constants/app';

export type ProjectCommunityStats = { stars: number; forks: number; issues: number };

export async function fetchProjectCommunityStats(signal?: AbortSignal): Promise<ProjectCommunityStats> {
  const response = await fetch(PROJECT_API_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    credentials: 'omit',
    signal,
  });
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
  const data = await response.json();
  const values = [data.stargazers_count, data.forks_count, data.open_issues_count];
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('GitHub 社区数据格式错误');
  }
  return { stars: values[0], forks: values[1], issues: values[2] };
}
