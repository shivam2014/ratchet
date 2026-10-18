// @ts-check
const cache = new Map();

/** Minimal glob -> RegExp. Supports **, *, ?, and character classes. */
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

export function matchesAny(relPath, patterns = []) {
  return patterns.some((pattern) => globToRegExp(pattern).test(relPath));
}

export function matchesGlob(relPath, pattern) {
  return globToRegExp(pattern).test(relPath);
}
