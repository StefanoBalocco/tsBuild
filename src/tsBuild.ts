#!/usr/bin/env node

import jTDAL from '@stefanobalocco/jtdal';
import terserCompanion from '@stefanobalocco/tersercompanion';
import { LogLevel, ZeptoLogger } from '@stefanobalocco/zeptologger';
import type { Hash } from 'node:crypto';
import { createHash, getHashes } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MinifyOutput } from 'terser';
import { minify } from 'terser';
import ts from 'typescript';
import { z } from 'zod';

type Undefinedable<T> = T | undefined;

export type TerserOptions = {
	module?: boolean;
	toplevel?: boolean;
	mangle?: false | string;
};

const defaultManglePattern: string = '^_';

const defaultTerserOptions: Required<Omit<TerserOptions, 'toplevel'>> = {
	module: true,
	mangle: defaultManglePattern
};

export const tsBuildItemSchema: z.ZodType<{
	target: string;
	tsConfig: string;
	name?: string;
	prefix?: string;
	minify?: {
		files: string[];
		terser?: {
			enabled?: boolean;
			module?: boolean;
			toplevel?: boolean;
			mangle?: false | string;
		} | boolean;
		terserCompanion?: boolean;
	};
	copy?: {
		destination: string;
		files: string[];
		clean?: boolean;
	}[];
	templatesHtml?: {
		filename: string;
		destination: string;
		variables?: {
			name: string;
			type: string;
			value: string | [ string, string ];
		}[];
	}[];
	templatesJs?: {
		filename: string;
		destination: string;
		output: 'esm' | 'cjs';
	}[];
}> = z.object( {
	target: z.string(),
	tsConfig: z.string(),
	name: z.string().optional(),
	prefix: z.string().optional(),
	minify: z.object( {
		files: z.array( z.string() ),
		terser: z.union( [
			z.boolean(),
			z.object( {
				enabled: z.boolean().optional(),
				module: z.boolean().optional(),
				toplevel: z.boolean().optional(),
				mangle: z.union( [
					z.literal( false ),
					z.string().refine( ( value: string ): boolean => {
						let returnValue: boolean = true;
						try {
							RegExp( value );
						} catch {
							returnValue = false;
						}
						return returnValue;
					}, { message: 'Invalid regular expression' } )
				] ).optional()
			} ).strict()
		] ).optional(),
		terserCompanion: z.boolean().optional()
	} ).strict().optional(),
	copy: z.array(
		z.object( {
			destination: z.string(),
			files: z.array( z.string() ),
			clean: z.boolean().optional()
		} ).strict()
	).optional(),
	templatesHtml: z.array(
		z.object( {
			filename: z.string(),
			destination: z.string(),
			variables: z.array(
				z.object( {
					name: z.string(),
					type: z.string(),
					value: z.union( [ z.string(), z.tuple( [ z.string(), z.string() ] ) ] )
				} ).strict()
			).optional()
		} ).strict()
	).optional(),
	templatesJs: z.array(
		z.object( {
			filename: z.string(),
			destination: z.string(),
			output: z.enum( [ 'esm', 'cjs' ] )
		} ).strict()
	).optional()
} ).strict();

export type TsBuildItem = z.infer<typeof tsBuildItemSchema>;

const tsBuildConfigSchema: z.ZodType<TsBuildItem[]> = z.array( tsBuildItemSchema ).superRefine( ( items: TsBuildItem[], ctx: z.RefinementCtx ): void => {
	const seenTargets: Set<string> = new Set<string>();
	const cL1: number = items.length;
	for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
		const target: string = items[ iL1 ].target;
		if( seenTargets.has( target ) ) {
			ctx.addIssue( {
				code: 'custom',
				path: [ iL1, 'target' ],
				message: `Duplicate target "${ target }"`
			} );
		} else {
			seenTargets.add( target );
		}
	}
} );

export default class TsBuild {
	private readonly _configDirectory: string;

	public constructor( configDirectory: string ) {
		this._configDirectory = configDirectory;
	}

	private static readonly _hashAlgorithmMap: Record<string, [ string, number? ]> = {
		'hash-sha2-224': [ 'sha224' ],
		'hash-sha3-224': [ 'sha3-224' ],
		'hash-blake2s-256': [ 'blake2s256' ],
		'hash-shake256-64': [ 'shake256', 8 ],
		'hash-shake256-96': [ 'shake256', 12 ],
		'hash-md5-128': [ 'md5' ]
	};

