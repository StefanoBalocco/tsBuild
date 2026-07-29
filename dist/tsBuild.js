#!/usr/bin/env node
import jTDAL from '@stefanobalocco/jtdal';
import terserCompanion from '@stefanobalocco/tersercompanion';
import { LogLevel, ZeptoLogger } from '@stefanobalocco/zeptologger';
import { copyFile, mkdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';
import ts from 'typescript';
export default class TsBuild {
    _configDirectory;
    constructor(configDirectory) {
        this._configDirectory = configDirectory;
    }
    static compile(configPath) {
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
    static async minify(absPath, useTerser, useTerserCompanion) {
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
    static async copy(absDestination, absFiles, clean) {
        if (clean) {
            await rm(absDestination, { recursive: true, force: true });
        }
        await mkdir(absDestination, { recursive: true });
        const cL1 = absFiles.length;
        for (let iL1 = 0; iL1 < cL1; iL1++) {
            const absFile = absFiles[iL1];
            await copyFile(absFile, path.resolve(absDestination, path.basename(absFile)));
        }
    }
    static async templating(absTemplate, absDestination, variables) {
        const templateSource = await readFile(absTemplate, 'utf8');
        const output = new jTDAL().CompileToFunction(templateSource)(variables);
        await mkdir(absDestination, { recursive: true });
        await writeFile(path.resolve(absDestination, path.basename(absTemplate)), output, 'utf8');
    }
    async build(buildItem) {
        const targetLabel = (buildItem.name ?? buildItem.target).toUpperCase();
        const targetDirectory = path.resolve(this._configDirectory, buildItem.prefix ?? '');
        const absConfig = path.resolve(targetDirectory, buildItem.tsConfig);
        if (buildItem.minify) {
            buildItem.minify.terser ??= true;
            buildItem.minify.terserCompanion ??= true;
        }
        else {
            buildItem.minify = {
                files: []
            };
        }
        ZeptoLogger.instance.log(LogLevel.INFO, `[${targetLabel}] Compiling TypeScript...`);
        TsBuild.compile(absConfig);
        if (buildItem.minify.terser || buildItem.minify.terserCompanion) {
            const cL1 = buildItem.minify.files.length;
            for (let iL1 = 0; iL1 < cL1; iL1++) {
                const absFile = path.resolve(targetDirectory, buildItem.minify.files[iL1]);
                ZeptoLogger.instance.log(LogLevel.INFO, `[${targetLabel}] Minifying ${path.relative(this._configDirectory, absFile)}...`);
                await TsBuild.minify(absFile, buildItem.minify.terser, buildItem.minify.terserCompanion);
            }
        }
        if (buildItem.copy) {
            const cL1 = buildItem.copy.length;
            for (let iL1 = 0; iL1 < cL1; iL1++) {
                const copy = buildItem.copy[iL1];
                const absDestination = path.resolve(this._configDirectory, copy.destination);
                const absFiles = [];
                const cL2 = copy.files.length;
                for (let iL2 = 0; iL2 < cL2; iL2++) {
                    absFiles[iL2] = path.resolve(targetDirectory, copy.files[iL2]);
                }
                await TsBuild.copy(absDestination, absFiles, copy.clean ?? false);
            }
        }
        if (buildItem.templates) {
            const cL1 = buildItem.templates.length;
            for (let iL1 = 0; iL1 < cL1; iL1++) {
                const template = buildItem.templates[iL1];
                const absTemplate = path.resolve(targetDirectory, template.filename);
                const absDestination = path.resolve(this._configDirectory, template.destination);
                const variables = {};
                const cL2 = template.variables.length;
                for (let iL2 = 0; iL2 < cL2; iL2++) {
                    const variable = template.variables[iL2];
                    if ('string' === variable.type) {
                        variables[variable.name] = variable.value;
                    }
                    else {
                        variables[variable.name] = (await stat(path.resolve(targetDirectory, variable.value))).mtimeMs;
                    }
                }
                await TsBuild.templating(absTemplate, absDestination, variables);
            }
        }
        ZeptoLogger.instance.log(LogLevel.INFO, `[${targetLabel}] ✓ Built.`);
    }
    static async runCli(argumentsInput) {
        let exitCode = 1;
        let configFile = './tsBuild.json';
        let targetsArgs = new Set(argumentsInput);
        if ((2 <= argumentsInput.length) && ('-f' === argumentsInput[0])) {
            configFile = argumentsInput[1];
            targetsArgs = new Set(argumentsInput.slice(2));
        }
        try {
            const resolvedConfigFile = path.resolve(process.cwd(), configFile);
            const content = await readFile(resolvedConfigFile, 'utf8');
            const buildItems = JSON.parse(content);
            const builder = new TsBuild(path.dirname(resolvedConfigFile));
            const targetsValid = new Set(buildItems.map((item) => item.target));
            if (targetsArgs.has('all')) {
                targetsArgs.delete('all');
                for (const allowed of targetsValid) {
                    targetsArgs.add(allowed);
                }
            }
            const targetsSelected = targetsArgs.intersection(targetsValid);
            const targetsInvalid = targetsArgs.difference(targetsValid);
            if ((0 < targetsSelected.size) && (0 === targetsInvalid.size)) {
                for (const buildItem of buildItems) {
                    if (targetsSelected.has(buildItem.target)) {
                        await builder.build(buildItem);
                    }
                }
                exitCode = 0;
            }
            else {
                if (0 < targetsInvalid.size) {
                    console.log(`Unknown target(s): ${[...targetsInvalid].join(', ')}`);
                }
                console.log('Usage: tsBuild [-f tsBuild.json] <target> [<target> ...]');
                console.log(`Using ${configFile}:`);
                console.log(`Available targets: ${[...targetsValid].join(', ')}, all`);
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