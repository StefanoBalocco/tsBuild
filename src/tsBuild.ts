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

	public static async minify( absPath: string, useTerser: boolean, useTerserCompanion: boolean ): Promise<boolean> {
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
		if( buildItem.minify ) {
			buildItem.minify.terser ??= true;
			buildItem.minify.terserCompanion ??= true;
		} else {
			buildItem.minify = {
				files: []
			};
		}

		ZeptoLogger.instance.log( LogLevel.INFO, `[${ targetLabel }] Compiling TypeScript...` );
		TsBuild.compile( absConfig );

		if( buildItem.minify.terser || buildItem.minify.terserCompanion ) {
			const cL1: number = buildItem.minify.files.length;
			for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
				const absFile: string = path.resolve( targetDirectory, buildItem.minify.files[ iL1 ] );
				ZeptoLogger.instance.log( LogLevel.INFO, `[${ targetLabel }] Minifying ${ path.relative( this._configDirectory, absFile ) }...` );
				await TsBuild.minify( absFile, buildItem.minify.terser!, buildItem.minify.terserCompanion! );
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
				const template: {
					filename: string;
					destination: string;
					variables: { name: string; type: 'string' | 'mtime'; value: string; }[];
				} = buildItem.templates[ iL1 ];
				const absTemplate: string = path.resolve( targetDirectory, template.filename );
				const absDestination: string = path.resolve( this._configDirectory, template.destination );
				const variables: Record<string, string | number> = {};
				const cL2: number = template.variables.length;
				for( let iL2: number = 0; iL2 < cL2; iL2++ ) {
					const variable: { name: string; type: 'string' | 'mtime'; value: string; } = template.variables[ iL2 ];
					if( 'string' === variable.type ) {
						variables[ variable.name ] = variable.value;
					} else {
						variables[ variable.name ] = ( await stat( path.resolve( targetDirectory, variable.value ) ) ).mtimeMs;
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

			const buildItems: TsBuildItem[] = JSON.parse( content ) as TsBuildItem[];

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
