import test from 'ava';
import type { ExecutionContext } from 'ava';
import type { Stats } from 'node:fs';
import type { MinifyOutput } from 'terser';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { minify } from 'terser';
import terserCompanion from '@stefanobalocco/tersercompanion';
import TsBuild from '../../dist/tsBuild.js';

const __dirname: string = path.dirname( fileURLToPath( import.meta.url ) );
const fixturesRoot: string = path.resolve( __dirname, '../fixtures' );
const worksRoot: string = path.resolve( __dirname, '../.works' );
const cliPath: string = path.resolve( __dirname, '../../dist/tsBuild.js' );
const execFileAsync: ( file: string, args: string[], options?: object ) => Promise<{ stdout: string; stderr: string }> = promisify( execFile );

let workspaceCounter: number = 0;

async function createWorkspace( fixtureName: string ): Promise<string> {
	await mkdir( worksRoot, { recursive: true } );
	workspaceCounter++;
	const workspace: string = path.join( worksRoot, `workspace_${ workspaceCounter }` );
	await cp( path.join( fixturesRoot, fixtureName ), workspace, { recursive: true } );
	return workspace;
}

async function exists( filePath: string ): Promise<boolean> {
	try {
		await stat( filePath );
		return true;
	} catch {
		return false;
	}
}

async function fileSize( filePath: string ): Promise<number> {
	const stats: Stats = await stat( filePath );
	return stats.size;
}

test.after.always( async (): Promise<void> => {
	await rm( worksRoot, { recursive: true, force: true } );
} );

test.serial( 'fromConfigFile builds one configured target', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'minimal' );
	const builder: TsBuild = await TsBuild.fromConfigFile( path.join( workspace, 'tsBuild.json' ) );
	const result: boolean = await builder.build( new Set<string>( [ 'lib' ] ) );

	t.true( result );
	t.true( await exists( path.join( workspace, 'dist/index.js' ) ) );
	t.false( await exists( path.join( workspace, 'dist/index.min.js' ) ) );
} );

test.serial( 'build runs all configured targets in declaration order', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'multi' );
	const builder: TsBuild = await TsBuild.fromConfigFile( path.join( workspace, 'tsBuild.json' ) );
	const result: boolean = await builder.build( new Set<string>( [ 'all' ] ) );

	t.true( result );
	t.true( await exists( path.join( workspace, 'dist/beta.js' ) ) );
	t.true( await exists( path.join( workspace, 'dist/alpha.js' ) ) );
} );

test.serial( 'build runs multiple explicitly named targets', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'multi' );
	const builder: TsBuild = await TsBuild.fromConfigFile( path.join( workspace, 'tsBuild.json' ) );
	const result: boolean = await builder.build( new Set<string>( [ 'alpha', 'beta' ] ) );

	t.true( result );
	t.true( await exists( path.join( workspace, 'dist/alpha.js' ) ) );
	t.true( await exists( path.join( workspace, 'dist/beta.js' ) ) );
} );

test.serial( 'build runs a selected subset', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'multi' );
	const builder: TsBuild = await TsBuild.fromConfigFile( path.join( workspace, 'tsBuild.json' ) );
	const result: boolean = await builder.build( new Set<string>( [ 'alpha' ] ) );

	t.true( result );
	t.true( await exists( path.join( workspace, 'dist/alpha.js' ) ) );
	t.false( await exists( path.join( workspace, 'dist/beta.js' ) ) );
} );

test.serial( 'build resolves prefix from the configuration file directory', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'prefixed' );
	const builder: TsBuild = await TsBuild.fromConfigFile( path.join( workspace, 'tsBuild.json' ) );
	const result: boolean = await builder.build( new Set<string>( [ 'lib' ] ) );

	t.true( result );
	t.true( await exists( path.join( workspace, 'packages/lib/dist/index.js' ) ) );
} );

