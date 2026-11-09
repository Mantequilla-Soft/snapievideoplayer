// Loading the CommonJS sources from a test, with control over the module cache.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const rootPath = (file) => path.join(ROOT, file);

/** Drop source files (relative to the repo root) from the require cache. */
export function forget(...files) {
  for (const f of files) delete require.cache[rootPath(f)];
}

/**
 * Require a source file fresh, with `env` set only while it loads. For values
 * the module reads once at load time. `alsoFresh` lists files to drop first too
 * (e.g. 'db.js' to get an unconnected db module).
 */
export function requireFresh(file, env = {}, alsoFresh = []) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    forget(file, ...alsoFresh);
    return require(rootPath(file));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Put `exports` in the require cache in place of a package. Returns an undo. */
export function stubPackage(name, exports) {
  const id = require.resolve(name);
  const previous = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports };
  return () => {
    if (previous) require.cache[id] = previous;
    else delete require.cache[id];
  };
}