	public static compile( configPath: string ): void {
		const absConfig: string = path.resolve( configPath );
		const configFile: ReturnType<typeof ts.readConfigFile> = ts.readConfigFile( absConfig, ts.sys.readFile );

		if( configFile.error ) {
			throw new Error( ts.formatDiagnosticsWithColorAndContext( [ configFile.error ], {
				getCurrentDirectory: ts.sys.getCurrentDirectory,
				getCanonicalFileName: ( fileName: string ): string => fileName,
				getNewLine: (): string => '\n'
			} ) );
		}

		const parsed: ts.ParsedCommandLine = ts.parseJsonConfigFileContent(
			configFile.config,
			ts.sys,
			path.dirname( absConfig )
		);

		const program: ts.Program = ts.createProgram( parsed.fileNames, parsed.options );
		const emitResult: ts.EmitResult = program.emit();
		const diagnostics: readonly ts.Diagnostic[] = [
			...parsed.errors,
			...ts.getPreEmitDiagnostics( program ),
			...emitResult.diagnostics
		];

		if( 0 < diagnostics.length ) {
			throw new Error( ts.formatDiagnosticsWithColorAndContext( diagnostics, {
				getCurrentDirectory: ts.sys.getCurrentDirectory,
				getCanonicalFileName: ( fileName: string ): string => fileName,
				getNewLine: (): string => '\n'
			} ) );
		}
	}

	public static async minify(
		absPath: string,
		useTerser: boolean,
		useTerserCompanion: boolean,
		terserOptions: TerserOptions = defaultTerserOptions
	): Promise<boolean> {
		let returnValue: boolean = false;
		if( useTerser || useTerserCompanion ) {
			const source: string = await readFile( absPath, 'utf8' );
			const parsedPath: path.ParsedPath = path.parse( absPath );
			const outPath: string = path.join( parsedPath.dir, `${ parsedPath.name }.min${ parsedPath.ext }` );
			const compressed: [ string, number ] = [ source, Buffer.byteLength( source, 'utf8' ) ];
			ZeptoLogger.instance.log( LogLevel.INFO, `[MINIFY] Size> Original       : ${ compressed[ 1 ] }` );

			if( useTerser ) {
				const tmpValue: MinifyOutput = await minify( source, {
					module: terserOptions.module ?? defaultTerserOptions.module,
					toplevel: terserOptions.toplevel ?? false,
					compress: { defaults: true, passes: 2 },
					mangle: ( false === terserOptions.mangle )
						? false
						: { properties: { regex: RegExp( ( 'string' === typeof terserOptions.mangle ) ? terserOptions.mangle : defaultManglePattern ) } }
				} );
				if( undefined !== tmpValue.code ) {
					const tmpLength: number = Buffer.byteLength( tmpValue.code, 'utf8' );
					ZeptoLogger.instance.log( LogLevel.INFO, `[MINIFY] Size> Terser         : ${ tmpLength }` );
					if( tmpLength < compressed[ 1 ] ) {
						compressed[ 0 ] = tmpValue.code;
						compressed[ 1 ] = tmpLength;
					}
				}
			}

			if( useTerserCompanion ) {
				const tmpValue: string = terserCompanion( compressed[ 0 ] );
				const tmpLength: number = Buffer.byteLength( tmpValue, 'utf8' );
				ZeptoLogger.instance.log( LogLevel.INFO, `[MINIFY] Size> TerserCompanion: ${ tmpLength }` );
				if( tmpLength < compressed[ 1 ] ) {
					compressed[ 0 ] = tmpValue;
					compressed[ 1 ] = tmpLength;
				}
			}

			ZeptoLogger.instance.log( LogLevel.INFO, `[MINIFY] Size> Output         : ${ compressed[ 1 ] }` );

			await writeFile( outPath, compressed[ 0 ] );
			returnValue = true;
		}
		return returnValue;
	}

