#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const owner = process.env.GITHUB_OWNER ?? 'pure-craft';
const repo = process.env.GITHUB_REPO ?? 'dsh-actions';
const npmPackage = process.env.NPM_PACKAGE ?? 'dsh-actions';
const period = process.argv[2] ?? 'last-month';

const allowedPeriods = new Set(['last-day', 'last-week', 'last-month', 'last-year']);

if (!allowedPeriods.has(period) && !/^\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$/.test(period)) {
  console.error(
    'Usage: node scripts/project-metrics.mjs [last-day|last-week|last-month|last-year|YYYY-MM-DD:YYYY-MM-DD]',
  );
  process.exit(2);
}

async function readJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': `${repo}-metrics-script`,
      ...headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    const rateLimited = response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0';
    if (rateLimited) {
      throw new Error(
        `GitHub API rate limit exceeded. Set GITHUB_TOKEN/GH_TOKEN or log in with \`gh auth login\`, then retry.`,
      );
    }
    throw new Error(`${response.status} ${response.statusText} from ${url}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

function resolveGitHubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;

  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
  } catch {
    return undefined;
  }
}

const githubToken = resolveGitHubToken();
const githubHeaders = githubToken ? { Authorization: `Bearer ${githubToken}` } : {};
const encodedPackage = encodeURIComponent(npmPackage);
const [downloads, repository] = await Promise.all([
  readJson(`https://api.npmjs.org/downloads/point/${period}/${encodedPackage}`),
  readJson(`https://api.github.com/repos/${owner}/${repo}`, githubHeaders),
]);

const metrics = {
  npmDownloads: downloads.downloads,
  npmPeriod: `${downloads.start} → ${downloads.end}`,
  githubStars: repository.stargazers_count,
  openIssues: repository.open_issues_count,
};

console.log(`${owner}/${repo} · ${npmPackage}`);
console.log(`npm 下载量 (${metrics.npmPeriod}): ${metrics.npmDownloads.toLocaleString('en-US')}`);
console.log(`GitHub Stars: ${metrics.githubStars.toLocaleString('en-US')}`);
console.log(`Open Issues: ${metrics.openIssues.toLocaleString('en-US')}`);
