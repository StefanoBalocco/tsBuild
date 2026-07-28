# tsBuild

Build TypeScript targets and minify their JavaScript output.

## Features

- Config-driven multiple targets: define one or more build targets in a JSON config
- TypeScript API compilation via the TypeScript compiler API (not `tsc` CLI)
- Optional minification: Terser, TerserCompanion, or both (when both produce results, the smaller is selected; if Terser produces no output, TerserCompanion processes the original source)
- Asset copying with optional destination cleanup
- jTDAL template rendering with string and file-mtime variables
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
			"terser": true,
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
| `minify.terser` | `boolean` | `true` when `minify` exists | Enable Terser minification |
| `minify.terserCompanion` | `boolean` | `true` when `minify` exists | Enable TerserCompanion optimization |
| `copy` | `object[]` | — | Asset copy operations. Each entry: `destination` (config-root directory), `files` (prefix-relative source file paths — individual files only, each copied to `destination/path.basename(file)`), `clean` (boolean, default false — when true, recreates destination before copy) |
| `templates` | `object[]` | — | jTDAL template rendering. Each entry: `filename` (prefix-relative source), `destination` (config-root directory), `variables` (array of `{ name, type: "string" | "mtime", value }`) |

Copy and template operations run after compile and minify, before the final build log.

**Resolution rules:**
- Template `filename`, `mtime` variable `value` file, and `copy.files` resolve from the target directory (config directory + `prefix`).
- All `destination` paths resolve from the configuration directory only; the prefix is never appended.
- Template and copy output filenames use `path.basename()` of the source file. Each `copy.files` entry is an individual file (directory entries are not supported); it is copied to `destination/path.basename(file)`.

**`mtime` type:** Passes the raw numeric Unix milliseconds timestamp from `fs.stat().mtimeMs`. No rounding or string conversion.

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
type TsBuildItem = {
	target: string;
	tsConfig: string;
	name?: string;
	prefix?: string;
	minify?: {
		files: string[];
		terser?: boolean;
		terserCompanion?: boolean;
	};
	templates?: {
		filename: string;
		destination: string;
		variables: {
			name: string;
			type: 'string' | 'mtime';
			value: string;
		}[];
	}[];
	copy?: {
		destination: string;
		files: string[];
		clean?: boolean;
	}[];
};
```

### `new TsBuild( configDirectory: string, targets: TsBuildItem[] )`

Create a builder. Targets run in the order provided.

### `TsBuild.fromConfigFile( configFile: string ): Promise<TsBuild>`

Load targets from a JSON config file.

### `TsBuild.compileTsc( configPath: string ): void`

Compile TypeScript using the compiler API. Throws on diagnostic errors.

### `TsBuild.minifyFile( absPath: string, useTerser: boolean, useTerserCompanion: boolean ): Promise<boolean>`

Minify a single JS file. Writes minified output as a sibling file named with `.min` before the original extension: `index.js` → `index.min.js`, `lib.mjs` → `lib.min.mjs`, `lib.cjs` → `lib.min.cjs`. Returns `true` when minified output is written.

### `builder.build( targetNames: Set<string> ): Promise<boolean>`

Build selected targets. Pass `new Set( [ 'all' ] )` for all targets. Returns `false` on unknown targets or empty selection.

### `TsBuild.runCli( argumentsInput: string[] ): Promise<number>`

CLI entry point. Returns exit code (0 on success, 1 on error).

## Errors

- TypeScript diagnostics cause `compileTsc` and `build` to throw with formatted error output
- CLI returns 1 when build fails or invalid arguments are provided
- `build` returns `false` for unknown or empty target selections

## License

BSD-3-Clause. See [LICENSE](./LICENSE).
