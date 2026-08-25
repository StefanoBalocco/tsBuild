# tsBuild

Build TypeScript targets and minify their JavaScript output.

## Features

- Config-driven multiple targets: define one or more build targets in a JSON config
- TypeScript API compilation via the TypeScript compiler API (not `tsc` CLI)
- Optional minification: Terser, TerserCompanion, or both. Terser runs first; with both enabled, TerserCompanion processes the current best. The strict smallest UTF-8-byte output wins. Terser options are limited to `module`, `toplevel`, and `mangle`
- Asset copying with optional destination cleanup
- jTDAL template rendering: HTML pages with string, mtime, and file-backed hash variables, and self-contained ESM/CJS renderer modules (minified by the build-level `minify` stage when their generated paths are listed there)
- Strict config validation: unknown keys and malformed values fail the CLI run before any build step
- `all` target runs every configured target in declaration order
- `-f` flag for custom config path
- ESM only

## Installation

Requires Node.js `^22.20.0 || ^24.12.0 || >=26.0.0` (uses native `Set.prototype.intersection()` and `Set.prototype.difference()`).

```sh
npm add @stefanobalocco/tsbuild
```

## Configuration

Create a `tsBuild.json` file (or any JSON file) with an array of target objects:

```json
[
	{
		"target": "lib",
		"tsConfig": "tsconfig.json",
		"name": "MyLib",
		"prefix": "packages/lib",
		"templatesJs": [
			{
				"filename": "src/renderer.tpl",
				"destination": "out/modules",
				"output": "esm"
			}
		],
		"minify": {
			"files": [ "dist/index.js" ],
			"terser": {
				"enabled": true,
				"module": true,
				"toplevel": true,
				"mangle": "^_"
			},
			"terserCompanion": true
		},
		"copy": [
			{
				"destination": "out/assets",
				"files": [ "assets/icons/logo.svg", "assets/config.json" ]
			}
		],
		"templatesHtml": [
			{
				"filename": "src/page.html",
				"destination": "out/pages",
				"variables": [
					{ "name": "title", "type": "string", "value": "My App" },
					{ "name": "stamp", "type": "mtime", "value": "src/data.json" },
					{ "name": "app_hash", "type": "hash-sha2-224", "value": "dist/index.js" },
					{ "name": "app_token", "type": "hash-sha3-224", "value": [ "dist/index.js", "assets" ] },
					{ "name": "app_blake", "type": "hash-blake2s-256", "value": "dist/index.js" }
				]
			}
		]
	}
]
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `target` | `string` | — | Unique target identifier used for selection from CLI/API |
| `tsConfig` | `string` | — | Path to `tsconfig.json`, resolved from config directory plus `prefix` |
| `name` | `string` | `target` | Display name used in log output |
| `prefix` | `string` | `""` | Subdirectory prepended to `tsConfig` and `minify.files` paths |
| `minify.files` | `string[]` | required when `minify` exists | JS file paths to minify, resolved from config directory plus `prefix`. Omit the entire `minify` property to skip minification |
| `minify.terser` | `boolean` or object | `true` when `minify` exists | Enable Terser. Boolean form controls only `enabled`. Object form: `enabled`, `module`, `toplevel`, `mangle` (see below) |
| `minify.terserCompanion` | `boolean` | `true` when `minify` exists | Enable TerserCompanion optimization |
| `copy` | `object[]` | — | Asset copy operations. Each entry: `destination` (config-root directory), `files` (prefix-relative source file paths — individual files only, each copied to `destination/path.basename(file)`), `clean` (boolean, default false — when true, recreates destination before copy) |
| `templatesHtml` | `object[]` | — | jTDAL HTML template rendering. Each entry: `filename` (prefix-relative source), `destination` (config-root directory), `variables` (optional; array of `{ name, type, value }` where `type` is one of `string`, `mtime`, `hash-sha2-224`, `hash-sha3-224`, `hash-blake2s-256`) |
| `templatesJs` | `object[]` | — | jTDAL renderer module generation. Each entry: `filename` (prefix-relative source), `destination` (config-root directory), `output` (`"esm"` or `"cjs"`, required). Modules are written unminified; list their generated `.mjs`/`.cjs` paths under `minify.files` to produce `.min.mjs`/`.min.cjs` siblings |

Per-target operation order: Compile TypeScript → Render templatesJs → Minify → Copy files → Render templatesHtml → `✓ Built.` log.

**Resolution rules:**
- Template `filename`, `mtime`/hash variable `value` source, and `copy.files` resolve from the target directory (config directory + `prefix`).
- All `destination` paths resolve from the configuration directory only; the prefix is never appended.
- Template and copy output filenames use `path.basename()` of the source file. Each `copy.files` entry is an individual file (directory entries are not supported); it is copied to `destination/path.basename(file)`.

**Template variables:** `variables` are resolved only for HTML templates (`templatesHtml`); `templatesJs` continues to reject them. Five types are supported:

| Type | `value` | Rendered |
|------|---------|----------|
| `string` | a string | the string verbatim |
| `mtime` | a source string or `[ source, prefix ]` | whole-millisecond `fs.stat().mtime.getTime()` |
| `hash-sha2-224` | a source string or `[ source, prefix ]` | lower-case hex SHA-224 of the source's raw bytes |
| `hash-sha3-224` | a source string or `[ source, prefix ]` | lower-case hex SHA3-224 of the source's raw bytes |
| `hash-blake2s-256` | a source string or `[ source, prefix ]` | lower-case hex BLAKE2s-256 of the source's raw bytes |

A string `value` renders the direct token: the numeric mtime or the hex digest. A `[ source, prefix ]` tuple renders a URL token: `basename?TOKEN` when the prefix is empty, otherwise `prefix/basename?TOKEN`. The prefix is output-only and never affects which source file is read. Backslashes in the prefix become `/`; a leading `/` is preserved; trailing `/` characters are removed; internal slashes are unchanged. Hashes use the runtime `crypto.getHashes()` set — an unavailable algorithm fails the build/CLI error path. Missing source files retain the raw filesystem error.

### Terser options

`terser` accepts a boolean or an object:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable Terser |
| `module` | `boolean` | context | ES module mode; see the module context table below |
| `toplevel` | `boolean` | `false` | Optimize top-level declarations. Opt-in for CommonJS/script input |
| `mangle` | `false` or `string` | `"^_"` | `false` disables all mangling. A string is the source passed to `RegExp(...)` and becomes `mangle.properties.regex` |

Module context for the `module` default:

| Context | `module` default |
|---------|------------------|
| Build-level `minify` | `true` |

`module: true` makes Terser optimize top-level declarations as if `toplevel` were `true`. `toplevel` matters only for CommonJS/script input, where top-level declarations are preserved unless you opt in. The build-level `minify` applies the same defaults to every listed file, so a CJS entry listed there needs an explicit compatible Terser configuration such as `module: false` when appropriate.

### Template module output

With `templatesJs`, tsBuild compiles the template to a self-contained renderer function and writes it as `filename.mjs` or `filename.cjs` (source basename with the last extension replaced; an extensionless source gains the new one). The renderer takes the runtime data as its single argument and returns the rendered HTML. `variables` and `mtime` are not resolved in this mode — pass the data at call time:

```js
// esm
import render from './out/modules/renderer.mjs';
const html = render( { title: 'My App' } );

