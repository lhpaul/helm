export class GitHubAuthError extends Error {
  override readonly name = 'GitHubAuthError' as const;
  constructor(message: string) {
    super(message);
  }
}

export class GitHubNotFoundError extends Error {
  override readonly name = 'GitHubNotFoundError' as const;
  constructor(message: string) {
    super(message);
  }
}

export class GitHubAPIError extends Error {
  override readonly name = 'GitHubAPIError' as const;
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export class GitHubConfigError extends Error {
  override readonly name = 'GitHubConfigError' as const;
  constructor(message: string) {
    super(message);
  }
}
