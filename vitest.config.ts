// Vitest config — node 26 + vite 5.4 issue: the SSR transform emits bare
// 'sqlite' for node:sqlite imports, but node's builtinModules only carries the
// colon form ('node:sqlite'), so vite's resolver fails on the bare specifier.
// Fix: resolve both specifiers to a virtual module whose load() emits a
// direct re-export from the real builtin — no externalization involved.
import { defineConfig, type Plugin } from 'vitest/config';

const SQLITE_VIRTUAL = '\0pramaan:node-sqlite';

const sqliteShim: Plugin = {
  name: 'pramaan-sqlite-shim',
  enforce: 'pre',
  resolveId(source) {
    if (source === 'sqlite' || source === 'node:sqlite' || source === SQLITE_VIRTUAL) {
      return SQLITE_VIRTUAL;
    }
    return null;
  },
  load(id) {
    if (id === SQLITE_VIRTUAL) {
      // createRequire sidesteps the resolver, so this does NOT re-enter
      // our resolveId and cannot self-recurse.
      return [
        "import { createRequire } from 'node:module';",
        "const req = createRequire(import.meta.url);",
        "const m = req('node:sqlite');",
        "export const DatabaseSync = m.DatabaseSync;",
        "export default m;",
      ].join('\n');
    }
    return null;
  },
};

export default defineConfig({
  plugins: [sqliteShim],
});
