export class ItemNotFoundError extends Error {
  constructor(public readonly externalId: string) {
    super(`Item not found: ${externalId}`);
    this.name = 'ItemNotFoundError';
  }
}

export class ItemAlreadyExistsError extends Error {
  constructor(public readonly externalId: string) {
    super(`Item already exists: ${externalId}`);
    this.name = 'ItemAlreadyExistsError';
  }
}

/**
 * Thrown by ItemStore.forceTransition when the item's current stage does not
 * match the caller's expected `fromStage` — i.e. the item moved between the
 * operator reading its state and the rollback being applied. Route handlers
 * map this to 400 Bad Request.
 */
export class StageMismatchError extends Error {
  constructor(
    public readonly externalId: string,
    public readonly expectedStage: string,
    public readonly actualStage: string,
  ) {
    super(
      `Stage mismatch for ${externalId}: expected current stage '${expectedStage}', but item is at '${actualStage}'`,
    );
    this.name = 'StageMismatchError';
  }
}
