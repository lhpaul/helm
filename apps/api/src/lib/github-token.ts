/**
 * Reads the Helm GitHub PAT from the environment (trimmed).
 * Centralizes env access for dispatch and webhook scheduling paths.
 */
export function readGitHubTokenFromEnv(): string | undefined {
  const token = process.env.GITHUB_TOKEN?.trim();
  return token || undefined;
}
