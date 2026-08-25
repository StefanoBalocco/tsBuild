#!/usr/bin/env node

import jTDAL from '@stefanobalocco/jtdal';
import terserCompanion from '@stefanobalocco/tersercompanion';
import { LogLevel, ZeptoLogger } from '@stefanobalocco/zeptologger';
import { createHash, getHashes } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
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

const hashAlgorithmMap: Record<TsHashVariableType, string> = {
	'hash-sha2-224': 'sha224',
	'hash-sha3-224': 'sha3-224',
	'hash-blake2s-256': 'blake2s256'
};

type TsTerserConfig = {
	enabled?: boolean;
	module?: boolean;
	toplevel?: boolean;
	mangle?: false | string;
};

const tsTerserConfigSchema: z.ZodType<TsTerserConfig> = z.object( {
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
} ).strict();

type TsTerser = z.infer<typeof tsTerserConfigSchema> | boolean;

const tsTerserSchema: z.ZodType<TsTerser> = z.union( [ z.boolean(), tsTerserConfigSchema ] );

type TsMinify = {
	files: string[];
	terser?: TsTerser;
	terserCompanion?: boolean;
};

const tsMinifySchema: z.ZodType<TsMinify> = z.object( {
	files: z.array( z.string() ),
	terser: tsTerserSchema.optional(),
	terserCompanion: z.boolean().optional()
} ).strict();

type TsHashVariableType = 'hash-sha2-224' | 'hash-sha3-224' | 'hash-blake2s-256';
type TsFileVariableType = 'mtime' | TsHashVariableType;

type TsStringVariable = {
	name: string;
	type: 'string';
	value: string;
};

type TsFileVariable = {
	name: string;
	type: TsFileVariableType;
	value: string | [ string, string ];
};

type TsVariable = TsStringVariable | TsFileVariable;

const tsStringVariableSchema: z.ZodObject<{
	name: z.ZodString;
	type: z.ZodLiteral<'string'>;
	value: z.ZodString;
}> = z.object( {
	name: z.string(),
	type: z.literal( 'string' ),
	value: z.string()
} ).strict();

const tsFileVariableSchema: z.ZodObject<{
	name: z.ZodString;
	type: z.ZodEnum<{
		mtime: 'mtime';
		'hash-sha2-224': 'hash-sha2-224';
		'hash-sha3-224': 'hash-sha3-224';
		'hash-blake2s-256': 'hash-blake2s-256';
	}>;
	value: z.ZodUnion<readonly [ z.ZodString, z.ZodTuple<[ z.ZodString, z.ZodString ], null> ]>;
}> = z.object( {
	name: z.string(),
	type: z.enum( [ 'mtime', 'hash-sha2-224', 'hash-sha3-224', 'hash-blake2s-256' ] ),
	value: z.union( [ z.string(), z.tuple( [ z.string(), z.string() ] ) ] )
} ).strict();

const tsVariableSchema: z.ZodType<TsVariable> = z.discriminatedUnion( 'type', [ tsStringVariableSchema, tsFileVariableSchema ] );

type TsHtmlTemplate = {
	filename: string;
	destination: string;
	variables?: TsVariable[];
};

const tsHtmlTemplateSchema: z.ZodType<TsHtmlTemplate> = z.object( {
	filename: z.string(),
	destination: z.string(),
	variables: z.array( tsVariableSchema ).optional()
} ).strict();

type TsJsTemplate = {
	filename: string;
	destination: string;
	output: 'esm' | 'cjs';
};

const tsJsTemplateSchema: z.ZodType<TsJsTemplate> = z.object( {
	filename: z.string(),
	destination: z.string(),
	output: z.enum( [ 'esm', 'cjs' ] )
} ).strict();

type TsCopy = {
	destination: string;
	files: string[];
	clean?: boolean;
};

const tsCopySchema: z.ZodType<TsCopy> = z.object( {
	destination: z.string(),
	files: z.array( z.string() ),
	clean: z.boolean().optional()
} ).strict();