// cjs
const render = require( './dist/legacy/renderer.cjs' );
const html = render( { title: 'My App' } );
```

JS template modules are written unminified; there is no per-template minification. To minify a generated module, list its `.mjs` or `.cjs` path under the build-level `minify.files`; the global `minify` stage then writes a `.min.mjs` or `.min.cjs` sibling. When a `prefix` is set, `minify.files` stays relative to the target directory (config directory + `prefix`) while the templatesJs `destination` resolves from the config root, so an entry targeting a generated module outside the prefix needs `..` segments. HTML output (`templatesHtml`) keeps the existing behavior: basename filename, resolved `variables` (empty when omitted).

### Config validation

The config file is validated against a strict Zod schema before any build step. Unknown keys are rejected at every level, `mangle` must be `false` or valid regular expression text, and target identifiers must be unique. Each variable's `type` must be one of the five supported values and its `value` must be a string (for `string`) or a string or `[ source, prefix ]` tuple (for `mtime` and hashes); an unknown `type` is reported at the `.type` path. Each violation fails the CLI run with exit code 1 and one error line per issue, with the full path to the offending field:

```
Invalid tsBuild configuration:
[0].minify.terser.enabledd: Unrecognized key: "enabledd"
[1].templatesJs[0].output: Invalid option: expected one of "esm"|"cjs"
```

Malformed JSON is reported the same way: the logged error message includes `Invalid tsBuild configuration:` (followed by the parser message), and the CLI returns exit code 1.

## CLI

```
tsBuild [-f <config-file>] <target> [<target> ...]
```

- `tsBuild lib` — run the `lib` target from `tsBuild.json` in the current directory
- `tsBuild -f custom.json lib` — use a custom config file
- `tsBuild alpha beta` — run two specific targets
- `tsBuild all` — run every configured target in declaration order

## API

```typescript
import TsBuild from '@stefanobalocco/tsbuild';
import type { TsBuildItem } from '@stefanobalocco/tsbuild';
```

### Type: `TsBuildItem`

```typescript
type TerserConfig = {
	enabled?: boolean;
	module?: boolean;
	toplevel?: boolean;
	mangle?: false | string;
};

