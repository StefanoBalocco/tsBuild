import test from 'ava';
import type { ExecutionContext } from 'ava';
import type { Stats } from 'node:fs';
import type { MinifyOutput } from 'terser';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { minify } from 'terser';
import terserCompanion from '@stefanobalocco/tersercompanion';
import { ZeptoLogger } from '@stefanobalocco/zeptologger';
import TsBuild from '../../dist/tsBuild.js';
import type { TsBuildItem } from '../../dist/tsBuild.js';

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
	let returnValue: boolean;
	try {
		await stat( filePath );
		returnValue = true;
	} catch {
		returnValue = false;
	}
	return returnValue;
}

async function fileSize( filePath: string ): Promise<number> {
	const stats: Stats = await stat( filePath );
	return stats.size;
}

async function buildItem( workspace: string, configFile: string, targetName: string ): Promise<void> {
	const configPath: string = path.join( workspace, configFile );
	const content: string = await readFile( configPath, 'utf8' );
	const buildItems: TsBuildItem[] = JSON.parse( content ) as TsBuildItem[];
	const builder: TsBuild = new TsBuild( path.dirname( configPath ) );
	const item: TsBuildItem | undefined = buildItems.find( ( entry: TsBuildItem ): boolean => entry.target === targetName );
	if( !item ) {
		throw new Error( `Target "${ targetName }" not found in ${ configFile }` );
	}
	await builder.build( item );
}

async function runCliWithCapturedLog( argumentsInput: string[] ): Promise<{ exitCode: number; output: string }> {
	let returnValue: { exitCode: number; output: string };
	const loggerDestination: Writable = ( ZeptoLogger.instance as unknown as { _destination: Writable } )._destination;
	let capturedOutput: string = '';
	const collector: Writable = new Writable( {
		write( chunk: Buffer | string, _encoding: BufferEncoding, callback: ( error?: Error | null ) => void ): void {
			capturedOutput += chunk.toString();
			callback();
		}
	} );
	ZeptoLogger.instance.destination = collector;
	try {
		const exitCode: number = await TsBuild.runCli( argumentsInput );
		returnValue = { exitCode, output: capturedOutput };
	} finally {
		ZeptoLogger.instance.destination = loggerDestination;
	}
	return returnValue;
}

const abcSha224: string = 'Iwl9IjQF2CKGQqR3vaJVsyqtvOS9oLP342ydpw';
const abcSha3_224: string = '5kKCTD-M8krQkjTufTx2b8mjpRaNDJStc7Rv3w';
const abcBlake2s256: string = 'UIxejDJ8FOLhpyujTutFLzdFiyCe1jopTZmbTIZnWYI';
const abcShake256_64: string = 'SDNmYBNgqHc';
const abcShake256_96: string = 'SDNmYBNgqHccaGMI';
const abcMd5_128: string = 'kAFQmDzST7DWlj99KOF_cg';

async function renderedValue( workspace: string, relPath: string, variableName: string ): Promise<string> {
	const html: string = await readFile( path.join( workspace, relPath ), 'utf8' );
	const match: RegExpMatchArray | null = html.match( new RegExp( `${ variableName }=\\[<span>([^<]*)<\\/span>\\]` ) );
	if( !match ) {
		throw new Error( `Variable "${ variableName }" not found in ${ relPath }` );
	}
	return match[ 1 ];
}

test.after.always( async (): Promise<void> => {
	await rm( worksRoot, { recursive: true, force: true } );
} );

test.serial( 'build one configured target', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'minimal' );
	await buildItem( workspace, 'tsBuild.json', 'lib' );

	t.true( await exists( path.join( workspace, 'dist/index.js' ) ) );
	t.false( await exists( path.join( workspace, 'dist/index.min.js' ) ) );
} );

test.serial( 'runCli builds all configured targets in declaration order', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'multi' );
	const exitCode: number = await TsBuild.runCli( [ '-f', path.join( workspace, 'tsBuild.json' ), 'all' ] );

	t.is( exitCode, 0 );
	t.true( await exists( path.join( workspace, 'dist/beta.js' ) ) );
	t.true( await exists( path.join( workspace, 'dist/alpha.js' ) ) );
} );

test.serial( 'runCli builds multiple explicitly named targets', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'multi' );
	const exitCode: number = await TsBuild.runCli( [ '-f', path.join( workspace, 'tsBuild.json' ), 'alpha', 'beta' ] );

	t.is( exitCode, 0 );
	t.true( await exists( path.join( workspace, 'dist/alpha.js' ) ) );
	t.true( await exists( path.join( workspace, 'dist/beta.js' ) ) );
} );

test.serial( 'runCli builds a selected subset', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'multi' );
	const exitCode: number = await TsBuild.runCli( [ '-f', path.join( workspace, 'tsBuild.json' ), 'alpha' ] );

	t.is( exitCode, 0 );
	t.true( await exists( path.join( workspace, 'dist/alpha.js' ) ) );
	t.false( await exists( path.join( workspace, 'dist/beta.js' ) ) );
} );

test.serial( 'build resolves prefix from the configuration file directory', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'prefixed' );
	await buildItem( workspace, 'tsBuild.json', 'lib' );

	t.true( await exists( path.join( workspace, 'packages/lib/dist/index.js' ) ) );
} );

