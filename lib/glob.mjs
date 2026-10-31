// @ts-check
import { isWindows } from "./platform.mjs";

const cache = new Map();

/** Minimal glob -> RegExp. Supports **, *, and ?. Brackets are literal. */
export function globToRegExp(pattern) {
  const key = String(pattern);
  const hit = cache.get(key);
  if (hit) return hit;

  let p = key.replaceAll("\\", "/").replace(/^\.\//, "");
  let out = "^";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        i++;
        if (p[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\^$+?.()|{}[]".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  out += "$";
  const re = new RegExp(out);
  cache.set(key, re);
  return re;
}

export function matchesAny(relPath, patterns = [], options = {}) {
  const value = String(relPath);
  const platform = options.platform ?? process.platform;
  if (isWindows(platform)) {
    const folded = value.toLowerCase();
    return patterns.some(
      (pattern) =>
        globToRegExp(pattern).test(value) ||
        globToRegExp(String(pattern).toLowerCase()).test(folded),
    );
  }
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

/**
 * Case-insensitive match for deny lists. On a case-insensitive filesystem,
 * `.ENV` and `.env` are the same file, so a deny entry must match both.
 * `matchesAny` becomes case-insensitive on Windows for the same reason; POSIX
 * scope stays exact.
 */
export function matchesAnyCaseInsensitive(relPath, patterns = []) {
  const value = String(relPath);
  const folded = value.toLowerCase();
  return patterns.some((pattern) => {
    if (globToRegExp(pattern).test(value)) return true;
    return globToRegExp(String(pattern).toLowerCase()).test(folded);
  });
}

export function matchesGlob(relPath, pattern) {
  return globToRegExp(pattern).test(relPath);
}