type TsBuildItem = {
	target: string;
	tsConfig: string;
	name?: string;
	prefix?: string;
	minify?: {
		files: string[];
		terser?: boolean | TerserConfig;
		terserCompanion?: boolean;
	};
	templatesHtml?: {
		filename: string;
		destination: string;
		variables?: (
			{ name: string; type: 'string'; value: string } |
			{ name: string; type: 'mtime' | 'hash-sha2-224' | 'hash-sha3-224' | 'hash-blake2s-256'; value: string | [ string, string ] }
		)[];
	}[];
	templatesJs?: {
		filename: string;
		destination: string;
		output: 'esm' | 'cjs';
	}[];
	copy?: {
		destination: string;
		files: string[];
		clean?: boolean;
	}[];
};
```

`TsBuildItem` is inferred from the exported Zod schema `tsBuildItemSchema`, which validates one build-item object. The CLI validates the full config array — an array of `tsBuildItemSchema` entries plus cross-item unique-target validation.

### Type: `TerserOptions`

```typescript
type TerserOptions = {
	module?: boolean;
	toplevel?: boolean;
	mangle?: false | string;
};
```

The supported Terser controls. This is deliberately not Terser's full `MinifyOptions`; no other Terser settings are exposed.

### `new TsBuild( configDirectory: string )`

Create a builder that resolves relative paths from the configuration directory.

### `TsBuild.compile( configPath: string ): void`

Compile TypeScript using the compiler API. Throws on diagnostic errors.

### `TsBuild.minify( absPath: string, useTerser: boolean, useTerserCompanion: boolean, terserOptions?: TerserOptions ): Promise<boolean>`

Minify a single JS file. Writes minified output as a sibling file named with `.min` before the original extension: `index.js` → `index.min.js`, `lib.mjs` → `lib.min.mjs`, `lib.cjs` → `lib.min.cjs`. Returns `true` only when the best enabled transformation is strictly smaller than the source in UTF-8 byte length. Terser runs first; TerserCompanion receives the current best (the source when Terser did not strictly shrink). Each result is selected only on a strict byte-length reduction. Empty, equal, or larger results are no gain: `minify` returns `false` and deletes any existing sibling `.min` file, ignoring only `ENOENT`; the source remains unchanged. When both transformations are disabled, `minify` is a no-op and returns `false`. `terserOptions` defaults to `{ module: true, mangle: "^_" }`; `toplevel` defaults to `false`.

**Warning:** Configurations or downstream steps that reference a `.min` file must tolerate `ENOENT` when minification produces no smaller output. Reference the original file when a guaranteed path is required.

### `TsBuild.copy( absDestination: string, absFiles: string[], clean: boolean ): Promise<void>`

Copy files to a destination directory. All paths must be absolute. When `clean` is true, the destination is removed before copying.

### `TsBuild.templating( absTemplate: string, absDestination: string, variables: Record<string, string | number> ): Promise<void>`

Render a jTDAL template file and write the output to the destination directory. The template source path and destination path must be absolute. Output filename uses `path.basename()` of the template source.

### `builder.build( buildItem: TsBuildItem ): Promise<void>`

Build a single item: compile TypeScript, generate js-template modules, optionally minify files, then run copy and html-template operations. This is the sole instance build method.

### `TsBuild.runCli( argumentsInput: string[] ): Promise<number>`

CLI entry point. Returns 0 only after at least one valid selected target completes. Returns 1 for unknown target names, empty target selection, missing config file, or build error.

## Errors

- TypeScript diagnostics cause `compile` and `build` to throw with formatted error output
- Malformed JSON and schema-invalid config files make `runCli` log an error whose message includes `Invalid tsBuild configuration:` and return exit code 1; the error does not propagate to the caller
- CLI returns 1 when build fails or invalid arguments are provided

## License

BSD-3-Clause. See [LICENSE](./LICENSE).