test.serial( 'minify configuration supports all requested modes', async ( t: ExecutionContext ): Promise<void> => {
	// Terser-only
	const terserWorkspace: string = await createWorkspace( 'minify' );
	await buildItem( terserWorkspace, 'terser.json', 'lib' );

	const terserMinPath: string = path.join( terserWorkspace, 'dist/index.min.js' );
	t.true( await exists( terserMinPath ) );
	const terserSourceSize: number = await fileSize( path.join( terserWorkspace, 'dist/index.js' ) );
	const terserMinSize: number = await fileSize( terserMinPath );
	t.true( terserMinSize < terserSourceSize );

	// Companion-only
	const companionWorkspace: string = await createWorkspace( 'minify' );
	await buildItem( companionWorkspace, 'companion.json', 'lib' );

	t.true( await exists( path.join( companionWorkspace, 'dist/index.min.js' ) ) );

	// Default (both)
	const defaultWorkspace: string = await createWorkspace( 'minify' );
	await buildItem( defaultWorkspace, 'tsBuild.json', 'lib' );

	t.true( await exists( path.join( defaultWorkspace, 'dist/index.min.js' ) ) );

	// Disabled
	const disabledWorkspace: string = await createWorkspace( 'minify' );
	await buildItem( disabledWorkspace, 'disabled.json', 'lib' );

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

test.serial( 'minify on .mjs writes sibling .min.mjs and leaves original unchanged', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/lib.mjs' );
	const minPath: string = path.join( ws, 'dist/lib.min.mjs' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, 'export const version = "1.0.0";\n' );

	const result: boolean = await TsBuild.minify( 'dist/lib.mjs', sourcePath, true, false );

	t.true( result );
	t.true( await exists( minPath ) );

	const originalContent: string = await readFile( sourcePath, 'utf8' );
	t.is( originalContent, 'export const version = "1.0.0";\n' );
} );

test.serial( 'minify defaults partial terser options to module mode', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/lib.mjs' );
	const minPath: string = path.join( ws, 'dist/lib.min.mjs' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, 'const unused = "unused";\nexport const version = "1.0.0";\n' );

	const result: boolean = await TsBuild.minify( 'dist/lib.mjs', sourcePath, true, false, {} );

	t.true( result );
	t.true( await exists( minPath ) );
	const minifiedSource: string = await readFile( minPath, 'utf8' );
	t.false( minifiedSource.includes( 'unused' ) );
} );

test.serial( 'minify on .cjs writes sibling .min.cjs and leaves original unchanged', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/lib.cjs' );
	const minPath: string = path.join( ws, 'dist/lib.min.cjs' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, 'module.exports = { x: 1 };\n' );

	const result: boolean = await TsBuild.minify( 'dist/lib.cjs', sourcePath, true, false );

	t.true( result );
	t.true( await exists( minPath ) );

	const originalContent: string = await readFile( sourcePath, 'utf8' );
	t.is( originalContent, 'module.exports = { x: 1 };\n' );
} );

test.serial( 'minify on extensionless file writes sibling .min and leaves original unchanged', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/bundle' );
	const minPath: string = path.join( ws, 'dist/bundle.min' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, 'export const version = "1.0.0";\n' );

	const result: boolean = await TsBuild.minify( 'dist/bundle', sourcePath, true, false );

	t.true( result );
	t.true( await exists( minPath ) );

	const originalContent: string = await readFile( sourcePath, 'utf8' );
	t.is( originalContent, 'export const version = "1.0.0";\n' );
} );

test.serial( 'minify on comments-only .js writes an empty .min sibling', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/empty.js' );
	const minPath: string = path.join( ws, 'dist/empty.min.js' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, '// just a comment\n/* another one */\n' );
	await writeFile( minPath, 'stale content\n' );

	const result: boolean = await TsBuild.minify( 'dist/empty.js', sourcePath, true, false );

	t.true( result );
	t.true( await exists( sourcePath ) );
	t.is( await readFile( sourcePath, 'utf8' ), '// just a comment\n/* another one */\n' );
	t.true( await exists( minPath ) );
	t.is( await readFile( minPath, 'utf8' ), '' );
} );

test.serial( 'minify with both transforms on comments-only source writes an empty .min sibling', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/empty.js' );
	const minPath: string = path.join( ws, 'dist/empty.min.js' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, '// just a comment\n/* another one */\n' );
	await writeFile( minPath, 'stale content\n' );

	// Both transforms active: Terser produces an empty string, which is selected over the comments-only source; the .min sibling is empty
	const result: boolean = await TsBuild.minify( 'dist/empty.js', sourcePath, true, true );

	t.true( result );
	t.is( await readFile( sourcePath, 'utf8' ), '// just a comment\n/* another one */\n' );
	t.true( await exists( minPath ) );
	t.is( await readFile( minPath, 'utf8' ), '' );
} );

test.serial( 'minify writes the .min sibling with the source content when Terser output is larger than source', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/larger.js' );
	const minPath: string = path.join( ws, 'dist/larger.min.js' );
	const source: string = 'console.log(1)';

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, source );
	await writeFile( minPath, 'stale content\n' );

	const terserResult: MinifyOutput = await minify( source, {
		module: true,
		toplevel: false,
		compress: { defaults: true, passes: 2 },
		mangle: { properties: { regex: /^_/ } }
	} );
	const terserOutput: string = terserResult.code ?? '';
	t.true( 0 < terserOutput.length );
	t.true( Buffer.byteLength( source, 'utf8' ) < Buffer.byteLength( terserOutput, 'utf8' ) );

	const result: boolean = await TsBuild.minify( 'dist/larger.js', sourcePath, true, false );

	t.true( result );
	t.true( await exists( minPath ) );
	t.is( await readFile( minPath, 'utf8' ), source );
	t.is( await readFile( sourcePath, 'utf8' ), source );
} );

