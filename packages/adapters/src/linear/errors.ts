export class LinearAuthError extends Error {
  override readonly name = 'LinearAuthError' as const;
  constructor(message: string) {
    super(message);
  }
}

export class LinearNotFoundError extends Error {
  override readonly name = 'LinearNotFoundError' as const;
  constructor(message: string) {
    super(message);
  }
}

export class LinearAPIError extends Error {
  override readonly name = 'LinearAPIError' as const;
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export class LinearConfigError extends Error {
  override readonly name = 'LinearConfigError' as const;
  constructor(message: string) {
    super(message);
  }
}
