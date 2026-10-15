# Vendored tree-sitter grammar

This directory holds the ONE compiled tree-sitter grammar this plugin's bash
planner needs, checked into the repository rather than depended on. Read this
file the way `build/platform.ts` is read: it records where a frozen artifact
came from, because the artifact itself carries no such note.

## `tree-sitter-bash.wasm`

| Fact | Value |
| --- | --- |
| Source URL | `https://registry.npmjs.org/tree-sitter-bash/-/tree-sitter-bash-0.25.1.tgz` |
| File inside that package | `tree-sitter-bash.wasm` (package root) |
| Publishing package | `tree-sitter-bash`, version `0.25.1` (the tree-sitter project's own grammar package) |
| Byte size | `1358224` |
| SHA-256 (base64) | `gpKRnIig99P7MdDNAlPKWpUxvB7egrBTfyxj3Yq+ano=` |
| SHA-256 (hex) | `8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a` |
| Magic bytes | `00 61 73 6d` (the WebAssembly preamble) |
| Module kind | side module, custom section `dylink.0` |
| Language name / ABI | `bash`, ABI 15 |

### Why the file is vendored instead of depended on

`tree-sitter-bash` is a source grammar: depending on it would pull in a Node
native addon (`bindings/node`), a 180 kB `grammar.json` and a C scanner, none of
which a plugin that only ever calls `Language.load` needs. The one file this
plugin uses is vendored here, listed in the package's `files`, and resolved at
runtime from the module's own URL (`import.meta.url`) rather than from
`process.cwd()` — a plugin is loaded from an arbitrary working directory.

### Why THIS build, and not `tree-sitter-wasms@0.1.13`

The original plan was the single file `out/tree-sitter-bash.wasm` published by
`tree-sitter-wasms@0.1.13` (1 400 214 bytes, SHA-256
`gH3NsTgKWb77ES7Y+9PThyx/ra9ZA6dpKCtQlzswaW0=`). That file is a real 1.4 MB
tree-sitter bash grammar and downloads byte-for-byte as advertised — but it
cannot be loaded by `web-tree-sitter@0.27.1`, which is this plugin's loader.
Measured on this machine, not inferred:

1. Its `dylink` custom section is named `dylink`. `web-tree-sitter` ≥ 0.26
   requires `dylink.0` and throws `Error` from `getDylinkMetadata` inside
   `Language.load`. Only `web-tree-sitter` ≤ 0.25.10 still accepts the legacy
   section name.
2. Even there it is unusable: the grammar imports `env.isalpha` and
   `env.__assert_fail`, and no `web-tree-sitter` build from 0.20 through 0.27
   exports either symbol. `web-tree-sitter` 0.25.10 loads the module and parses
   `if`/`for`/`while`, then dies with `TypeError: resolved is not a function` on
   the first `case` statement and poisons the runtime for every parse after it.
   The grammar inside `tree-sitter-wasms@0.1.13` was built by
   `tree-sitter-cli@0.20.8` (the package's own `devDependencies`), i.e. before
   emscripten emitted `dylink.0` and before the core exported those two symbols.

The grammar below is the same project's current official build, compiled
against a tree-sitter core `web-tree-sitter@0.27.1` can host: it loads, reports
`name = bash`, and parses `if`/`for`/`while`/`case`/functions/subshells with
`hasError` false, while a `then` without `fi` really does set `hasError`.

The loader (`web-tree-sitter@0.27.1`) is the plugin's own runtime library with
no cross-plugin identity to share, so it is a plain `dependencies` entry. It is
deliberately NOT bundled: it resolves its own `.wasm` support files from inside
its package (via `new URL("web-tree-sitter.wasm", import.meta.url)`), and tsdown
keeps `dependencies` external for exactly that reason.

### How to re-verify a fetched copy

```powershell
Invoke-WebRequest -Uri 'https://registry.npmjs.org/tree-sitter-bash/-/tree-sitter-bash-0.25.1.tgz' -OutFile tree-sitter-bash.tgz
tar -xzf tree-sitter-bash.tgz --strip-components=1 tree-sitter-bash/package/tree-sitter-bash.wasm
Move-Item tree-sitter-bash.wasm vendor/tree-sitter-bash.wasm -Force
(Get-FileHash vendor/tree-sitter-bash.wasm -Algorithm SHA256).Hash   # must be 8292919C88A0F7D3FB31D0CD0253CA5A9531BC1EDE82B0537F2C63DD8ABE6A7A
```

A mismatch means the artifact is not the one this plugin was verified against;
`src/bashtree.ts` refuses to use a grammar it cannot load, so a substituted file
degrades to "no plan" rather than to a wrong plan.