test.serial( 'minify configuration supports all requested modes', async ( t: ExecutionContext ): Promise<void> => {
	// Terser-only
	const terserWorkspace: string = await createWorkspace( 'minify' );
	const terserBuilder: TsBuild = await TsBuild.fromConfigFile( path.join( terserWorkspace, 'terser.json' ) );
	const terserResult: boolean = await terserBuilder.build( new Set<string>( [ 'lib' ] ) );

	t.true( terserResult );
	const terserMinPath: string = path.join( terserWorkspace, 'dist/index.min.js' );
	t.true( await exists( terserMinPath ) );
	const terserSourceSize: number = await fileSize( path.join( terserWorkspace, 'dist/index.js' ) );
	const terserMinSize: number = await fileSize( terserMinPath );
	t.true( terserMinSize <= terserSourceSize );

	// Companion-only
	const companionWorkspace: string = await createWorkspace( 'minify' );
	const companionBuilder: TsBuild = await TsBuild.fromConfigFile( path.join( companionWorkspace, 'companion.json' ) );
	const companionResult: boolean = await companionBuilder.build( new Set<string>( [ 'lib' ] ) );

	t.true( companionResult );
	t.true( await exists( path.join( companionWorkspace, 'dist/index.min.js' ) ) );

	// Default (both)
	const defaultWorkspace: string = await createWorkspace( 'minify' );
	const defaultBuilder: TsBuild = await TsBuild.fromConfigFile( path.join( defaultWorkspace, 'tsBuild.json' ) );
	const defaultResult: boolean = await defaultBuilder.build( new Set<string>( [ 'lib' ] ) );

	t.true( defaultResult );
	t.true( await exists( path.join( defaultWorkspace, 'dist/index.min.js' ) ) );

	// Disabled
	const disabledWorkspace: string = await createWorkspace( 'minify' );
	const disabledBuilder: TsBuild = await TsBuild.fromConfigFile( path.join( disabledWorkspace, 'disabled.json' ) );
	const disabledResult: boolean = await disabledBuilder.build( new Set<string>( [ 'lib' ] ) );

	t.true( disabledResult );
	t.false( await exists( path.join( disabledWorkspace, 'dist/index.min.js' ) ) );
} );

test.serial( 'runCli reads the default config from the process working directory', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'minimal' );
	await execFileAsync( process.execPath, [ cliPath, 'lib' ], { cwd: workspace } );

	t.true( await exists( path.join( workspace, 'dist/index.js' ) ) );
} );

test.serial( 'runCli accepts a custom config path', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'minimal' );
	const exitCode: number = await TsBuild.runCli( [ '-f', path.join( workspace, 'custom.json' ), 'lib' ] );

	t.is( exitCode, 0 );
	t.true( await exists( path.join( workspace, 'dist/index.js' ) ) );
} );

test.serial( 'installed-package bin executes the build with copy and templates', async ( t: ExecutionContext ): Promise<void> => {
	const uniqueDir: string = path.join( worksRoot, `bin_test_${ Date.now() }` );
	await mkdir( uniqueDir, { recursive: true } );

	// Copy post-build fixture into workspace (has copy + template config)
	const fixtureDir: string = path.join( uniqueDir, 'fixture' );
	await cp( path.join( fixturesRoot, 'post-build' ), fixtureDir, { recursive: true } );

	// Create tarball from project root; obtain filename from --json output
	const projectRoot: string = path.resolve( __dirname, '../..' );
	const packResult: string = ( await execFileAsync( 'npm', [ 'pack', '--pack-destination', uniqueDir, '--json' ], { cwd: projectRoot } ) ).stdout;
	const packEntry: { filename: string } = JSON.parse( packResult )[ 0 ];
	const tarballFilename: string = packEntry.filename;

	// Install tarball into consumer directory
	const consumerDir: string = path.join( uniqueDir, 'consumer' );
	await mkdir( consumerDir, { recursive: true } );
	await writeFile( path.join( consumerDir, 'package.json' ), '{"private":true}\n' );

	const tarballPath: string = path.join( uniqueDir, tarballFilename );
	await execFileAsync( 'npm', [ 'install', tarballPath ], { cwd: consumerDir } );

	// Execute the real npm-generated .bin symlink against the post-build template fixture
	const binPath: string = path.join( consumerDir, 'node_modules/.bin/tsBuild' );
	await execFileAsync(
		binPath,
		[ '-f', path.join( fixtureDir, 'default.json' ), 'lib' ],
		{ cwd: uniqueDir }
	);

	// Compiled output still works (prefixed path)
	t.true( await exists( path.join( fixtureDir, 'project/dist/index.js' ) ), 'output project/dist/index.js exists' );

	// Template rendered through published consumer path — proves jTDAL works from .bin
	const templatePath: string = path.join( fixtureDir, 'out/pages/page.html' );
	t.true( await exists( templatePath ), 'rendered template exists at out/pages/page.html' );

	const html: string = await readFile( templatePath, 'utf8' );
	t.true( html.includes( 'tsBuild template' ), 'template variable rendered via published bin' );
} );