test.serial( 'minify selects Terser output by UTF-8 byte length even when it has more characters than the source', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( workspace, 'dist/multibyte.js' );
	const minPath: string = path.join( workspace, 'dist/multibyte.min.js' );
	const source: string = '//\u00e9\nconsole.log("A\u2028B");';

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, source );

	const terserResult: MinifyOutput = await minify( source, {
		module: true,
		toplevel: false,
		compress: { defaults: true, passes: 2 },
		mangle: { properties: { regex: /^_/ } }
	} );
	const terserOutput: string = terserResult.code ?? '';
	t.is( terserOutput, 'console.log("A\\u2028B");' );
	t.true( Buffer.byteLength( terserOutput, 'utf8' ) < Buffer.byteLength( source, 'utf8' ) );
	t.true( source.length < terserOutput.length );
	t.is( terserCompanion( terserOutput ), terserOutput );
	t.is( terserCompanion( source ), source );

	const result: boolean = await TsBuild.minify( 'dist/multibyte.js', sourcePath, true, true );
	t.true( result );
	t.true( await exists( minPath ) );
	t.is( await readFile( minPath, 'utf8' ), terserOutput );
} );

test.serial( 'minify with no gain still renders the tuple hash from the surviving source', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'minify-hash-no-gain' );
	const sourcePath: string = path.join( workspace, 'project/assets/no-gain.js' );
	const minPath: string = path.join( workspace, 'project/assets/no-gain.min.js' );

	await buildItem( workspace, 'tsBuild.json', 'lib' );

	t.true( await exists( sourcePath ) );
	t.true( await exists( minPath ) );
	const source: Buffer = await readFile( sourcePath );
	const expectedDigest: string = createHash( 'sha224' ).update( source ).digest( 'base64url' );
	t.is( await renderedValue( workspace, 'out/token.html', 'token' ), `assets/no-gain.js?${ expectedDigest }` );
} );

test.serial( 'default copy and templatesHtml resolve prefix sources and config-root destinations', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'post-build' );

	// Create stale file to prove clean defaults to false
	await mkdir( path.join( workspace, 'out/assets' ), { recursive: true } );
	await writeFile( path.join( workspace, 'out/assets/stale.txt' ), 'stale' );

	await buildItem( workspace, 'default.json', 'lib' );

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

	// Raw numeric mtime
	const mtimeStat: Stats = await stat( path.join( workspace, 'project/assets/mtime.txt' ) );
	t.true( html.includes( String( mtimeStat.mtime.getTime() ) ), 'raw mtime rendered' );
} );

test.serial( 'clean copy removes destination then copies files', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'post-build' );

	// Create stale file to prove clean removes it
	await mkdir( path.join( workspace, 'out/assets' ), { recursive: true } );
	await writeFile( path.join( workspace, 'out/assets/stale.txt' ), 'stale' );

	await buildItem( workspace, 'clean.json', 'lib' );

	// Stale file gone
	t.false( await exists( path.join( workspace, 'out/assets/stale.txt' ) ), 'stale.txt removed by clean' );

	// Copied files present
	t.true( await exists( path.join( workspace, 'out/assets/one.txt' ) ), 'one.txt copied after clean' );
	t.true( await exists( path.join( workspace, 'out/assets/two.txt' ) ), 'two.txt copied after clean' );
} );

test.serial( 'runCli builds all targets in declaration order: last target output overwrites previous', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'target-order' );
	const exitCode: number = await TsBuild.runCli( [ '-f', path.join( workspace, 'tsBuild.json' ), 'all' ] );

	t.is( exitCode, 0 );
	t.true( await exists( path.join( workspace, 'shared/index.js' ) ), 'shared/index.js exists' );

	const content: string = await readFile( path.join( workspace, 'shared/index.js' ), 'utf8' );
	t.true( content.includes( 'ALPHA_VERSION' ), 'shared/index.js contains alpha marker (last target wins)' );
} );

test.serial( 'copy with clean precedes template rendering to same destination', async ( t: ExecutionContext ): Promise<void> => {
	const workspace: string = await createWorkspace( 'post-build' );

	await buildItem( workspace, 'ordered.json', 'lib' );

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

test.serial( 'compile throws on malformed tsconfig JSON', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsconfig.json' ), '{ invalid json }' );

	t.throws( () => TsBuild.compile( path.join( ws, 'tsconfig.json' ) ) );
} );

test.serial( 'compile throws on type diagnostics', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'src/index.ts' ), 'const value: number = \'wrong\';\n' );

	t.throws( () => TsBuild.compile( path.join( ws, 'tsconfig.json' ) ) );
} );

test.serial( 'minify rethrows EISDIR from writing the .min output when the output path is a directory', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/dirpath.js' );
	const dirPath: string = path.join( ws, 'dist/dirpath.min.js' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, '// just a comment\n' );
	await mkdir( dirPath, { recursive: true } );

	// The .min path is a directory; writeFile throws EISDIR (not unlink)
	const error: NodeJS.ErrnoException = await t.throwsAsync(
		async (): Promise<boolean> => TsBuild.minify( 'dist/dirpath.js', sourcePath, true, false )
	);
	t.is( error.code, 'EISDIR' );
} );

test.serial( 'minify on absent .min file writes the .min sibling', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/absent.js' );
	const minPath: string = path.join( ws, 'dist/absent.min.js' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, '// just a comment\n/* another one */\n' );
	// deliberately no min file — it is created by minify

	const result: boolean = await TsBuild.minify( 'dist/absent.js', sourcePath, true, false );

	t.true( result );
	t.true( await exists( minPath ) );
} );

test.serial( 'minify on empty .js writes an empty .min sibling and returns true', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/blank.js' );
	const minPath: string = path.join( ws, 'dist/blank.min.js' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, '' );

	const result: boolean = await TsBuild.minify( 'dist/blank.js', sourcePath, true, true );

	t.true( result );
	t.true( await exists( minPath ) );
	t.is( await readFile( minPath, 'utf8' ), '' );
} );

test.serial( 'minify with Terser only on empty .js writes an empty .min sibling and returns true', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/blank-terser.js' );
	const minPath: string = path.join( ws, 'dist/blank-terser.min.js' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, '' );

	const result: boolean = await TsBuild.minify( 'dist/blank-terser.js', sourcePath, true, false );

	t.true( result );
	t.true( await exists( minPath ) );
	t.is( await readFile( minPath, 'utf8' ), '' );
} );

