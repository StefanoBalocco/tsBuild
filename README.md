# tsBuild

Build TypeScript targets and minify their JavaScript output.

## Features

- Config-driven multiple targets: define one or more build targets in a JSON config
- TypeScript API compilation via the TypeScript compiler API (not `tsc` CLI)
- Optional minification: Terser, TerserCompanion, or both (when both produce results, the smaller is selected; if Terser produces no output, TerserCompanion processes the original source). Terser options are limited to `module`, `toplevel`, and `mangle`
- Asset copying with optional destination cleanup
- jTDAL template rendering: HTML pages with string and file-mtime variables, or self-contained ESM/CJS renderer modules
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
		"templates": [
			{
				"filename": "src/page.html",
				"destination": "out/pages",
				"variables": [
					{ "name": "title", "type": "string", "value": "My App" },
					{ "name": "stamp", "type": "mtime", "value": "src/data.json" }
				]
			},
			{
				"filename": "src/renderer.tpl",
				"destination": "out/modules",
				"output": "esm"
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
| `templates` | `object[]` | — | jTDAL template rendering. Each entry: `filename` (prefix-relative source), `destination` (config-root directory), `output` (`"html"` default, or `"esm"`/`"cjs"`), `variables` (optional; array of `{ name, type: "string" | "mtime", value }`), `minify` (optional; `terser` and `terserCompanion` as in build `minify`, without `files`) |

Copy and template operations run after compile and minify, before the final build log.

**Resolution rules:**
- Template `filename`, `mtime` variable `value` file, and `copy.files` resolve from the target directory (config directory + `prefix`).
- All `destination` paths resolve from the configuration directory only; the prefix is never appended.
- Template and copy output filenames use `path.basename()` of the source file. Each `copy.files` entry is an individual file (directory entries are not supported); it is copied to `destination/path.basename(file)`.

**`mtime` type:** Passes the numeric Unix timestamp in whole milliseconds from `fs.stat().mtime.getTime()`.

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
| Template `output: "esm"` | `true` |
| Template `output: "cjs"` | `false` |

`module: true` makes Terser optimize top-level declarations as if `toplevel` were `true`. `toplevel` matters only for CommonJS/script input, where top-level declarations are preserved unless you opt in.

### Template module output

With `output: "esm"` or `"cjs"`, tsBuild compiles the template to a self-contained renderer function and writes it as `filename.mjs` or `filename.cjs` (source basename with the last extension replaced; an extensionless source gains the new one). The renderer takes the runtime data as its single argument and returns the rendered HTML. `variables` and `mtime` are not resolved in this mode — pass the data at call time:

```js
// esm
import render from './out/modules/renderer.mjs';
const html = render( { title: 'My App' } );

// cjs
const render = require( './dist/legacy/renderer.cjs' );
const html = render( { title: 'My App' } );
```

The wrapped module is minified in memory when minification is enabled — `terser` and `terserCompanion` default to `true` for JS templates, even when `minify` is absent. The minified text replaces the module in place; no `.min.mjs` or `.min.cjs` sibling is written. HTML output (`output: "html"`, the default) keeps the existing behavior: basename filename, resolved `variables` (empty when omitted), and any `minify` field is ignored.

### Config validation

The config file is validated against a strict Zod schema before any build step. Unknown keys are rejected at every level, `mangle` must be `false` or valid regular expression text, and target identifiers must be unique. Each violation fails the CLI run with exit code 1 and one error line per issue, with the full path to the offending field:

```
Invalid tsBuild configuration:
[0].minify.terser.enabledd: Unrecognized key: "enabledd"
[1].templates[0].minify.terser.mangle: Invalid regular expression
```

Malformed JSON is reported the same way: the logged error message includes `Invalid tsBuild configuration:` (followed by the parser message), and the CLI returns exit code 1.

**Per-target operation order:** Compile TypeScript → Minify → Copy files → Render templates → `✓ Built.` log.

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
	templates?: {
		filename: string;
		destination: string;
		output?: 'html' | 'esm' | 'cjs';
		variables?: {
			name: string;
			type: 'string' | 'mtime';
			value: string;
		}[];
		minify?: {
			terser?: boolean | TerserConfig;
			terserCompanion?: boolean;
		};
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

Minify a single JS file. Writes minified output as a sibling file named with `.min` before the original extension: `index.js` → `index.min.js`, `lib.mjs` → `lib.min.mjs`, `lib.cjs` → `lib.min.cjs`. Returns `true` when minified output is written. `terserOptions` defaults to `{ module: true, mangle: "^_" }`; `toplevel` defaults to `false`.

### `TsBuild.copy( absDestination: string, absFiles: string[], clean: boolean ): Promise<void>`

Copy files to a destination directory. All paths must be absolute. When `clean` is true, the destination is removed before copying.

### `TsBuild.templating( absTemplate: string, absDestination: string, variables: Record<string, string | number> ): Promise<void>`

Render a jTDAL template file and write the output to the destination directory. The template source path and destination path must be absolute. Output filename uses `path.basename()` of the template source.

### `builder.build( buildItem: TsBuildItem ): Promise<void>`

Build a single item: compile TypeScript, optionally minify files, then run copy and template operations. This is the sole instance build method.

### `TsBuild.runCli( argumentsInput: string[] ): Promise<number>`

CLI entry point. Returns 0 only after at least one valid selected target completes. Returns 1 for unknown target names, empty target selection, missing config file, or build error.

## Errors

- TypeScript diagnostics cause `compile` and `build` to throw with formatted error output
- Malformed JSON and schema-invalid config files make `runCli` log an error whose message includes `Invalid tsBuild configuration:` and return exit code 1; the error does not propagate to the caller
- CLI returns 1 when build fails or invalid arguments are provided

## License

BSD-3-Clause. See [LICENSE](./LICENSE).
