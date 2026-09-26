import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Resolve exported pages without allowing URL paths or symlinks outside the export. */
export function resolveStaticFile(root: string, requestUrl: string): string | undefined {
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(requestUrl.split("?")[0]);
  } catch {
    return undefined;
  }
  if (!urlPath.startsWith("/") || urlPath.includes("\0") || urlPath.includes("\\")) return;
  // Reject traversal even when normalization would happen to stay within the root.
  if (urlPath.split("/").includes("..")) return;
  try {
    const realRoot = realpathSync(root);
    const path = resolve(realRoot, `.${urlPath}`);
    for (const candidate of [path, `${path}.html`, resolve(path, "index.html")]) {
      if (!contained(realRoot, candidate)) continue;
      try {
        const realCandidate = realpathSync(candidate);
        if (contained(realRoot, realCandidate) && statSync(realCandidate).isFile()) {
          return realCandidate;
        }
      } catch {
        // Missing candidates are normal for extensionless exported routes.
      }
    }
  } catch {
    // The export may not have been built yet.
  }
}