test.serial( 'minify with TerserCompanion only on empty .js writes an empty .min sibling and returns true', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/blank-companion.js' );
	const minPath: string = path.join( ws, 'dist/blank-companion.min.js' );

	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, '' );

	const result: boolean = await TsBuild.minify( 'dist/blank-companion.js', sourcePath, false, true );

	t.true( result );
	t.true( await exists( minPath ) );
	t.is( await readFile( minPath, 'utf8' ), '' );
} );

test.serial( 'minify picks companion when its output is strictly smaller', async ( t: ExecutionContext ): Promise<void> => {
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

	const result: boolean = await TsBuild.minify( 'dist/companion-wins.js', sourcePath, true, true );

	t.true( result );
	t.true( await exists( minPath ) );

	const minContent: string = await readFile( minPath, 'utf8' );
	t.is( minContent, companionOutput );
} );

test.serial( 'runCli returns exit code 1 for unknown target name', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	const exitCode: number = await TsBuild.runCli( [ '-f', path.join( ws, 'tsBuild.json' ), 'unknown' ] );

	t.is( exitCode, 1 );
} );

test.serial( 'runCli returns exit code 1 for empty target selection', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	const exitCode: number = await TsBuild.runCli( [ '-f', path.join( ws, 'tsBuild.json' ) ] );

	t.is( exitCode, 1 );
} );

test.serial( 'runCli returns exit code 1 for missing config file', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	const exitCode: number = await TsBuild.runCli( [ '-f', path.join( ws, 'missing.json' ), 'lib' ] );

	t.is( exitCode, 1 );
} );

test.serial( 'runCli rejects configs with unknown nested terser keys', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsBuild.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			minify: {
				files: [ 'dist/index.js' ],
				terser: { enabled: true, unknownKey: true }
			}
		}
	] ) );

	const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );
	const outputLines: string[] = result.output.split( '\n' );

	t.is( result.exitCode, 1 );
	t.true( outputLines.includes( '[0].minify.terser.unknownKey: Unrecognized key: "unknownKey"' ) );
	t.false( outputLines.some( ( line: string ): boolean => line.includes( 'Invalid input: expected boolean, received object' ) ) );
} );

test.serial( 'runCli rejects configs with invalid mangle regex text', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsBuild.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			minify: {
				files: [ 'dist/index.js' ],
				terser: { mangle: '[' }
			}
		}
	] ) );

	const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );

	t.is( result.exitCode, 1 );
	t.true( result.output.includes( '[0].minify.terser.mangle' ) );
	t.true( result.output.includes( 'Invalid regular expression' ) );
} );

test.serial( 'runCli rejects invalid js-template output enum', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsBuild.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			templatesJs: [
				{ filename: 'page.tpl', destination: 'out', output: 'umd' }
			]
		}
	] ) );

	const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );

	t.is( result.exitCode, 1 );
	t.true( result.output.includes( '[0].templatesJs[0].output' ) );
} );

test.serial( 'runCli rejects js-template missing required output', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsBuild.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			templatesJs: [
				{ filename: 'page.tpl', destination: 'out' }
			]
		}
	] ) );

	const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );

	t.is( result.exitCode, 1 );
	t.true( result.output.includes( '[0].templatesJs[0].output' ) );
} );

const strictSchemaCases: { name: string; config: Record<PropertyKey, unknown>; expectedLine: string; }[] = [
	{
		name: 'build item',
		config: { target: 'lib', tsConfig: 'tsconfig.json', unknownBuildField: true },
		expectedLine: '[0].unknownBuildField: Unrecognized key: "unknownBuildField"'
	},
	{
		name: 'build minify',
		config: { target: 'lib', tsConfig: 'tsconfig.json', minify: { files: [ 'dist/index.js' ], unknownMinifyField: true } },
		expectedLine: '[0].minify.unknownMinifyField: Unrecognized key: "unknownMinifyField"'
	},
	{
		name: 'html template',
		config: { target: 'lib', tsConfig: 'tsconfig.json', templatesHtml: [ { filename: 'a.tpl', destination: 'out', unknownTemplateField: true } ] },
		expectedLine: '[0].templatesHtml[0].unknownTemplateField: Unrecognized key: "unknownTemplateField"'
	},
	{
		name: 'variable',
		config: { target: 'lib', tsConfig: 'tsconfig.json', templatesHtml: [ { filename: 'a.tpl', destination: 'out', variables: [ { name: 'x', type: 'string', value: 'y', unknownVariableField: true } ] } ] },
		expectedLine: '[0].templatesHtml[0].variables[0].unknownVariableField: Unrecognized key: "unknownVariableField"'
	},
	{
		name: 'copy',
		config: { target: 'lib', tsConfig: 'tsconfig.json', copy: [ { destination: 'out', files: [ 'a.txt' ], unknownCopyField: true } ] },
		expectedLine: '[0].copy[0].unknownCopyField: Unrecognized key: "unknownCopyField"'
	}
];

let strictSchemaCase: { name: string; config: Record<PropertyKey, unknown>; expectedLine: string; };
for( strictSchemaCase of strictSchemaCases ) {
	test.serial( `runCli rejects unknown key in ${ strictSchemaCase.name } object`, async ( t: ExecutionContext ): Promise<void> => {
		const ws: string = await createWorkspace( 'minimal' );
		await writeFile( path.join( ws, 'tsBuild.json' ), JSON.stringify( [ strictSchemaCase.config ] ) );

		const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );
		const outputLines: string[] = result.output.split( '\n' );

		t.is( result.exitCode, 1 );
		t.true( outputLines.includes( strictSchemaCase.expectedLine ) );
	} );
}

