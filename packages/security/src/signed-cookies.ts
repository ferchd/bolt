const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface SignedCookiesOptions {
  readonly secrets: string | readonly string[];
}

export type SecureCookieOptions = Omit<
  Bun.CookieInit,
  "name" | "value"
>;

export class SignedCookies {
  readonly #keys: readonly Promise<CryptoKey>[];

  private constructor(secrets: readonly string[]) {
    this.#keys = secrets.map((secret) => importHmacKey(secret));
  }

  public static create(options: SignedCookiesOptions): SignedCookies {
    const secrets = typeof options.secrets === "string"
      ? [options.secrets]
      : [...options.secrets];

    if (secrets.length === 0) {
      throw new TypeError("At least one cookie signing secret is required");
    }

    for (const secret of secrets) {
      if (encoder.encode(secret).byteLength < 32) {
        throw new TypeError(
          "Cookie signing secrets must contain at least 32 bytes",
        );
      }
    }

    return new SignedCookies(secrets);
  }

  public async get(
    cookies: Bun.CookieMap,
    name: string,
  ): Promise<string | null> {
    const signed = cookies.get(name);
    if (!signed) {
      return null;
    }

    const parts = signed.split(".");
    if (parts.length !== 3 || parts[0] !== "s1") {
      return null;
    }

    const payload = parts[1];
    const signature = parts[2];
    if (!payload || !signature) {
      return null;
    }

    let signatureBytes: Uint8Array<ArrayBuffer>;
    try {
      signatureBytes = Uint8Array.from(
        Buffer.from(signature, "base64url"),
      );
    } catch {
      return null;
    }

    const message = encoder.encode(`${name}\0${payload}`);
    for (const key of this.#keys) {
      if (
        await crypto.subtle.verify(
          "HMAC",
          await key,
          signatureBytes,
          message,
        )
      ) {
        try {
          return decoder.decode(Buffer.from(payload, "base64url"));
        } catch {
          return null;
        }
      }
    }

    return null;
  }

  public async set(
    cookies: Bun.CookieMap,
    name: string,
    value: string,
    options: SecureCookieOptions = {},
  ): Promise<void> {
    const payload = Buffer.from(encoder.encode(value)).toString("base64url");
    const signature = await crypto.subtle.sign(
      "HMAC",
      await this.#keys[0]!,
      encoder.encode(`${name}\0${payload}`),
    );

    cookies.set(name, `s1.${payload}.${toBase64Url(signature)}`, {
      httpOnly: true,
      path: "/",
      sameSite: "strict",
      secure: true,
      ...options,
    });
  }

  public delete(
    cookies: Bun.CookieMap,
    name: string,
    options: Pick<SecureCookieOptions, "domain" | "path"> = {},
  ): void {
    cookies.delete(name, { path: "/", ...options });
  }
}

function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );
}

function toBase64Url(value: ArrayBuffer): string {
  return Buffer.from(value).toString("base64url");
}
