#!/usr/bin/env node
import jTDAL from '@stefanobalocco/jtdal';
import terserCompanion from '@stefanobalocco/tersercompanion';
import { LogLevel, ZeptoLogger } from '@stefanobalocco/zeptologger';
import { createHash, getHashes } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';
import ts from 'typescript';
import { z } from 'zod';
const defaultManglePattern = '^_';
const defaultTerserOptions = {
    module: true,
    mangle: defaultManglePattern
};
const hashAlgorithmMap = {
    'hash-sha2-224': 'sha224',
    'hash-sha3-224': 'sha3-224',
    'hash-blake2s-256': 'blake2s256'
};
const tsTerserConfigSchema = z.object({
    enabled: z.boolean().optional(),
    module: z.boolean().optional(),
    toplevel: z.boolean().optional(),
    mangle: z.union([
        z.literal(false),
        z.string().refine((value) => {
            let returnValue = true;
            try {
                RegExp(value);
            }
            catch {
                returnValue = false;
            }
            return returnValue;
        }, { message: 'Invalid regular expression' })
    ]).optional()
}).strict();
const tsTerserSchema = z.union([z.boolean(), tsTerserConfigSchema]);
const tsMinifySchema = z.object({
    files: z.array(z.string()),
    terser: tsTerserSchema.optional(),
    terserCompanion: z.boolean().optional()
}).strict();
const tsStringVariableSchema = z.object({
    name: z.string(),
    type: z.literal('string'),
    value: z.string()
}).strict();
const tsFileVariableSchema = z.object({
    name: z.string(),
    type: z.enum(['mtime', 'hash-sha2-224', 'hash-sha3-224', 'hash-blake2s-256']),
    value: z.union([z.string(), z.tuple([z.string(), z.string()])])
}).strict();
const tsVariableSchema = z.discriminatedUnion('type', [tsStringVariableSchema, tsFileVariableSchema]);
const tsHtmlTemplateSchema = z.object({
    filename: z.string(),
    destination: z.string(),
    variables: z.array(tsVariableSchema).optional()
}).strict();
const tsJsTemplateSchema = z.object({
    filename: z.string(),
    destination: z.string(),
    output: z.enum(['esm', 'cjs'])
}).strict();
const tsCopySchema = z.object({
    destination: z.string(),
    files: z.array(z.string()),
    clean: z.boolean().optional()
}).strict();
export const tsBuildItemSchema = z.object({
    target: z.string(),
    tsConfig: z.string(),
    name: z.string().optional(),
    prefix: z.string().optional(),
    minify: tsMinifySchema.optional(),
    copy: z.array(tsCopySchema).optional(),
    templatesHtml: z.array(tsHtmlTemplateSchema).optional(),
    templatesJs: z.array(tsJsTemplateSchema).optional()
}).strict();
const tsBuildConfigSchema = z.array(tsBuildItemSchema).superRefine((items, ctx) => {
    const seenTargets = new Set();
    const cL1 = items.length;
    for (let iL1 = 0; iL1 < cL1; iL1++) {
        const target = items[iL1].target;
        if (seenTargets.has(target)) {
            ctx.addIssue({
                code: 'custom',
                path: [iL1, 'target'],
                message: `Duplicate target "${target}"`
            });
        }
        else {
            seenTargets.add(target);
        }
    }
});
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
    static async minify(absPath, useTerser, useTerserCompanion, terserOptions = defaultTerserOptions) {
        let returnValue = false;
        if (useTerser || useTerserCompanion) {
            const source = await readFile(absPath, 'utf8');
            const parsedPath = path.parse(absPath);
            const outPath = path.join(parsedPath.dir, `${parsedPath.name}.min${parsedPath.ext}`);
            const compressed = [source, Buffer.byteLength(source, 'utf8')];
            ZeptoLogger.instance.log(LogLevel.INFO, `[MINIFY] Size> Original       : ${compressed[1]}`);
            if (useTerser) {
                const tmpValue = await minify(source, {
                    module: terserOptions.module ?? defaultTerserOptions.module,
                    toplevel: terserOptions.toplevel ?? false,
                    compress: { defaults: true, passes: 2 },
                    mangle: (false === terserOptions.mangle)
                        ? false
                        : { properties: { regex: RegExp(('string' === typeof terserOptions.mangle) ? terserOptions.mangle : defaultManglePattern) } }
                });
                if (tmpValue.code) {
                    const tmpLength = Buffer.byteLength(tmpValue.code, 'utf8');
                    ZeptoLogger.instance.log(LogLevel.INFO, `[MINIFY] Size> Terser         : ${tmpLength}`);
                    if (tmpLength < compressed[1]) {
                        compressed[0] = tmpValue.code;
                        compressed[1] = tmpLength;
                    }
                }
            }
            if (useTerserCompanion) {
                const tmpValue = terserCompanion(compressed[0]);
                const tmpLength = Buffer.byteLength(tmpValue, 'utf8');
                ZeptoLogger.instance.log(LogLevel.INFO, `[MINIFY] Size> TerserCompanion: ${tmpLength}`);
                if (tmpLength < compressed[1]) {
                    compressed[0] = tmpValue;
                    compressed[1] = tmpLength;
                }
            }
            ZeptoLogger.instance.log(LogLevel.INFO, `[MINIFY] Size> Output         : ${compressed[1]}`);
            if (compressed[0] != source) {
                await writeFile(outPath, compressed[0]);
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
    static _formatIssueLines(issue, parentPath) {
        const returnValue = [];
        const issuePath = [...parentPath, ...issue.path];
        if (('invalid_union' === issue.code) && (0 < issue.errors.length)) {
            const branchSpecific = issue.errors.map((branchErrors) => branchErrors.some((branchIssue) => ('unrecognized_keys' === branchIssue.code) || (0 < branchIssue.path.length)));
            const hasSpecificBranch = branchSpecific.includes(true);
            const cL1 = issue.errors.length;
            for (let iL1 = 0; iL1 < cL1; iL1++) {
                if (!hasSpecificBranch || branchSpecific[iL1]) {
                    const cL2 = issue.errors[iL1].length;
                    for (let iL2 = 0; iL2 < cL2; iL2++) {
                        returnValue.push(...TsBuild._formatIssueLines(issue.errors[iL1][iL2], issuePath));
                    }
                }
            }
        }
        else {
            let formattedPath = '';
            const cL1 = issuePath.length;
            for (let iL1 = 0; iL1 < cL1; iL1++) {
                const segment = issuePath[iL1];
                if ('number' === typeof segment) {
                    formattedPath += `[${segment}]`;
                }
                else {
                    formattedPath += `.${segment}`;
                }
            }
            if ('unrecognized_keys' === issue.code) {
                const cL2 = issue.keys.length;
                for (let iL2 = 0; iL2 < cL2; iL2++) {
                    const key = issue.keys[iL2];
                    const keyPath = `${formattedPath}.${key}`;
                    returnValue.push(`${keyPath}: Unrecognized key: ${JSON.stringify(key)}`);
                }
            }
            else {
                const leafLabel = formattedPath ? formattedPath : '(root)';
                returnValue.push(`${leafLabel}: ${issue.message}`);
            }
        }
        return returnValue;
    }
    static async _hashFile(variableType, algorithm, absSource) {
        let returnValue = '';
        if (getHashes().includes(algorithm)) {
            const contents = await readFile(absSource);
            returnValue = createHash(algorithm).update(contents).digest('hex');
        }
        else {
            throw new Error(`Hash algorithm "${algorithm}" is unavailable for variable type "${variableType}"`);
        }
        return returnValue;
    }
    static _formatTupleToken(source, prefix, token) {
        let returnValue = '';
        const converted = prefix.replace(/\\/g, '/');
        const stripped = converted.replace(/\/+$/, '');
        const normalizedPrefix = ('' === stripped) ? ((converted.startsWith('/')) ? '/' : '') : stripped;
        const basename = path.basename(source);
        if ('' === normalizedPrefix) {
            returnValue = `${basename}?${token}`;
        }
        else if ('/' === normalizedPrefix) {
            returnValue = `/${basename}?${token}`;
        }
        else {
            returnValue = `${normalizedPrefix}/${basename}?${token}`;
        }
        return returnValue;
    }
    static _resolveTerserConfig(terser, moduleDefault) {
        let returnValue;
        const options = { module: moduleDefault };
        if ('boolean' === typeof terser) {
            returnValue = { enabled: terser, options };
        }
        else if (undefined !== terser) {
            if (undefined !== terser.module) {
                options.module = terser.module;
            }
            if (undefined !== terser.toplevel) {
                options.toplevel = terser.toplevel;
            }
            if (undefined !== terser.mangle) {
                options.mangle = terser.mangle;
            }
            returnValue = { enabled: terser.enabled ?? true, options };
        }
        else {
            returnValue = { enabled: true, options };
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
        let minifyPlan;
        if (buildItem.minify) {
            const terserResolved = TsBuild._resolveTerserConfig(buildItem.minify.terser, true);
            minifyPlan = {
                enabled: terserResolved.enabled,
                options: terserResolved.options,
                useTerserCompanion: buildItem.minify.terserCompanion ?? true,
                files: buildItem.minify.files
            };
        }
        ZeptoLogger.instance.log(LogLevel.INFO, `[${targetLabel}] Compiling TypeScript...`);
        TsBuild.compile(absConfig);
        if (buildItem.templatesJs) {
            const cL1 = buildItem.templatesJs.length;
            for (let iL1 = 0; iL1 < cL1; iL1++) {
                const template = buildItem.templatesJs[iL1];
                const absTemplate = path.resolve(targetDirectory, template.filename);
                const absDestination = path.resolve(this._configDirectory, template.destination);
                const templateSource = await readFile(absTemplate, 'utf8');
                const compiled = new jTDAL().CompileToString(templateSource);
                const moduleSource = ('esm' === template.output) ? `export default ${compiled}` : `module.exports = ${compiled};`;
                const parsedPath = path.parse(absTemplate);
                const outputName = ('esm' === template.output) ? `${parsedPath.name}.mjs` : `${parsedPath.name}.cjs`;
                await mkdir(absDestination, { recursive: true });
                await writeFile(path.resolve(absDestination, outputName), moduleSource, 'utf8');
            }
        }
        if (minifyPlan && (minifyPlan.enabled || minifyPlan.useTerserCompanion)) {
            const cL1 = minifyPlan.files.length;
            for (let iL1 = 0; iL1 < cL1; iL1++) {
                const absFile = path.resolve(targetDirectory, minifyPlan.files[iL1]);
                ZeptoLogger.instance.log(LogLevel.INFO, `[${targetLabel}] Minifying ${path.relative(this._configDirectory, absFile)}...`);
                await TsBuild.minify(absFile, minifyPlan.enabled, minifyPlan.useTerserCompanion, minifyPlan.options);
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
        if (buildItem.templatesHtml) {
            const cL1 = buildItem.templatesHtml.length;
            for (let iL1 = 0; iL1 < cL1; iL1++) {
                const template = buildItem.templatesHtml[iL1];
                const absTemplate = path.resolve(targetDirectory, template.filename);
                const absDestination = path.resolve(this._configDirectory, template.destination);
                const variables = {};
                const templateVariables = template.variables ?? [];
                const cL2 = templateVariables.length;
                for (let iL2 = 0; iL2 < cL2; iL2++) {
                    const variable = templateVariables[iL2];
                    switch (variable.type) {
                        case 'string': {
                            variables[variable.name] = variable.value;
                            break;
                        }
                        case 'mtime': {
                            if ('string' === typeof variable.value) {
                                variables[variable.name] = (await stat(path.resolve(targetDirectory, variable.value))).mtime.getTime();
                            }
                            else {
                                const sourcePath = variable.value[0];
                                const prefix = variable.value[1];
                                const timestamp = (await stat(path.resolve(targetDirectory, sourcePath))).mtime.getTime();
                                variables[variable.name] = TsBuild._formatTupleToken(sourcePath, prefix, timestamp);
                            }
                            break;
                        }
                        case 'hash-sha2-224':
                        case 'hash-sha3-224':
                        case 'hash-blake2s-256': {
                            const algorithm = hashAlgorithmMap[variable.type];
                            if ('string' === typeof variable.value) {
                                variables[variable.name] = await TsBuild._hashFile(variable.type, algorithm, path.resolve(targetDirectory, variable.value));
                            }
                            else {
                                const sourcePath = variable.value[0];
                                const prefix = variable.value[1];
                                const digest = await TsBuild._hashFile(variable.type, algorithm, path.resolve(targetDirectory, sourcePath));
                                variables[variable.name] = TsBuild._formatTupleToken(sourcePath, prefix, digest);
                            }
                            break;
                        }
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
            let parsedConfig;
            try {
                parsedConfig = JSON.parse(content);
            }
            catch (error) {
                throw new Error(`Invalid tsBuild configuration: ${error.message}`);
            }
            const validation = tsBuildConfigSchema.safeParse(parsedConfig);
            if (!validation.success) {
                const issueLines = [];
                const cL1 = validation.error.issues.length;
                for (let iL1 = 0; iL1 < cL1; iL1++) {
                    issueLines.push(...TsBuild._formatIssueLines(validation.error.issues[iL1], []));
                }
                throw new Error(`Invalid tsBuild configuration:\n${issueLines.join('\n')}`);
            }
            const buildItems = validation.data;
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