#!/usr/bin/env node

import jTDAL from '@stefanobalocco/jtdal';
import terserCompanion from '@stefanobalocco/tersercompanion';
import { LogLevel, ZeptoLogger } from '@stefanobalocco/zeptologger';
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

type TsTemplateMinify = {
	terser?: TsTerser;
	terserCompanion?: boolean;
};

const tsTemplateMinifySchema: z.ZodType<TsTemplateMinify> = z.object( {
	terser: tsTerserSchema.optional(),
	terserCompanion: z.boolean().optional()
} ).strict();

type TsVariable = {
	name: string;
	type: 'string' | 'mtime';
	value: string;
};

const tsVariableSchema: z.ZodType<TsVariable> = z.object( {
	name: z.string(),
	type: z.enum( [ 'string', 'mtime' ] ),
	value: z.string()
} ).strict();

type TsTemplate = {
	filename: string;
	destination: string;
	output?: 'html' | 'esm' | 'cjs';
	variables?: TsVariable[];
	minify?: TsTemplateMinify;
};

const tsTemplateSchema: z.ZodType<TsTemplate> = z.object( {
	filename: z.string(),
	destination: z.string(),
	output: z.enum( [ 'html', 'esm', 'cjs' ] ).optional(),
	variables: z.array( tsVariableSchema ).optional(),
	minify: tsTemplateMinifySchema.optional()
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
	templates?: TsTemplate[];
}> = z.object( {
	target: z.string(),
	tsConfig: z.string(),
	name: z.string().optional(),
	prefix: z.string().optional(),
	minify: tsMinifySchema.optional(),
	copy: z.array( tsCopySchema ).optional(),
	templates: z.array( tsTemplateSchema ).optional()
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

	private static async _minifySource(
		source: string,
		useTerser: boolean,
		useTerserCompanion: boolean,
		terserOptions: TerserOptions
	): Promise<string> {
		let returnValue: string = '';
		const compressed: [ string, number ][] = [];

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
				compressed[ 0 ] = [ tmpValue.code, Buffer.byteLength( tmpValue.code, 'utf8' ) ];
				ZeptoLogger.instance.log( LogLevel.INFO, `[MINIFY] Size> Terser         : ${ compressed[ 0 ][ 1 ] }` );
			}
		}

		if( useTerserCompanion ) {
			const tmpValue: string = terserCompanion( ( compressed[ 0 ] && compressed[ 0 ][ 0 ] ) ?? source );
			compressed[ 1 ] = [ tmpValue, Buffer.byteLength( tmpValue, 'utf8' ) ];
			ZeptoLogger.instance.log( LogLevel.INFO, `[MINIFY] Size> TerserCompanion: ${ compressed[ 1 ][ 1 ] }` );
		}

		const output: string = ( compressed[ 0 ] && compressed[ 1 ] ) ? (
			( compressed[ 1 ][ 1 ] < compressed[ 0 ][ 1 ] ) ? compressed[ 1 ][ 0 ] : compressed[ 0 ][ 0 ]
		) : (
			( compressed[ 1 ] && compressed[ 1 ][ 0 ] ) ?? ( compressed[ 0 ] && compressed[ 0 ][ 0 ] ) ?? ''
		);
		if( output ) {
			ZeptoLogger.instance.log( LogLevel.INFO, `[MINIFY] Size> Output         : ${ Buffer.byteLength( output, 'utf8' ) }` );
		}
		returnValue = output;
		return returnValue;
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
			const output: string = await TsBuild._minifySource( source, useTerser, useTerserCompanion, terserOptions );
			if( output ) {
				await writeFile( outPath, output );
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
		const issuePath: readonly PropertyKey[] = [ ...parentPath, ...issue.path ];
		if( 'invalid_union' === issue.code ) {
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
					const segmentName: string = String( segment );
					if( formattedPath ) {
						formattedPath += `.${ segmentName }`;
					} else {
						formattedPath = segmentName;
					}
				}
			}
			if( 'unrecognized_keys' === issue.code ) {
				const cL2: number = issue.keys.length;
				for( let iL2: number = 0; iL2 < cL2; iL2++ ) {
					const key: string = issue.keys[ iL2 ];
					const keyPath: string = formattedPath ? `${ formattedPath }.${ key }` : key;
					returnValue.push( `${ keyPath }: Unrecognized key: ${ JSON.stringify( key ) }` );
				}
			} else {
				const leafLabel: string = formattedPath ? formattedPath : '(root)';
				returnValue.push( `${ leafLabel }: ${ issue.message }` );
			}
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

		if( buildItem.templates ) {
			const cL1: number = buildItem.templates.length;
			for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
				const template: TsTemplate = buildItem.templates[ iL1 ];
				const absTemplate: string = path.resolve( targetDirectory, template.filename );
				const absDestination: string = path.resolve( this._configDirectory, template.destination );
				const output: 'html' | 'esm' | 'cjs' = template.output ?? 'html';
				if( 'html' === output ) {
					const variables: Record<string, string | number> = {};
					const cL2: number = ( template.variables ?? [] ).length;
					for( let iL2: number = 0; iL2 < cL2; iL2++ ) {
						const variable: TsVariable = ( template.variables ?? [] )[ iL2 ];
						switch( variable.type ) {
							case 'string': {
								variables[ variable.name ] = variable.value;
								break;
							}
							case 'mtime': {
								variables[ variable.name ] = ( await stat( path.resolve( targetDirectory, variable.value ) ) ).mtime.getTime();
								break;
							}
						}
					}
					await TsBuild.templating( absTemplate, absDestination, variables );
				} else {
					const terserResolved: { enabled: boolean; options: TerserOptions } = TsBuild._resolveTerserConfig( template.minify?.terser, 'esm' === output );
					const useTerserCompanion: boolean = template.minify?.terserCompanion ?? true;
					const templateSource: string = await readFile( absTemplate, 'utf8' );
					const compiled: string = new jTDAL().CompileToString( templateSource );
					const moduleSource: string = ( 'esm' === output ) ? `export default ${ compiled }` : `module.exports = ${ compiled };`;
					let outputSource: string = moduleSource;
					if( terserResolved.enabled || useTerserCompanion ) {
						const minified: string = await TsBuild._minifySource( moduleSource, terserResolved.enabled, useTerserCompanion, terserResolved.options );
						if( minified ) {
							outputSource = minified;
						}
					}
					const parsedPath: path.ParsedPath = path.parse( absTemplate );
					const outputName: string = ( 'esm' === output ) ? `${ parsedPath.name }.mjs` : `${ parsedPath.name }.cjs`;
					await mkdir( absDestination, { recursive: true } );
					await writeFile( path.resolve( absDestination, outputName ), outputSource, 'utf8' );
				}
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
