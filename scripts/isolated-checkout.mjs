import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

/**
 * Build and browser checks write `.next`, `out` and `test-results` into the
 * directory they run in. A developer's live `next dev` serves from the same
 * `.next`, so running them in the checkout corrupts the running app (for
 * example by inlining a throwaway backend port into the compiled page).
 * This copies the working tree into a temporary directory, shares
 * `node_modules` through a symlink, and lets the checks run there instead.
 */
const EXCLUDED = new Set([".git", "node_modules", ".next", "out", "test-results", "reports", ".stryker-tmp", ".playwright-mcp"]);

export function wantsInPlace(argv = process.argv.slice(2), env = process.env) {
  return argv.includes("--in-place") || env.CHECKS_IN_PLACE === "1";
}

export async function createIsolatedCheckout(root) {
  const dir = await mkdtemp(join(tmpdir(), `${basename(root)}-checks-`));
  await cp(root, dir, {
    recursive: true,
    filter: (source) => {
      const rel = relative(root, resolve(source));
      return rel === "" || !EXCLUDED.has(rel.split(sep)[0]);
    },
  });
  await symlink(resolve(root, "node_modules"), join(dir, "node_modules"), "dir");
  return {
    dir,
    /** Removes the copy; failed runs keep it so traces and build output stay inspectable. */
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