test.serial( 'runCli rejects legacy templates key as unrecognized', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsBuild.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			templates: [ { filename: 'a.tpl', destination: 'out' } ]
		}
	] ) );

	const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );
	const outputLines: string[] = result.output.split( '\n' );

	t.is( result.exitCode, 1 );
	t.true( outputLines.includes( '[0].templates: Unrecognized key: "templates"' ) );
} );

test.serial( 'runCli rejects minify inside a templatesJs entry', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsBuild.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			templatesJs: [ { filename: 'a.tpl', destination: 'out', output: 'esm', minify: { terser: true } } ]
		}
	] ) );

	const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );
	const outputLines: string[] = result.output.split( '\n' );

	t.is( result.exitCode, 1 );
	t.true( outputLines.includes( '[0].templatesJs[0].minify: Unrecognized key: "minify"' ) );
} );

test.serial( 'runCli rejects variables inside a templatesJs entry', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsBuild.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			templatesJs: [ { filename: 'a.tpl', destination: 'out', output: 'esm', variables: [ { name: 'x', type: 'string', value: 'y' } ] } ]
		}
	] ) );

	const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );
	const outputLines: string[] = result.output.split( '\n' );

	t.is( result.exitCode, 1 );
	t.true( outputLines.includes( '[0].templatesJs[0].variables: Unrecognized key: "variables"' ) );
} );

test.serial( 'runCli rejects output inside an templatesHtml entry', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsBuild.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			templatesHtml: [ { filename: 'a.tpl', destination: 'out', output: 'esm' } ]
		}
	] ) );

	const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );
	const outputLines: string[] = result.output.split( '\n' );

	t.is( result.exitCode, 1 );
	t.true( outputLines.includes( '[0].templatesHtml[0].output: Unrecognized key: "output"' ) );
} );

test.serial( 'runCli rejects minify inside an templatesHtml entry', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsBuild.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			templatesHtml: [ { filename: 'a.tpl', destination: 'out', minify: { terser: true } } ]
		}
	] ) );

	const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );
	const outputLines: string[] = result.output.split( '\n' );

	t.is( result.exitCode, 1 );
	t.true( outputLines.includes( '[0].templatesHtml[0].minify: Unrecognized key: "minify"' ) );
} );

test.serial( 'runCli reports root config type mismatch as root diagnostic', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsBuild.json' ), JSON.stringify( { target: 'lib', tsConfig: 'tsconfig.json' } ) );

	const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );
	const outputLines: string[] = result.output.split( '\n' );

	t.is( result.exitCode, 1 );
	t.true( outputLines.includes( '(root): Invalid input: expected array, received object' ) );
} );

test.serial( 'runCli rejects configs with duplicate targets', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsBuild.json' ), JSON.stringify( [
		{ target: 'lib', tsConfig: 'tsconfig.json' },
		{ target: 'lib', tsConfig: 'tsconfig.json' },
		{ target: 'other', tsConfig: 'tsconfig.json' },
		{ target: 'lib', tsConfig: 'tsconfig.json' },
		{ target: 'other', tsConfig: 'tsconfig.json' }
	] ) );

	const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );
	const outputLines: string[] = result.output.split( '\n' );

	t.is( result.exitCode, 1 );
	t.true( outputLines.includes( '[1].target: Duplicate target "lib"' ) );
	t.true( outputLines.includes( '[3].target: Duplicate target "lib"' ) );
	t.true( outputLines.includes( '[4].target: Duplicate target "other"' ) );
} );

test.serial( 'runCli rejects malformed JSON config with validation prefix', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsBuild.json' ), '{ invalid json' );

	const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );
	const outputLines: string[] = result.output.split( '\n' );

	t.is( result.exitCode, 1 );
	t.true( outputLines.some( ( line: string ): boolean => line.includes( 'Invalid tsBuild configuration:' ) ) );
} );

test.serial( 'runCli reports every invalid terser object field path', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsBuild.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			minify: {
				files: [ 'dist/index.js' ],
				terser: { mangle: 42, unknownOne: true, unknownTwo: true }
			}
		}
	] ) );

	const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );
	const outputLines: string[] = result.output.split( '\n' );

	t.is( result.exitCode, 1 );
	t.true( outputLines.includes( '[0].minify.terser.mangle: Invalid input: expected false' ) );
	t.true( outputLines.includes( '[0].minify.terser.mangle: Invalid input: expected string, received number' ) );
	t.true( outputLines.includes( '[0].minify.terser.unknownOne: Unrecognized key: "unknownOne"' ) );
	t.true( outputLines.includes( '[0].minify.terser.unknownTwo: Unrecognized key: "unknownTwo"' ) );
} );

test.serial( 'object-form terser config minifies with mangle false preserving underscore properties', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	await writeFile( path.join( ws, 'src/index.ts' ), [
		'const widget = {',
		'	_private: 42,',
		'	render() { return this._private; }',
		'};',
		'console.log( widget.render() );',
	].join( '\n' ) );
	await writeFile( path.join( ws, 'object.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			minify: {
				files: [ 'dist/index.js' ],
				terser: { enabled: true, module: false, toplevel: false, mangle: false },
				terserCompanion: false
			}
		}
	] ) );

	await buildItem( ws, 'object.json', 'lib' );

	const minPath: string = path.join( ws, 'dist/index.min.js' );
	t.true( await exists( minPath ) );
	const minContent: string = await readFile( minPath, 'utf8' );
	t.true( minContent.includes( '_private' ) );
} );

test.serial( 'object-form terser config with enabled false and companion false writes no .min sibling', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	await writeFile( path.join( ws, 'object-disabled.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			minify: {
				files: [ 'dist/index.js' ],
				terser: { enabled: false },
				terserCompanion: false
			}
		}
	] ) );

	await buildItem( ws, 'object-disabled.json', 'lib' );

	t.true( await exists( path.join( ws, 'dist/index.js' ) ) );
	t.false( await exists( path.join( ws, 'dist/index.min.js' ) ) );
} );

