export interface PasswordHashOptions {
  readonly memoryCost?: number;
  readonly timeCost?: number;
}

export async function hashPassword(
  password: string,
  options: PasswordHashOptions = {},
): Promise<string> {
  assertPassword(password);

  return Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: options.memoryCost ?? 65_536,
    timeCost: options.timeCost ?? 2,
  });
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  if (!password || !hash || byteLength(password) > 1_024) {
    return false;
  }

  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

function assertPassword(password: string): void {
  const length = byteLength(password);

  if (length === 0) {
    throw new TypeError("Password cannot be empty");
  }

  if (length > 1_024) {
    throw new RangeError("Password cannot exceed 1024 UTF-8 bytes");
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