test.serial( 'minifyFile on .mjs writes sibling .min.mjs and leaves original unchanged', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/lib.mjs' );
	const minPath: string = path.join( ws, 'dist/lib.min.mjs' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, 'export const version = "1.0.0";\n' );

	const result: boolean = await TsBuild.minifyFile( sourcePath, true, false );

	t.true( result );
	t.true( await exists( minPath ) );

	const originalContent: string = await readFile( sourcePath, 'utf8' );
	t.is( originalContent, 'export const version = "1.0.0";\n' );
} );

test.serial( 'minifyFile on .cjs writes sibling .min.cjs and leaves original unchanged', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/lib.cjs' );
	const minPath: string = path.join( ws, 'dist/lib.min.cjs' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, 'module.exports = { x: 1 };\n' );

	const result: boolean = await TsBuild.minifyFile( sourcePath, true, false );

	t.true( result );
	t.true( await exists( minPath ) );

	const originalContent: string = await readFile( sourcePath, 'utf8' );
	t.is( originalContent, 'module.exports = { x: 1 };\n' );
} );

test.serial( 'minifyFile on extensionless file writes sibling .min and leaves original unchanged', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/bundle' );
	const minPath: string = path.join( ws, 'dist/bundle.min' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, 'export const version = "1.0.0";\n' );

	const result: boolean = await TsBuild.minifyFile( sourcePath, true, false );

	t.true( result );
	t.true( await exists( minPath ) );

	const originalContent: string = await readFile( sourcePath, 'utf8' );
	t.is( originalContent, 'export const version = "1.0.0";\n' );
} );

test.serial( 'minifyFile on comments-only .js removes stale .min.js and returns false', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/empty.js' );
	const minPath: string = path.join( ws, 'dist/empty.min.js' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, '// just a comment\n/* another one */\n' );
	await writeFile( minPath, 'stale content\n' );

	const result: boolean = await TsBuild.minifyFile( sourcePath, true, false );

	t.false( result );
	t.true( await exists( sourcePath ) );
	t.is( await readFile( sourcePath, 'utf8' ), '// just a comment\n/* another one */\n' );
	t.false( await exists( minPath ) );
} );

test.serial( 'minifyFile with both transforms on comments-only source lets TerserCompanion fall back to original', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/empty.js' );
	const minPath: string = path.join( ws, 'dist/empty.min.js' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, '// just a comment\n/* another one */\n' );

	// Both transforms active: Terser produces nothing, TerserCompanion receives original source
	const result: boolean = await TsBuild.minifyFile( sourcePath, true, true );

	t.true( result );
	t.true( await exists( minPath ) );
	t.is( await readFile( minPath, 'utf8' ), '// just a comment\n/* another one */\n' );
	t.is( await readFile( sourcePath, 'utf8' ), '// just a comment\n/* another one */\n' );
} );

test.serial( 'default copy and templates resolve prefix sources and config-root destinations', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'post-build' );

	// Create stale file to prove clean defaults to false
	await mkdir( path.join( workspace, 'out/assets' ), { recursive: true } );
	await writeFile( path.join( workspace, 'out/assets/stale.txt' ), 'stale' );

	const builder: TsBuild = await TsBuild.fromConfigFile( path.join( workspace, 'default.json' ) );
	const result: boolean = await builder.build( new Set<string>( [ 'lib' ] ) );

	t.true( result );

	// Copied files present
	t.true( await exists( path.join( workspace, 'out/assets/one.txt' ) ), 'one.txt copied' );
	t.true( await exists( path.join( workspace, 'out/assets/two.txt' ) ), 'two.txt copied' );

	// Stale file preserved (clean default false)
	t.true( await exists( path.join( workspace, 'out/assets/stale.txt' ) ), 'stale.txt preserved' );

	// Template rendered at config-root destination, not nested under prefix
	const templatePath: string = path.join( workspace, 'out/pages/page.html' );
	t.true( await exists( templatePath ), 'page.html exists at out/pages/page.html' );
	t.false( await exists( path.join( workspace, 'out/pages/templates/page.html' ) ), 'templates/ directory not replicated under out/pages' );

	const html: string = await readFile( templatePath, 'utf8' );
	t.true( html.includes( 'tsBuild template' ), 'title variable rendered' );

	// Raw numeric mtimeMs
	const mtimeStat: Stats = await stat( path.join( workspace, 'project/assets/mtime.txt' ) );
	t.true( html.includes( String( mtimeStat.mtimeMs ) ), 'raw mtimeMs rendered' );
} );

