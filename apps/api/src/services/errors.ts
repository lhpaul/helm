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