	private static _formatIssueLines( issue: z.ZodIssue, parentPath: readonly PropertyKey[] ): string[] {
		const returnValue: string[] = [];
		const issuePath: readonly ( string | number )[] = [ ...parentPath, ...issue.path ] as readonly ( string | number )[];
		if( ( 'invalid_union' === issue.code ) && ( 0 < issue.errors.length ) ) {
			const branchSpecific: boolean[] = issue.errors.map( ( branchErrors: z.ZodIssue[] ): boolean => branchErrors.some( ( branchIssue: z.ZodIssue ): boolean => ( 'unrecognized_keys' === branchIssue.code ) || ( 0 < branchIssue.path.length ) ) );
			const hasSpecificBranch: boolean = branchSpecific.includes( true );
			const cL1: number = issue.errors.length;
			for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
				if( !hasSpecificBranch || branchSpecific[ iL1 ] ) {
					const cL2: number = issue.errors[ iL1 ].length;
					for( let iL2: number = 0; iL2 < cL2; iL2++ ) {
						returnValue.push( ...TsBuild._formatIssueLines( issue.errors[ iL1 ][ iL2 ], issuePath ) );
					}
				}
			}
		} else {
			let formattedPath: string = '';
			const cL1: number = issuePath.length;
			for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
				const segment: PropertyKey = issuePath[ iL1 ];
				if( 'number' === typeof segment ) {
					formattedPath += `[${ segment }]`;
				} else {
					formattedPath += `.${ segment }`;
				}
			}
			if( 'unrecognized_keys' === issue.code ) {
				const cL2: number = issue.keys.length;
				for( let iL2: number = 0; iL2 < cL2; iL2++ ) {
					const key: string = issue.keys[ iL2 ];
					const keyPath: string = `${ formattedPath }.${ key }`;
					returnValue.push( `${ keyPath }: Unrecognized key: ${ JSON.stringify( key ) }` );
				}
			} else {
				const leafLabel: string = formattedPath ? formattedPath : '(root)';
				returnValue.push( `${ leafLabel }: ${ issue.message }` );
			}
		}
		return returnValue;
	}

	private static _formatTupleToken( source: string, prefix: string, token: string | number ): string {
		let returnValue: string = '';
		const converted: string = prefix.replace( /\\/g, '/' );
		const stripped: string = converted.replace( /\/+$/, '' );
		const normalizedPrefix: string = ( '' === stripped ) ? ( ( converted.startsWith( '/' ) ) ? '/' : '' ) : stripped;
		const basename: string = path.basename( source );
		if( '' === normalizedPrefix ) {
			returnValue = `${ basename }?${ token }`;
		} else if( '/' === normalizedPrefix ) {
			returnValue = `/${ basename }?${ token }`;
		} else {
			returnValue = `${ normalizedPrefix }/${ basename }?${ token }`;
		}
		return returnValue;
	}

	public static async copy( absDestination: string, absFiles: string[], clean: boolean ): Promise<void> {
		if( clean ) {
			await rm( absDestination, { recursive: true, force: true } );
		}
		await mkdir( absDestination, { recursive: true } );
		for( const absFile of absFiles ) {
			await copyFile( absFile, path.resolve( absDestination, path.basename( absFile ) ) );
		}
	}

	public static async templating(
		absTemplate: string,
		absDestination: string,
		variables: Record<string, string | number>
	): Promise<void> {
		const templateSource: string = await readFile( absTemplate, 'utf8' );
		const output: string = new jTDAL().CompileToFunction( templateSource )( variables );
		await mkdir( absDestination, { recursive: true } );
		await writeFile( path.resolve( absDestination, path.basename( absTemplate ) ), output, 'utf8' );
	}

	public async build( buildItem: TsBuildItem ): Promise<void> {
		const targetLabel: string = ( buildItem.name ?? buildItem.target ).toUpperCase();
		const targetDirectory: string = path.resolve( this._configDirectory, buildItem.prefix ?? '' );
		const absConfig: string = path.resolve( targetDirectory, buildItem.tsConfig );
		let minifyPlan: Undefinedable<{ enabled: boolean; options: TerserOptions; useTerserCompanion: boolean; files: string[]; }>;
		if( buildItem.minify ) {
			const terserResolved: { enabled: boolean; options: TerserOptions } = {
				enabled: true,
				options: {
					module: true
				}
			};
			if( 'boolean' == typeof buildItem.minify.terser ) {
				terserResolved.enabled = buildItem.minify.terser;
			} else if( buildItem.minify.terser ) {
				terserResolved.enabled = buildItem.minify.terser.enabled ?? true;
				if( undefined !== buildItem.minify.terser.module ) {
					terserResolved.options.module = buildItem.minify.terser.module;
				}
				if( undefined !== buildItem.minify.terser.toplevel ) {
					terserResolved.options.toplevel = buildItem.minify.terser.toplevel;
				}
				if( undefined !== buildItem.minify.terser.mangle ) {
					terserResolved.options.mangle = buildItem.minify.terser.mangle;
				}
			}
			minifyPlan = {
				enabled: terserResolved.enabled,
				options: terserResolved.options,
				useTerserCompanion: buildItem.minify.terserCompanion ?? true,
				files: buildItem.minify.files
			};
		}

		ZeptoLogger.instance.log( LogLevel.INFO, `[${ targetLabel }] Compiling TypeScript...` );
		TsBuild.compile( absConfig );

		if( buildItem.templatesJs ) {
			for( const { filename, destination, output } of buildItem.templatesJs ) {
				const absTemplate: string = path.resolve( targetDirectory, filename );
				const absDestination: string = path.resolve( this._configDirectory, destination );
				const templateSource: string = await readFile( absTemplate, 'utf8' );
				const compiled: string = new jTDAL().CompileToString( templateSource );
				const moduleSource: string = ( 'esm' === output ) ? `export default ${ compiled }` : `module.exports = ${ compiled };`;
				const parsedPath: path.ParsedPath = path.parse( absTemplate );
				const outputName: string = ( 'esm' === output ) ? `${ parsedPath.name }.mjs` : `${ parsedPath.name }.cjs`;
				await mkdir( absDestination, { recursive: true } );
				await writeFile( path.resolve( absDestination, outputName ), moduleSource, 'utf8' );
			}
		}

		if( minifyPlan && ( minifyPlan.enabled || minifyPlan.useTerserCompanion ) ) {
			for( const file of minifyPlan.files ) {
				const absFile: string = path.resolve( targetDirectory, file );
				ZeptoLogger.instance.log( LogLevel.INFO, `[${ targetLabel }] Minifying ${ path.relative( this._configDirectory, absFile ) }...` );
				await TsBuild.minify( absFile, minifyPlan.enabled, minifyPlan.useTerserCompanion, minifyPlan.options );
			}
		}

		if( buildItem.copy ) {
			for( const { destination, files, clean } of buildItem.copy ) {
				const absDestination: string = path.resolve( this._configDirectory, destination );
				const absFiles: string[] = [];
				for( const file of files ) {
					absFiles.push( path.resolve( targetDirectory, file ) );
				}
				await TsBuild.copy( absDestination, absFiles, clean ?? false );
			}
		}

		if( buildItem.templatesHtml ) {
			for( const { filename, destination, variables } of buildItem.templatesHtml ) {
				const absTemplate: string = path.resolve( targetDirectory, filename );
				const absDestination: string = path.resolve( this._configDirectory, destination );
				const variablesResolved: Record<string, string | number> = {};
				if( variables ) {
					for( const { name, type, value } of variables ) {
						switch( type ) {
							case 'string': {
								if( 'string' == typeof value ) {
									variablesResolved[ name ] = value;
								} else {
									throw new Error( `Unexpected value for variable type "${ type }"` );
								}
								break;
							}
							case 'mtime': {
								const source: string = ( ( 'string' == typeof value ) ? value : value[ 0 ] );
								const mtime: number = ( await stat( path.resolve( targetDirectory, source ) ) ).mtime.getTime();
								const mtimeB64 : string = Buffer.from( BigInt( mtime ).toString( 16 ).padStart( 16, '0' ), 'hex' ).toString( 'base64url' );
								variablesResolved[ name ] = ( 'string' == typeof value ) ? mtime : TsBuild._formatTupleToken( source, value[ 1 ], mtimeB64 );
								break;
							}
							case 'hash-sha2-224':
							case 'hash-sha3-224':
							case 'hash-blake2s-256':
							case 'hash-shake256-64':
							case 'hash-shake256-96':
							case 'hash-md5-128': {
								const [ algorithm, outputLength ] : [ string, number? ] = TsBuild._hashAlgorithmMap[ type ];
								if( getHashes().includes( algorithm ) ) {
									const source: string = path.resolve( targetDirectory, ( ( 'string' == typeof value ) ? value : value[ 0 ] ) );
									const contents: Buffer = await readFile( source );
									const hash: Hash = createHash(
										algorithm,
										(
											( 'undefined' != typeof outputLength ) ? { outputLength: outputLength } : undefined
										)
									);
									const digest: string = hash.update( contents ).digest( 'base64url' );
									variablesResolved[ name ] = ( 'string' == typeof value ) ? digest : TsBuild._formatTupleToken( source, value[ 1 ], digest );
								} else {
									throw new Error( `Hash algorithm "${ algorithm }" is unavailable for variable type "${ type }"` );
								}
								break;
							}
							default: {
								throw new Error( `Unsupported variable type "${ type }"` );
							}
						}
					}
				}
				await TsBuild.templating( absTemplate, absDestination, variablesResolved );
			}
		}

		ZeptoLogger.instance.log( LogLevel.INFO, `[${ targetLabel }] ✓ Built.` );
	}

	public static async runCli( argumentsInput: string[] ): Promise<number> {
		let exitCode: number = 1;
		let configFile: string = './tsBuild.json';
		let targetsArgs: Set<string> = new Set( argumentsInput );

		if( ( 2 <= argumentsInput.length ) && ( '-f' === argumentsInput[ 0 ] ) ) {
			configFile = argumentsInput[ 1 ];
			targetsArgs = new Set( argumentsInput.slice( 2 ) );
		}

		try {
			const resolvedConfigFile: string = path.resolve( process.cwd(), configFile );
			const content: string = await readFile( resolvedConfigFile, 'utf8' );

			let parsedConfig: unknown;
			try {
				parsedConfig = JSON.parse( content );
			} catch( error: unknown ) {
				throw new Error( `Invalid tsBuild configuration: ${ ( error as Error ).message }` );
			}
			const validation: ReturnType<typeof tsBuildConfigSchema.safeParse> = tsBuildConfigSchema.safeParse( parsedConfig );
			if( !validation.success ) {
				const issueLines: string[] = [];
				const cL1: number = validation.error.issues.length;
				for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
					issueLines.push( ...TsBuild._formatIssueLines( validation.error.issues[ iL1 ], [] ) );
				}
				throw new Error( `Invalid tsBuild configuration:\n${ issueLines.join( '\n' ) }` );
			}
			const buildItems: TsBuildItem[] = validation.data;

			const builder: TsBuild = new TsBuild( path.dirname( resolvedConfigFile ) );

			const targetsValid: Set<string> = new Set<string>(
				buildItems.map(
					( item: TsBuildItem ): string => item.target
				)
			);

			if( targetsArgs.has( 'all' ) ) {
				targetsArgs.delete( 'all' );
				for( const allowed of targetsValid ) {
					targetsArgs.add( allowed );
				}
			}

			const targetsSelected: Set<string> = targetsArgs.intersection( targetsValid );
			const targetsInvalid: Set<string> = targetsArgs.difference( targetsValid );

			if( ( 0 < targetsSelected.size ) && ( 0 === targetsInvalid.size ) ) {
				for( const buildItem of buildItems ) {
					if( targetsSelected.has( buildItem.target ) ) {
						await builder.build( buildItem );
					}
				}
				exitCode = 0;
			} else {
				if( 0 < targetsInvalid.size ) {
					console.log( `Unknown target(s): ${ [ ...targetsInvalid ].join( ', ' ) }` );
				}

				console.log( 'Usage: tsBuild [-f tsBuild.json] <target> [<target> ...]' );
				console.log( `Using ${ configFile }:` );
				console.log( `Available targets: ${ [ ...targetsValid ].join( ', ' ) }, all` );
			}
		} catch( err: unknown ) {
			ZeptoLogger.instance.log( LogLevel.ERROR, err );
		}
		return exitCode;
	}
}

const modulePath: string = fileURLToPath( import.meta.url );
const argPath: string | undefined = process.argv[ 1 ];

if( argPath ) {
	const realModule: string = await realpath( modulePath );
	try {
		const realArg: string = await realpath( argPath );
		if( realModule === realArg ) {
			process.exitCode = 1;
			process.exitCode = await TsBuild.runCli( process.argv.slice( 2 ) );
		}
	} catch( _error: unknown ) {
		// argv[1] could not be resolved; treat as imported (isMain = false)
	}
}
