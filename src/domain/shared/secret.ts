const VALUE = Symbol('SecretString.value');

/**
 * A string that cannot be logged by accident.
 *
 * `toString`, `toJSON` and Node's inspect hook all return `[redacted]`, so a
 * token that ends up in a template literal, a `JSON.stringify`, a `console.log`
 * or a pino payload emits the placeholder instead of the secret. Reading the
 * real value requires an explicit `.expose()`, which is greppable and reviewed.
 *
 * docs/architecture/08-security-architecture.md §8.2
 */
export class SecretString {
  private readonly [VALUE]: string;
  readonly label: string;

  constructor(value: string, label = 'secret') {
    this[VALUE] = value;
    this.label = label;
  }

  /** The only way to read the underlying value. Audit every call site. */
  expose(): string {
    return this[VALUE];
  }

  get length(): number {
    return this[VALUE].length;
  }

  toString(): string {
    return '[redacted]';
  }

  toJSON(): string {
    return '[redacted]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `SecretString(${this.label}) [redacted]`;
  }

  static is(value: unknown): value is SecretString {
    return value instanceof SecretString;
  }
}
