export function joinPaths(...paths: string[]): string {
  const segments = paths.flatMap((path) => path.split("/")).filter(Boolean);

  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}