export const tsBuildItemSchema: z.ZodType<{
	target: string;
	tsConfig: string;
	name?: string;
	prefix?: string;
	minify?: TsMinify;
	copy?: TsCopy[];
	templatesHtml?: TsHtmlTemplate[];
	templatesJs?: TsJsTemplate[];
}> = z.object( {
	target: z.string(),
	tsConfig: z.string(),
	name: z.string().optional(),
	prefix: z.string().optional(),
	minify: tsMinifySchema.optional(),
	copy: z.array( tsCopySchema ).optional(),
	templatesHtml: z.array( tsHtmlTemplateSchema ).optional(),
	templatesJs: z.array( tsJsTemplateSchema ).optional()
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
				if( tmpValue.code ) {
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

			if( compressed[ 0 ] != source ) {
				await writeFile( outPath, compressed[ 0 ] );
				returnValue = true;
			} else {
				try {
					await unlink( outPath );
				} catch( error: unknown ) {
					if( 'ENOENT' !== ( error as { code?: string } ).code ) {
						throw error;
					}
					// ignore only when absent generated output is to be removed
				}
			}
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

	private static async _hashFile( variableType: TsHashVariableType, algorithm: string, absSource: string ): Promise<string> {
		let returnValue: string = '';
		if( getHashes().includes( algorithm ) ) {
			const contents: Buffer = await readFile( absSource );
			returnValue = createHash( algorithm ).update( contents ).digest( 'hex' );
		} else {
			throw new Error( `Hash algorithm "${ algorithm }" is unavailable for variable type "${ variableType }"` );
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

	private static _resolveTerserConfig( terser: Undefinedable<TsTerser>, moduleDefault: boolean ): { enabled: boolean; options: TerserOptions } {
		let returnValue: { enabled: boolean; options: TerserOptions };
		const options: TerserOptions = { module: moduleDefault };
		if( 'boolean' === typeof terser ) {
			returnValue = { enabled: terser, options };
		} else if( undefined !== terser ) {
			if( undefined !== terser.module ) {
				options.module = terser.module;
			}
			if( undefined !== terser.toplevel ) {
				options.toplevel = terser.toplevel;
			}
			if( undefined !== terser.mangle ) {
				options.mangle = terser.mangle;
			}
			returnValue = { enabled: terser.enabled ?? true, options };
		} else {
			returnValue = { enabled: true, options };
		}
		return returnValue;
	}

	public static async copy( absDestination: string, absFiles: string[], clean: boolean ): Promise<void> {
		if( clean ) {
			await rm( absDestination, { recursive: true, force: true } );
		}
		await mkdir( absDestination, { recursive: true } );
		const cL1: number = absFiles.length;
		for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
			const absFile: string = absFiles[ iL1 ];
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
			const terserResolved: { enabled: boolean; options: TerserOptions } = TsBuild._resolveTerserConfig( buildItem.minify.terser, true );
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
			const cL1: number = buildItem.templatesJs.length;
			for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
				const template: TsJsTemplate = buildItem.templatesJs[ iL1 ];
				const absTemplate: string = path.resolve( targetDirectory, template.filename );
				const absDestination: string = path.resolve( this._configDirectory, template.destination );
				const templateSource: string = await readFile( absTemplate, 'utf8' );
				const compiled: string = new jTDAL().CompileToString( templateSource );
				const moduleSource: string = ( 'esm' === template.output ) ? `export default ${ compiled }` : `module.exports = ${ compiled };`;
				const parsedPath: path.ParsedPath = path.parse( absTemplate );
				const outputName: string = ( 'esm' === template.output ) ? `${ parsedPath.name }.mjs` : `${ parsedPath.name }.cjs`;
				await mkdir( absDestination, { recursive: true } );
				await writeFile( path.resolve( absDestination, outputName ), moduleSource, 'utf8' );
			}
		}

		if( minifyPlan && ( minifyPlan.enabled || minifyPlan.useTerserCompanion ) ) {
			const cL1: number = minifyPlan.files.length;
			for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
				const absFile: string = path.resolve( targetDirectory, minifyPlan.files[ iL1 ] );
				ZeptoLogger.instance.log( LogLevel.INFO, `[${ targetLabel }] Minifying ${ path.relative( this._configDirectory, absFile ) }...` );
				await TsBuild.minify( absFile, minifyPlan.enabled, minifyPlan.useTerserCompanion, minifyPlan.options );
			}
		}

		if( buildItem.copy ) {
			const cL1: number = buildItem.copy.length;
			for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
				const copy: { destination: string; files: string[]; clean?: boolean; } = buildItem.copy[ iL1 ];
				const absDestination: string = path.resolve( this._configDirectory, copy.destination );
				const absFiles: string[] = [];
				const cL2: number = copy.files.length;
				for( let iL2: number = 0; iL2 < cL2; iL2++ ) {
					absFiles[ iL2 ] = path.resolve( targetDirectory, copy.files[ iL2 ] );
				}
				await TsBuild.copy( absDestination, absFiles, copy.clean ?? false );
			}
		}

		if( buildItem.templatesHtml ) {
			const cL1: number = buildItem.templatesHtml.length;
			for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
				const template: TsHtmlTemplate = buildItem.templatesHtml[ iL1 ];
				const absTemplate: string = path.resolve( targetDirectory, template.filename );
				const absDestination: string = path.resolve( this._configDirectory, template.destination );
				const variables: Record<string, string | number> = {};
				const templateVariables: TsVariable[] = template.variables ?? [];
				const cL2: number = templateVariables.length;
				for( let iL2: number = 0; iL2 < cL2; iL2++ ) {
					const variable: TsVariable = templateVariables[ iL2 ];
					switch( variable.type ) {
						case 'string': {
							variables[ variable.name ] = variable.value;
							break;
						}
						case 'mtime': {
							if( 'string' === typeof variable.value ) {
								variables[ variable.name ] = ( await stat( path.resolve( targetDirectory, variable.value ) ) ).mtime.getTime();
							} else {
								const sourcePath: string = variable.value[ 0 ];
								const prefix: string = variable.value[ 1 ];
								const timestamp: number = ( await stat( path.resolve( targetDirectory, sourcePath ) ) ).mtime.getTime();
								variables[ variable.name ] = TsBuild._formatTupleToken( sourcePath, prefix, timestamp );
							}
							break;
						}
						case 'hash-sha2-224':
						case 'hash-sha3-224':
						case 'hash-blake2s-256': {
							const algorithm: string = hashAlgorithmMap[ variable.type ];
							if( 'string' === typeof variable.value ) {
								variables[ variable.name ] = await TsBuild._hashFile( variable.type, algorithm, path.resolve( targetDirectory, variable.value ) );
							} else {
								const sourcePath: string = variable.value[ 0 ];
								const prefix: string = variable.value[ 1 ];
								const digest: string = await TsBuild._hashFile( variable.type, algorithm, path.resolve( targetDirectory, sourcePath ) );
								variables[ variable.name ] = TsBuild._formatTupleToken( sourcePath, prefix, digest );
							}
							break;
						}
					}
				}
				await TsBuild.templating( absTemplate, absDestination, variables );
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