test.serial( 'object-form terser config: toplevel false (the CJS default) retains unused helper, configured mangle regex renames customPrivate', async ( t: ExecutionContext ): Promise<void> => {
	const source: string = [
		'function unusedHelper() { return 42; }',
		'const widget = {',
		'	customPrivate: 1,',
		'	render() { return this.customPrivate; }',
		'};',
		'console.log( widget.render() );',
	].join( '\n' );

	// module:false + toplevel:false retains the unused helper; mangle:"^custom" renames customPrivate
	const wsRetain: string = await createWorkspace( 'minify' );
	await mkdir( path.join( wsRetain, 'dist' ), { recursive: true } );
	await writeFile( path.join( wsRetain, 'dist/script.js' ), source );
	await writeFile( path.join( wsRetain, 'retain.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			minify: {
				files: [ 'dist/script.js' ],
				terser: { module: false, toplevel: false, mangle: '^custom' },
				terserCompanion: false
			}
		}
	] ) );
	await buildItem( wsRetain, 'retain.json', 'lib' );

	const retained: string = await readFile( path.join( wsRetain, 'dist/script.min.js' ), 'utf8' );
	t.true( retained.includes( 'unusedHelper' ) );
	t.false( retained.includes( 'customPrivate' ) );

	// module:false + explicit toplevel:true drops the unused helper; mangle:false keeps customPrivate
	const wsDrop: string = await createWorkspace( 'minify' );
	await mkdir( path.join( wsDrop, 'dist' ), { recursive: true } );
	await writeFile( path.join( wsDrop, 'dist/script.js' ), source );
	await writeFile( path.join( wsDrop, 'drop.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			minify: {
				files: [ 'dist/script.js' ],
				terser: { module: false, toplevel: true, mangle: false },
				terserCompanion: false
			}
		}
	] ) );
	await buildItem( wsDrop, 'drop.json', 'lib' );

	const dropped: string = await readFile( path.join( wsDrop, 'dist/script.min.js' ), 'utf8' );
	t.false( dropped.includes( 'unusedHelper' ) );
	t.true( dropped.includes( 'customPrivate' ) );
} );

test.serial( 'minify toplevel true drops unused top-level declarations retained by toplevel false', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minify' );
	const sourcePath: string = path.join( ws, 'dist/toplevel.js' );
	const minPath: string = path.join( ws, 'dist/toplevel.min.js' );
	const source: string = [
		'function unusedHelper() { return 42; }',
		'function used() { return 1; }',
		'console.log( used() );',
	].join( '\n' );
	await mkdir( path.dirname( sourcePath ), { recursive: true } );
	await writeFile( sourcePath, source );

	const retainedResult: boolean = await TsBuild.minify( 'dist/toplevel.js', sourcePath, true, false, { module: false, toplevel: false } );

	t.true( retainedResult );
	const retained: string = await readFile( minPath, 'utf8' );
	t.true( retained.includes( 'unusedHelper' ) );

	const droppedResult: boolean = await TsBuild.minify( 'dist/toplevel.min.js', sourcePath, true, false, { module: false, toplevel: true } );

	t.true( droppedResult );
	const dropped: string = await readFile( minPath, 'utf8' );
	t.false( dropped.includes( 'unusedHelper' ) );
} );

test.serial( 'esm js-template writes .mjs and renders from runtime data', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'template-output' );
	await buildItem( ws, 'esm.json', 'lib' );

	const pagePath: string = path.join( ws, 'out/page.mjs' );
	t.true( await exists( pagePath ) );
	t.false( await exists( path.join( ws, 'out/page.html' ) ) );
	t.false( await exists( path.join( ws, 'out/page.min.mjs' ) ) );

	const mod: { default: ( data: Record<string, string | number> ) => string } = await import( pathToFileURL( pagePath ).href );
	const html: string = mod.default( { title: 'ESM title', stamp: 42 } );
	t.true( html.includes( 'ESM title' ) );
	t.true( html.includes( '42' ) );
} );

test.serial( 'cjs js-template writes .cjs and renders from runtime data', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'template-output' );
	await buildItem( ws, 'cjs.json', 'lib' );

	const pagePath: string = path.join( ws, 'out/page.cjs' );
	t.true( await exists( pagePath ) );
	t.false( await exists( path.join( ws, 'out/page.min.cjs' ) ) );

	const require: NodeRequire = createRequire( import.meta.url );
	const renderer: ( data: Record<string, string | number> ) => string = require( pagePath );
	const html: string = renderer( { title: 'CJS title', stamp: 7 } );
	t.true( html.includes( 'CJS title' ) );
	t.true( html.includes( '7' ) );
} );

test.serial( 'templatesJs generate modules before global minify', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'template-output' );
	await buildItem( ws, 'minify.json', 'lib' );

	const pagePath: string = path.join( ws, 'out/page.mjs' );
	const minPath: string = path.join( ws, 'out/page.min.mjs' );
	t.true( await exists( pagePath ) );
	t.true( await exists( minPath ) );

	const mod: { default: ( data: Record<string, string | number> ) => string } = await import( pathToFileURL( minPath ).href );
	const html: string = mod.default( { title: 'minified', stamp: 1 } );
	t.true( html.includes( 'minified' ) );
} );

test.serial( 'extensionless esm js-template writes name.mjs', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'template-output' );
	await buildItem( ws, 'extensionless.json', 'lib' );

	const pagePath: string = path.join( ws, 'out/plain.mjs' );
	t.true( await exists( pagePath ) );

	const mod: { default: ( data: Record<string, string | number> ) => string } = await import( pathToFileURL( pagePath ).href );
	t.true( mod.default( { title: 'plain', stamp: 1 } ).includes( 'plain' ) );
} );