test.serial( 'clean copy removes destination then copies files', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'post-build' );

	// Create stale file to prove clean removes it
	await mkdir( path.join( workspace, 'out/assets' ), { recursive: true } );
	await writeFile( path.join( workspace, 'out/assets/stale.txt' ), 'stale' );

	const builder: TsBuild = await TsBuild.fromConfigFile( path.join( workspace, 'clean.json' ) );
	const result: boolean = await builder.build( new Set<string>( [ 'lib' ] ) );

	t.true( result );

	// Stale file gone
	t.false( await exists( path.join( workspace, 'out/assets/stale.txt' ) ), 'stale.txt removed by clean' );

	// Copied files present
	t.true( await exists( path.join( workspace, 'out/assets/one.txt' ) ), 'one.txt copied after clean' );
	t.true( await exists( path.join( workspace, 'out/assets/two.txt' ) ), 'two.txt copied after clean' );
} );

test.serial( 'build all targets in declaration order: last target output overwrites previous', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'target-order' );
	const builder: TsBuild = await TsBuild.fromConfigFile( path.join( workspace, 'tsBuild.json' ) );
	const result: boolean = await builder.build( new Set<string>( [ 'all' ] ) );

	t.true( result );
	t.true( await exists( path.join( workspace, 'shared/index.js' ) ), 'shared/index.js exists' );

	const content: string = await readFile( path.join( workspace, 'shared/index.js' ), 'utf8' );
	t.true( content.includes( 'ALPHA_VERSION' ), 'shared/index.js contains alpha marker (last target wins)' );
} );

test.serial( 'copy with clean precedes template rendering to same destination', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'post-build' );

	const builder: TsBuild = await TsBuild.fromConfigFile( path.join( workspace, 'ordered.json' ) );
	const result: boolean = await builder.build( new Set<string>( [ 'lib' ] ) );

	t.true( result );

	// Copy ran first — copied asset exists
	t.true( await exists( path.join( workspace, 'ordered/one.txt' ) ), 'one.txt copied to ordered/' );

	// Template ran second — rendered page exists (would be deleted if copy ran after)
	t.true( await exists( path.join( workspace, 'ordered/page.html' ) ), 'page.html rendered to ordered/' );

	const html: string = await readFile( path.join( workspace, 'ordered/page.html' ), 'utf8' );
	t.true( html.includes( 'tsBuild ordered' ), 'template variable rendered' );
} );

test.serial( 'library import with nonexistent argv[1] does not trigger CLI build', async ( t: ExecutionContext ): Promise<void> => {
	const uniqueDir: string = path.join( worksRoot, `import_test_${ Date.now() }` );
	await mkdir( uniqueDir, { recursive: true } );

	const helperScript: string = path.join( uniqueDir, 'import_nonexistent_argv.mjs' );
	await writeFile( helperScript, [
		`process.argv = [ process.argv[ 0 ], '/nonexistent/path/to/module.mjs' ];`,
		`await import( ${ JSON.stringify( cliPath ) } );`,
	].join( '\n' ) );

	await execFileAsync( process.execPath, [ helperScript ] );
	t.pass( 'import with nonexistent argv[1] exits 0 (or promise would reject)' );
} );

test.serial( 'compileTsc throws on malformed tsconfig JSON', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsconfig.json' ), '{ invalid json }' );

	t.throws( () => TsBuild.compileTsc( path.join( ws, 'tsconfig.json' ) ) );
} );

