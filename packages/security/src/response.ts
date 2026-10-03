export async function responseFrom(
  value: unknown,
): Promise<Response> {
  const resolved = await value;

  if (resolved instanceof Response) {
    return resolved;
  }

  if (resolved === undefined) {
    return new Response(null, { status: 204 });
  }

  if (typeof resolved === "string" || resolved instanceof Blob) {
    return new Response(resolved);
  }

  return Response.json(resolved);
}

export function withHeaders(
  response: Response,
  additions: HeadersInit,
): Response {
  const headers = new Headers(response.headers);

  new Headers(additions).forEach((value, name) => {
    headers.set(name, value);
  });

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function appendVary(headers: Headers, value: string): void {
  const existing = headers.get("vary");
  const values = new Set(
    existing
      ?.split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );

  values.add(value.toLowerCase());
  headers.set("vary", [...values].join(", "));
}
