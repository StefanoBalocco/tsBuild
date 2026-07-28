#!/usr/bin/env node

import jTDAL from '@stefanobalocco/jtdal';
import terserCompanion from '@stefanobalocco/tersercompanion';
import { LogLevel, ZeptoLogger } from '@stefanobalocco/zeptologger';
import { copyFile, mkdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { MinifyOutput } from 'terser';
import { minify } from 'terser';
import ts from 'typescript';

export type TsBuildItem = {
	target: string;
	tsConfig: string;
	name?: string;
	prefix?: string;
	minify?: {
		files: string[];
		terser?: boolean;
		terserCompanion?: boolean;
	};
	copy?: {
		destination: string;
		files: string[];
		clean?: boolean;
	}[];
	templates?: {
		filename: string;
		destination: string;
		variables: {
			name: string;
			type: 'string' | 'mtime';
			value: string;
		}[];
	}[];
};

export default class TsBuild {
	private readonly _configDirectory: string;
	private readonly _targets: TsBuildItem[];
	private readonly _targetsNames: Set<string>;

	public constructor( configDirectory: string, targets: TsBuildItem[] ) {
		this._configDirectory = configDirectory;
		this._targets = targets;
		this._targetsNames = new Set<string>(
			this._targets.map(
				( target: TsBuildItem ): string => target.target
			)
		);
	}

	public static async fromConfigFile( configFile: string ): Promise<TsBuild> {
		const resolvedConfigFile: string = path.resolve( configFile );
		const content: string = await readFile( resolvedConfigFile, 'utf8' );
		const targets: TsBuildItem[] = JSON.parse( content ) as TsBuildItem[];

		return new TsBuild( path.dirname( resolvedConfigFile ), targets );
	}

	public static compileTsc( configPath: string ): void {
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

	public static async minifyFile( absPath: string, useTerser: boolean, useTerserCompanion: boolean ): Promise<boolean> {
		let returnValue: boolean = false;
		if( useTerser || useTerserCompanion ) {
			const source: string = await readFile( absPath, 'utf8' );
			const parsedPath: path.ParsedPath = path.parse( absPath );
			const outPath: string = path.join( parsedPath.dir, `${ parsedPath.name }.min${ parsedPath.ext }` );
			const compressed: [ string, number ][] = [];

			if( useTerser ) {
				const tmpValue: MinifyOutput = await minify( source, {
					module: true,
					toplevel: true,
					compress: { defaults: true, passes: 2 },
					mangle: { properties: { regex: /^_/ } }
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

	public async build( targetNamesRequested: Set<string> ): Promise<boolean> {
		let returnValue: boolean = false;
		const namesMutable: Set<string> = new Set( targetNamesRequested );

		if( namesMutable.has( 'all' ) ) {
			namesMutable.delete( 'all' );
			for( const allowed of this._targetsNames ) {
				namesMutable.add( allowed );
			}
		}

		const selected: Set<string> = namesMutable.intersection( this._targetsNames );
		const invalid: Set<string> = namesMutable.difference( this._targetsNames );

		if( ( 0 < selected.size ) && ( 0 === invalid.size ) ) {
			const cL1: number = this._targets.length;
			for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
				const item: TsBuildItem = this._targets[ iL1 ];
				if( selected.has( item.target ) ) {
					const targetLabel: string = ( item.name ?? item.target ).toUpperCase();
					const targetDirectory: string = path.resolve( this._configDirectory, item.prefix ?? '' );
					const absConfig: string = path.resolve( targetDirectory, item.tsConfig );
					if( item.minify ) {
						item.minify.terser ??= true;
						item.minify.terserCompanion ??= true;
					} else {
						item.minify = {
							files: []
						};
					}

					ZeptoLogger.instance.log( LogLevel.INFO, `[${ targetLabel }] Compiling TypeScript...` );
					TsBuild.compileTsc( absConfig );

					if( item.minify.terser || item.minify.terserCompanion ) {
						const cL2: number = item.minify.files.length;
						for( let iL2: number = 0; iL2 < cL2; iL2++ ) {
							const absFile: string = path.resolve( targetDirectory, item.minify.files[ iL2 ] );
							ZeptoLogger.instance.log( LogLevel.INFO, `[${ targetLabel }] Minifying ${ path.relative( this._configDirectory, absFile ) }...` );
							await TsBuild.minifyFile( absFile, item.minify.terser!, item.minify.terserCompanion! );
						}
					}

					if( item.copy ) {
						const cL2: number = item.copy.length;
						for( let iL2: number = 0; iL2 < cL2; iL2++ ) {
							const copy: { destination: string; files: string[]; clean?: boolean; } = item.copy[ iL2 ];
							const absDestination: string = path.resolve( this._configDirectory, copy.destination );
							if( copy.clean ) {
								await rm( absDestination, { recursive: true, force: true } );
							}
							await mkdir( absDestination, { recursive: true } );
							const cL3: number = copy.files.length;
							for( let iL3: number = 0; iL3 < cL3; iL3++ ) {
								const file: string = copy.files[ iL3 ];
								const absSource: string = path.resolve( targetDirectory, file );
								const absTarget: string = path.resolve( absDestination, path.basename( file ) );
								await copyFile( absSource, absTarget );
							}
						}
					}

					if( item.templates ) {
						const cL2: number = item.templates.length;
						for( let iL2: number = 0; iL2 < cL2; iL2++ ) {
							const template: { filename: string; destination: string; variables: { name: string; type: 'string' | 'mtime'; value: string; }[]; } = item.templates[ iL2 ];
							const absTemplate: string = path.resolve( targetDirectory, template.filename );
							const templateSource: string = await readFile( absTemplate, 'utf8' );
							const data: Record<string, string | number> = {};
							const cL3: number = template.variables.length;
							for( let iL3: number = 0; iL3 < cL3; iL3++ ) {
								const variable: { name: string; type: 'string' | 'mtime'; value: string; } = template.variables[ iL3 ];
								if( 'string' === variable.type ) {
									data[ variable.name ] = variable.value;
								} else {
									data[ variable.name ] = ( await stat( path.resolve( targetDirectory, variable.value ) ) ).mtimeMs;
								}
							}
							const output: string = new jTDAL().CompileToFunction( templateSource )( data );
							const absDestination: string = path.resolve( this._configDirectory, template.destination );
							await mkdir( absDestination, { recursive: true } );
							await writeFile( path.resolve( absDestination, path.basename( template.filename ) ), output, 'utf8' );
						}
					}

					ZeptoLogger.instance.log( LogLevel.INFO, `[${ targetLabel }] ✓ Built.` );
				}
			}
			returnValue = true;
		} else {
			if( 0 < invalid.size ) {
				ZeptoLogger.instance.log( LogLevel.ERROR, `Unknown target(s): ${ [ ...invalid ].join( ', ' ) }` );
			}

			ZeptoLogger.instance.log( LogLevel.INFO, 'Usage: tsBuild [-f tsBuild.json] <target> [<target> ...]' );
			ZeptoLogger.instance.log( LogLevel.INFO, `Available targets: ${ [ ...this._targetsNames ].join( ', ' ) }, all` );
		}
		return returnValue;
	}

	public static async runCli( argumentsInput: string[] ): Promise<number> {
		let exitCode: number = 1;
		let configFile: string = 'tsBuild.json';
		let targetNamesArgs: Set<string> = new Set( argumentsInput );

		if( ( 2 <= argumentsInput.length ) && ( '-f' === argumentsInput[ 0 ] ) ) {
			configFile = argumentsInput[ 1 ];
			targetNamesArgs = new Set( argumentsInput.slice( 2 ) );
		}

		try {
			const builder: TsBuild = await TsBuild.fromConfigFile(
				path.resolve( process.cwd(), configFile )
			);

			const success: boolean = await builder.build( targetNamesArgs );

			if( success ) {
				exitCode = 0;
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