test.serial( 'compileTsc throws on type diagnostics', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'src/index.ts' ), 'const value: number = \'wrong\';\n' );

	t.throws( () => TsBuild.compileTsc( path.join( ws, 'tsconfig.json' ) ) );
} );

test.serial( 'minifyFile on comments-only .js rethrows EISDIR from unlink when output path is a directory', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/dirpath.js' );
	const dirPath: string = path.join( ws, 'dist/dirpath.min.js' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, '// just a comment\n' );
	await mkdir( dirPath, { recursive: true } );

	const error: NodeJS.ErrnoException = await t.throwsAsync(
		async (): Promise<boolean> => TsBuild.minifyFile( sourcePath, true, false )
	);
	t.is( error.code, 'EISDIR' );
} );

test.serial( 'minifyFile on absent .min file catches ENOENT from unlink', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/absent.js' );
	const minPath: string = path.join( ws, 'dist/absent.min.js' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, '// just a comment\n/* another one */\n' );
	// deliberately no min file — unlink throws ENOENT

	const result: boolean = await TsBuild.minifyFile( sourcePath, true, false );

	t.false( result );
	t.false( await exists( minPath ) );
} );

test.serial( 'minifyFile picks companion when its output is strictly smaller', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/companion-wins.js' );
	const minPath: string = path.join( ws, 'dist/companion-wins.min.js' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, [
		'export function run() {',
		'	console.log( "VERY_LONG_STRING_THAT_APPEARS_MULTIPLE_TIMES_FOR_COMPANION_TO_ALIAS_A" );',
		'	console.log( "VERY_LONG_STRING_THAT_APPEARS_MULTIPLE_TIMES_FOR_COMPANION_TO_ALIAS_A" );',
		'	console.log( "VERY_LONG_STRING_THAT_APPEARS_MULTIPLE_TIMES_FOR_COMPANION_TO_ALIAS_A" );',
		'	console.log( "VERY_LONG_STRING_THAT_APPEARS_MULTIPLE_TIMES_FOR_COMPANION_TO_ALIAS_A" );',
		'	console.log( "VERY_LONG_STRING_THAT_APPEARS_MULTIPLE_TIMES_FOR_COMPANION_TO_ALIAS_A" );',
		'	console.log( "VERY_LONG_STRING_THAT_APPEARS_MULTIPLE_TIMES_FOR_COMPANION_TO_ALIAS_A" );',
		'}',
	].join( '\n' ) );

	const sourceText: string = await readFile( sourcePath, 'utf8' );
	const terserResult: MinifyOutput = await minify( sourceText, {
		module: true,
		toplevel: true,
		compress: { defaults: true, passes: 2 },
		mangle: { properties: { regex: /^_/ } }
	} );
	const terserOutput: string = terserResult.code ?? '';
	const companionOutput: string = terserCompanion( terserOutput );
	const terserSize: number = Buffer.byteLength( terserOutput, 'utf8' );
	const companionSize: number = Buffer.byteLength( companionOutput, 'utf8' );

	t.true( companionSize < terserSize, `expected companion ${ companionSize } < terser ${ terserSize }` );

	const result: boolean = await TsBuild.minifyFile( sourcePath, true, true );

	t.true( result );
	t.true( await exists( minPath ) );

	const minContent: string = await readFile( minPath, 'utf8' );
	t.is( minContent, companionOutput );
} );

test.serial( 'build returns false for unknown target name', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	const builder: TsBuild = await TsBuild.fromConfigFile( path.join( ws, 'tsBuild.json' ) );
	const result: boolean = await builder.build( new Set<string>( [ 'unknown' ] ) );

	t.false( result );
} );

test.serial( 'build returns false for empty target selection', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	const builder: TsBuild = await TsBuild.fromConfigFile( path.join( ws, 'tsBuild.json' ) );
	const result: boolean = await builder.build( new Set<string>() );

	t.false( result );
} );

test.serial( 'runCli returns exit code 1 for missing config file', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	const exitCode: number = await TsBuild.runCli( [ '-f', path.join( ws, 'missing.json' ), 'lib' ] );

	t.is( exitCode, 1 );
} );