test.serial( 'html template without variables renders basename with empty data', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'template-output' );
	await buildItem( ws, 'html.json', 'lib' );

	const pagePath: string = path.join( ws, 'out/page.html' );
	t.true( await exists( pagePath ) );
	t.false( await exists( path.join( ws, 'out/page.min.html' ) ) );

	const html: string = await readFile( pagePath, 'utf8' );
	t.true( html.includes( '<h1></h1>' ) );
} );

test.serial( 'direct hash variables render unpadded base64url digests of source raw bytes', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	await buildItem( ws, 'tsBuild.json', 'lib' );

	t.is( await renderedValue( ws, 'out/page.html', 'hash_sha2' ), abcSha224 );
	t.is( await renderedValue( ws, 'out/page.html', 'hash_sha3' ), abcSha3_224 );
	t.is( await renderedValue( ws, 'out/page.html', 'hash_blake2s' ), abcBlake2s256 );
	t.is( await renderedValue( ws, 'out/page.html', 'hash_shake64' ), abcShake256_64 );
	t.is( await renderedValue( ws, 'out/page.html', 'hash_shake96' ), abcShake256_96 );
	t.is( await renderedValue( ws, 'out/page.html', 'hash_md5' ), abcMd5_128 );

	t.is( abcShake256_64.length, 11 );
	t.is( abcShake256_96.length, 16 );
	t.is( abcMd5_128.length, 22 );

	const base64urlAlphabet: RegExp = /^[A-Za-z0-9_-]+$/;
	t.true( base64urlAlphabet.test( abcShake256_64 ) );
	t.true( base64urlAlphabet.test( abcShake256_96 ) );
	t.true( base64urlAlphabet.test( abcMd5_128 ) );
} );

test.serial( 'direct hash variable digests raw bytes of a binary source', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	await buildItem( ws, 'tsBuild.json', 'lib' );

	const binaryBuffer: Buffer = await readFile( path.join( ws, 'project/assets/binary.bin' ) );
	const expectedDigest: string = createHash( 'sha224' ).update( binaryBuffer ).digest( 'base64url' );
	t.is( await renderedValue( ws, 'out/page.html', 'hash_binary' ), expectedDigest );
} );

test.serial( 'string-form mtime renders the whole-millisecond mtime', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	await buildItem( ws, 'tsBuild.json', 'lib' );

	const abcStat: Stats = await stat( path.join( ws, 'project/assets/abc' ) );
	t.is( await renderedValue( ws, 'out/page.html', 'mtime_string' ), String( abcStat.mtime.getTime() ) );
} );

test.serial( 'tuple-form mtime renders prefix/basename?mtime', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	await buildItem( ws, 'tsBuild.json', 'lib' );

	const abcStat: Stats = await stat( path.join( ws, 'project/assets/abc' ) );
	const mtimeB64: string = Buffer.from( BigInt( abcStat.mtime.getTime() ).toString( 16 ).padStart( 16, '0' ), 'hex' ).toString( 'base64url' );
	t.is( await renderedValue( ws, 'out/page.html', 'mtime_tuple' ), `this/is/a/prefix/abc?${ mtimeB64 }` );
} );

test.serial( 'tuple-form mtime with an empty prefix renders basename?mtime', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	await buildItem( ws, 'tsBuild.json', 'lib' );

	const abcStat: Stats = await stat( path.join( ws, 'project/assets/abc' ) );
	const mtimeB64: string = Buffer.from( BigInt( abcStat.mtime.getTime() ).toString( 16 ).padStart( 16, '0' ), 'hex' ).toString( 'base64url' );
	t.is( await renderedValue( ws, 'out/page.html', 'mtime_tuple_empty' ), `abc?${ mtimeB64 }` );
} );

test.serial( 'tuple-form hash renders prefix/basename?digest', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	await buildItem( ws, 'tsBuild.json', 'lib' );

	t.is( await renderedValue( ws, 'out/page.html', 'hash_tuple_sha3' ), `this/is/a/prefix/abc?${ abcSha3_224 }` );
} );

test.serial( 'tuple-form hash with an empty prefix renders basename?digest', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	await buildItem( ws, 'tsBuild.json', 'lib' );

	t.is( await renderedValue( ws, 'out/page.html', 'hash_tuple_empty' ), `abc?${ abcSha224 }` );
} );

test.serial( 'tuple output is based on the target-relative source, not the output prefix path', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	await buildItem( ws, 'tsBuild.json', 'lib' );

	const binaryBuffer: Buffer = await readFile( path.join( ws, 'project/assets/binary.bin' ) );
	const expectedDigest: string = createHash( 'sha224' ).update( binaryBuffer ).digest( 'base64url' );
	t.is( await renderedValue( ws, 'out/page.html', 'hash_tuple_binary' ), `this/is/a/prefix/binary.bin?${ expectedDigest }` );
} );

test.serial( 'tuple output prefix preserves a leading slash and strips trailing slashes', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	await buildItem( ws, 'leading.json', 'lib' );
	await buildItem( ws, 'trailing.json', 'lib' );

	t.is( await renderedValue( ws, 'out/leading/token.html', 'token' ), `/assets/abc?${ abcBlake2s256 }` );
	t.is( await renderedValue( ws, 'out/trailing/token.html', 'token' ), `this/is/a/prefix/abc?${ abcSha224 }` );
} );

test.serial( 'tuple output prefix converts backslashes to forward slashes', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	await buildItem( ws, 'backslash.json', 'lib' );

	t.is( await renderedValue( ws, 'out/backslash/token.html', 'token' ), `this/is/a/prefix/abc?${ abcSha224 }` );
} );

test.serial( 'tuple-form sha2 hash renders prefix/basename?digest', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	await buildItem( ws, 'tsBuild.json', 'lib' );

	t.is( await renderedValue( ws, 'out/page.html', 'hash_tuple_sha2' ), `this/is/a/prefix/abc?${ abcSha224 }` );
} );

