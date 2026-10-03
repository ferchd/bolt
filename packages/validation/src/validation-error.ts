export type ValidationIssueCode =
  | "invalid_format"
  | "invalid_type"
  | "invalid_value"
  | "too_big"
  | "too_small";

export type ValidationPath = readonly (number | string)[];

export interface ValidationIssue {
  readonly code: ValidationIssueCode;
  readonly message: string;
  readonly path: ValidationPath;
}

export class ValidationError extends Error {
  public override readonly name = "ValidationError";
  public readonly issues: readonly ValidationIssue[];

  public constructor(issues: readonly ValidationIssue[]) {
    const frozenIssues = issues.map((issue) =>
      Object.freeze({ ...issue, path: Object.freeze([...issue.path]) }),
    );
    const first = frozenIssues[0];
    const message = first
      ? `Validation failed at ${formatPath(first.path)}: ${first.message}`
      : "Validation failed";

    super(message);
    this.issues = Object.freeze(frozenIssues);
  }
}

function formatPath(path: ValidationPath): string {
  if (path.length === 0) {
    return "$";
  }

  return path.reduce<string>((result, segment) => {
    if (typeof segment === "number") {
      return `${result}[${segment}]`;
    }

    return /^[A-Za-z_$][\w$]*$/.test(segment)
      ? `${result}.${segment}`
      : `${result}[${JSON.stringify(segment)}]`;
  }, "$");
}
