#!/usr/bin/env node
import { LogLevel, ZeptoLogger } from '@stefanobalocco/zeptologger';
import { copyFile, mkdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { minify } from 'terser';
import terserCompanion from '@stefanobalocco/tersercompanion';
import jTDAL from '@stefanobalocco/jtdal';
export default class TsBuild {
    _configDirectory;
    _targets;
    _targetsNames;
    constructor(configDirectory, targets) {
        this._configDirectory = configDirectory;
        this._targets = targets;
        this._targetsNames = new Set(this._targets.map((target) => target.target));
    }
    static async fromConfigFile(configFile) {
        const resolvedConfigFile = path.resolve(configFile);
        const content = await readFile(resolvedConfigFile, 'utf8');
        const targets = JSON.parse(content);
        return new TsBuild(path.dirname(resolvedConfigFile), targets);
    }
    static compileTsc(configPath) {
        const absConfig = path.resolve(configPath);
        const configFile = ts.readConfigFile(absConfig, ts.sys.readFile);
        if (configFile.error) {
            throw new Error(ts.formatDiagnosticsWithColorAndContext([configFile.error], {
                getCurrentDirectory: ts.sys.getCurrentDirectory,
                getCanonicalFileName: (fileName) => fileName,
                getNewLine: () => '\n'
            }));
        }
        const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(absConfig));
        const program = ts.createProgram(parsed.fileNames, parsed.options);
        const emitResult = program.emit();
        const diagnostics = [
            ...parsed.errors,
            ...ts.getPreEmitDiagnostics(program),
            ...emitResult.diagnostics
        ];
        if (0 < diagnostics.length) {
            throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
                getCurrentDirectory: ts.sys.getCurrentDirectory,
                getCanonicalFileName: (fileName) => fileName,
                getNewLine: () => '\n'
            }));
        }
    }
    static async minifyFile(absPath, useTerser, useTerserCompanion) {
        let returnValue = false;
        if (useTerser || useTerserCompanion) {
            const source = await readFile(absPath, 'utf8');
            const parsedPath = path.parse(absPath);
            const outPath = path.join(parsedPath.dir, `${parsedPath.name}.min${parsedPath.ext}`);
            const compressed = [];
            if (useTerser) {
                const tmpValue = await minify(source, {
                    module: true,
                    toplevel: true,
                    compress: { defaults: true, passes: 2 },
                    mangle: { properties: { regex: /^_/ } }
                });
                if (tmpValue.code) {
                    compressed[0] = [tmpValue.code, Buffer.byteLength(tmpValue.code, 'utf8')];
                    ZeptoLogger.instance.log(LogLevel.INFO, `[MINIFY] Size> Terser         : ${compressed[0][1]}`);
                }
            }
            if (useTerserCompanion) {
                const tmpValue = terserCompanion((compressed[0] && compressed[0][0]) ?? source);
                compressed[1] = [tmpValue, Buffer.byteLength(tmpValue, 'utf8')];
                ZeptoLogger.instance.log(LogLevel.INFO, `[MINIFY] Size> TerserCompanion: ${compressed[1][1]}`);
            }
            const output = (compressed[0] && compressed[1]) ? ((compressed[1][1] < compressed[0][1]) ? compressed[1][0] : compressed[0][0]) : ((compressed[1] && compressed[1][0]) ?? (compressed[0] && compressed[0][0]) ?? '');
            if (output) {
                ZeptoLogger.instance.log(LogLevel.INFO, `[MINIFY] Size> Output         : ${Buffer.byteLength(output, 'utf8')}`);
                await writeFile(outPath, output);
                returnValue = true;
            }
            else {
                try {
                    await unlink(outPath);
                }
                catch (error) {
                    if ('ENOENT' !== error.code) {
                        throw error;
                    }
                }
            }
        }
        return returnValue;
    }
    async build(targetNamesRequested) {
        let returnValue = false;
        const namesMutable = new Set(targetNamesRequested);
        if (namesMutable.has('all')) {
            namesMutable.delete('all');
            for (const allowed of this._targetsNames) {
                namesMutable.add(allowed);
            }
        }
        const selected = namesMutable.intersection(this._targetsNames);
        const invalid = namesMutable.difference(this._targetsNames);
        if ((0 < selected.size) && (0 === invalid.size)) {
            const cL1 = this._targets.length;
            for (let iL1 = 0; iL1 < cL1; iL1++) {
                const item = this._targets[iL1];
                if (selected.has(item.target)) {
                    const targetLabel = (item.name ?? item.target).toUpperCase();
                    const targetDirectory = path.resolve(this._configDirectory, item.prefix ?? '');
                    const absConfig = path.resolve(targetDirectory, item.tsConfig);
                    if (item.minify) {
                        item.minify.terser ??= true;
                        item.minify.terserCompanion ??= true;
                    }
                    else {
                        item.minify = {
                            files: []
                        };
                    }
                    ZeptoLogger.instance.log(LogLevel.INFO, `[${targetLabel}] Compiling TypeScript...`);
                    TsBuild.compileTsc(absConfig);
                    if (item.minify.terser || item.minify.terserCompanion) {
                        const cL2 = item.minify.files.length;
                        for (let iL2 = 0; iL2 < cL2; iL2++) {
                            const absFile = path.resolve(targetDirectory, item.minify.files[iL2]);
                            ZeptoLogger.instance.log(LogLevel.INFO, `[${targetLabel}] Minifying ${path.relative(this._configDirectory, absFile)}...`);
                            await TsBuild.minifyFile(absFile, item.minify.terser, item.minify.terserCompanion);
                        }
                    }
                    if (item.copy) {
                        const cL2 = item.copy.length;
                        for (let iL2 = 0; iL2 < cL2; iL2++) {
                            const copy = item.copy[iL2];
                            const absDestination = path.resolve(this._configDirectory, copy.destination);
                            if (copy.clean) {
                                await rm(absDestination, { recursive: true, force: true });
                            }
                            await mkdir(absDestination, { recursive: true });
                            const cL3 = copy.files.length;
                            for (let iL3 = 0; iL3 < cL3; iL3++) {
                                const file = copy.files[iL3];
                                const absSource = path.resolve(targetDirectory, file);
                                const absTarget = path.resolve(absDestination, path.basename(file));
                                await copyFile(absSource, absTarget);
                            }
                        }
                    }
                    if (item.templates) {
                        const cL2 = item.templates.length;
                        for (let iL2 = 0; iL2 < cL2; iL2++) {
                            const template = item.templates[iL2];
                            const absTemplate = path.resolve(targetDirectory, template.filename);
                            const templateSource = await readFile(absTemplate, 'utf8');
                            const data = {};
                            const cL3 = template.variables.length;
                            for (let iL3 = 0; iL3 < cL3; iL3++) {
                                const variable = template.variables[iL3];
                                if ('string' === variable.type) {
                                    data[variable.name] = variable.value;
                                }
                                else {
                                    data[variable.name] = (await stat(path.resolve(targetDirectory, variable.value))).mtimeMs;
                                }
                            }
                            const output = new jTDAL().CompileToFunction(templateSource)(data);
                            const absDestination = path.resolve(this._configDirectory, template.destination);
                            await mkdir(absDestination, { recursive: true });
                            await writeFile(path.resolve(absDestination, path.basename(template.filename)), output, 'utf8');
                        }
                    }
                    ZeptoLogger.instance.log(LogLevel.INFO, `[${targetLabel}] ✓ Built.`);
                }
            }
            returnValue = true;
        }
        else {
            if (0 < invalid.size) {
                ZeptoLogger.instance.log(LogLevel.ERROR, `Unknown target(s): ${[...invalid].join(', ')}`);
            }
            ZeptoLogger.instance.log(LogLevel.INFO, 'Usage: tsBuild [-f tsBuild.json] <target> [<target> ...]');
            ZeptoLogger.instance.log(LogLevel.INFO, `Available targets: ${[...this._targetsNames].join(', ')}, all`);
        }
        return returnValue;
    }
    static async runCli(argumentsInput) {
        let exitCode = 1;
        let configFile = 'tsBuild.json';
        let targetNamesArgs = new Set(argumentsInput);
        if ((2 <= argumentsInput.length) && ('-f' === argumentsInput[0])) {
            configFile = argumentsInput[1];
            targetNamesArgs = new Set(argumentsInput.slice(2));
        }
        try {
            const builder = await TsBuild.fromConfigFile(path.resolve(process.cwd(), configFile));
            const success = await builder.build(targetNamesArgs);
            if (success) {
                exitCode = 0;
            }
        }
        catch (err) {
            ZeptoLogger.instance.log(LogLevel.ERROR, err);
        }
        return exitCode;
    }
}
const modulePath = fileURLToPath(import.meta.url);
const argPath = process.argv[1];
if (argPath) {
    const realModule = await realpath(modulePath);
    try {
        const realArg = await realpath(argPath);
        if (realModule === realArg) {
            process.exitCode = 1;
            process.exitCode = await TsBuild.runCli(process.argv.slice(2));
        }
    }
    catch (_error) {
    }
}
//# sourceMappingURL=tsBuild.js.map