test.serial( 'tuple-form blake2s hash renders prefix/basename?digest', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	await buildItem( ws, 'tsBuild.json', 'lib' );

	t.is( await renderedValue( ws, 'out/page.html', 'hash_tuple_blake2s' ), `this/is/a/prefix/abc?${ abcBlake2s256 }` );
} );

test.serial( 'tuple-form shake256-64 hash renders prefix/basename?digest', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	await buildItem( ws, 'tsBuild.json', 'lib' );

	t.is( await renderedValue( ws, 'out/page.html', 'hash_tuple_shake64' ), `this/is/a/prefix/abc?${ abcShake256_64 }` );
} );

test.serial( 'tuple-form shake256-96 hash renders prefix/basename?digest', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	await buildItem( ws, 'tsBuild.json', 'lib' );

	t.is( await renderedValue( ws, 'out/page.html', 'hash_tuple_shake96' ), `this/is/a/prefix/abc?${ abcShake256_96 }` );
} );

test.serial( 'tuple-form md5 hash renders prefix/basename?digest', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	await buildItem( ws, 'tsBuild.json', 'lib' );

	t.is( await renderedValue( ws, 'out/page.html', 'hash_tuple_md5' ), `this/is/a/prefix/abc?${ abcMd5_128 }` );
} );

test.serial( 'tuple output prefix keeps internal repeated slashes unchanged', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	await buildItem( ws, 'repeated.json', 'lib' );

	t.is( await renderedValue( ws, 'out/repeated/token.html', 'token' ), `assets//current/abc?${ abcSha224 }` );
} );

test.serial( 'tuple output root prefix renders /basename?TOKEN', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	await buildItem( ws, 'root.json', 'lib' );

	t.is( await renderedValue( ws, 'out/root/token.html', 'token' ), `/abc?${ abcSha224 }` );
} );

test.serial( 'runCli builds the hash-variables target via the public CLI path', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	const exitCode: number = await TsBuild.runCli( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );

	t.is( exitCode, 0 );
	t.true( await exists( path.join( ws, 'out/page.html' ) ) );
} );

test.serial( 'hash variable with missing source propagates the fs ENOENT error', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	const error: NodeJS.ErrnoException = await t.throwsAsync(
		async (): Promise<void> => buildItem( ws, 'missing.json', 'lib' )
	);
	t.is( error.code, 'ENOENT' );
} );

test.serial( 'hash variable reports an unavailable mapped algorithm', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'hash-variables' );
	const hashAlgorithmMap: Record<string, [ string, number? ]> = ( TsBuild as unknown as { _hashAlgorithmMap: Record<string, [ string, number? ]> } )._hashAlgorithmMap;
	const originalAlgorithm: [ string, number? ] = hashAlgorithmMap[ 'hash-sha2-224' ];
	hashAlgorithmMap[ 'hash-sha2-224' ] = [ 'unavailable-test-hash' ];
	try {
		const error: Error = await t.throwsAsync(
			async (): Promise<void> => buildItem( ws, 'tsBuild.json', 'lib' )
		);
		t.is( error.message, 'Hash algorithm "unavailable-test-hash" is unavailable for variable type "hash-sha2-224"' );
	} finally {
		hashAlgorithmMap[ 'hash-sha2-224' ] = originalAlgorithm;
	}
} );

test.serial( 'runCli rejects an unsupported variable type at build time', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsBuild.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			templatesHtml: [ { filename: 'a.tpl', destination: 'out', variables: [ { name: 'x', type: 'bogus', value: 'y' } ] } ]
		}
	] ) );

	const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );

	t.is( result.exitCode, 1 );
	t.true( result.output.includes( 'Unsupported variable type "bogus"' ) );
} );

test.serial( 'runCli rejects a tuple value for a string variable at build time', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsBuild.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			templatesHtml: [ { filename: 'a.tpl', destination: 'out', variables: [ { name: 'x', type: 'string', value: [ 'a', 'b' ] } ] } ]
		}
	] ) );

	const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );

	t.is( result.exitCode, 1 );
	t.true( result.output.includes( 'Unexpected value for variable type "string"' ) );
} );

test.serial( 'runCli rejects one- and three-element tuples under mtime', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsBuild.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			templatesHtml: [ { filename: 'a.tpl', destination: 'out', variables: [
				{ name: 'x', type: 'mtime', value: [ 'a' ] },
				{ name: 'y', type: 'mtime', value: [ 'a', 'b', 'c' ] }
			] } ]
		}
	] ) );

	const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );
	const outputLines: string[] = result.output.split( '\n' );

	t.is( result.exitCode, 1 );
	t.true( outputLines.some( ( line: string ): boolean => line.includes( 'variables[0].value' ) ) );
	t.true( outputLines.some( ( line: string ): boolean => line.includes( 'variables[1].value' ) ) );
} );

test.serial( 'runCli rejects a non-string member in a tuple', async ( t: ExecutionContext ): Promise<void> => {
	const ws: string = await createWorkspace( 'minimal' );
	await writeFile( path.join( ws, 'tsBuild.json' ), JSON.stringify( [
		{
			target: 'lib',
			tsConfig: 'tsconfig.json',
			templatesHtml: [ { filename: 'a.tpl', destination: 'out', variables: [ { name: 'x', type: 'mtime', value: [ 'a', 5 ] } ] } ]
		}
	] ) );

	const result: { exitCode: number; output: string } = await runCliWithCapturedLog( [ '-f', path.join( ws, 'tsBuild.json' ), 'lib' ] );
	const outputLines: string[] = result.output.split( '\n' );

	t.is( result.exitCode, 1 );
	t.true( outputLines.some( ( line: string ): boolean => line.includes( 'variables[0].value[1]' ) ) );
} );
