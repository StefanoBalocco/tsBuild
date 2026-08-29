#!/usr/bin/env node
import jTDAL from '@stefanobalocco/jtdal';
import terserCompanion from '@stefanobalocco/tersercompanion';
import { LogLevel, ZeptoLogger } from '@stefanobalocco/zeptologger';
import { createHash, getHashes } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
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
export const tsBuildItemSchema = z.object({
    target: z.string(),
    tsConfig: z.string(),
    name: z.string().optional(),
    prefix: z.string().optional(),
    minify: z.object({
        files: z.array(z.string()),
        terser: z.union([
            z.boolean(),
            z.object({
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
            }).strict()
        ]).optional(),
        terserCompanion: z.boolean().optional()
    }).strict().optional(),
    copy: z.array(z.object({
        destination: z.string(),
        files: z.array(z.string()),
        clean: z.boolean().optional()
    }).strict()).optional(),
    templatesHtml: z.array(z.object({
        filename: z.string(),
        destination: z.string(),
        variables: z.array(z.object({
            name: z.string(),
            type: z.string(),
            value: z.union([z.string(), z.tuple([z.string(), z.string()])])
        }).strict()).optional()
    }).strict()).optional(),
    templatesJs: z.array(z.object({
        filename: z.string(),
        destination: z.string(),
        output: z.enum(['esm', 'cjs'])
    }).strict()).optional()
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
    static _hashAlgorithmMap = {
        'hash-sha2-224': ['sha224'],
        'hash-sha3-224': ['sha3-224'],
        'hash-blake2s-256': ['blake2s256'],
        'hash-shake256-64': ['shake256', 8],
        'hash-shake256-96': ['shake256', 12],
        'hash-md5-128': ['md5']
    };
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
    static async minify(file, absPath, useTerser, useTerserCompanion, terserOptions = defaultTerserOptions) {
        let returnValue = false;
        if (useTerser || useTerserCompanion) {
            ZeptoLogger.instance.log(LogLevel.INFO, `[MINIFY] File> ${file}`);
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
                if (undefined !== tmpValue.code) {
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
            await writeFile(outPath, compressed[0]);
            returnValue = true;
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
    static async copy(absDestination, absFiles, clean) {
        if (clean) {
            await rm(absDestination, { recursive: true, force: true });
        }
        await mkdir(absDestination, { recursive: true });
        for (const absFile of absFiles) {
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
            const terserResolved = {
                enabled: true,
                options: {
                    module: true
                }
            };
            if ('boolean' == typeof buildItem.minify.terser) {
                terserResolved.enabled = buildItem.minify.terser;
            }
            else if (buildItem.minify.terser) {
                terserResolved.enabled = buildItem.minify.terser.enabled ?? true;
                if (undefined !== buildItem.minify.terser.module) {
                    terserResolved.options.module = buildItem.minify.terser.module;
                }
                if (undefined !== buildItem.minify.terser.toplevel) {
                    terserResolved.options.toplevel = buildItem.minify.terser.toplevel;
                }
                if (undefined !== buildItem.minify.terser.mangle) {
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
        ZeptoLogger.instance.log(LogLevel.INFO, `[${targetLabel}] Compiling TypeScript...`);
        TsBuild.compile(absConfig);
        if (buildItem.templatesJs) {
            for (const { filename, destination, output } of buildItem.templatesJs) {
                const absTemplate = path.resolve(targetDirectory, filename);
                const absDestination = path.resolve(this._configDirectory, destination);
                const templateSource = await readFile(absTemplate, 'utf8');
                const compiled = new jTDAL().CompileToString(templateSource);
                const moduleSource = ('esm' === output) ? `export default ${compiled}` : `module.exports = ${compiled};`;
                const parsedPath = path.parse(absTemplate);
                const outputName = ('esm' === output) ? `${parsedPath.name}.mjs` : `${parsedPath.name}.cjs`;
                await mkdir(absDestination, { recursive: true });
                await writeFile(path.resolve(absDestination, outputName), moduleSource, 'utf8');
            }
        }
        if (minifyPlan && (minifyPlan.enabled || minifyPlan.useTerserCompanion)) {
            for (const file of minifyPlan.files) {
                const absFile = path.resolve(targetDirectory, file);
                ZeptoLogger.instance.log(LogLevel.INFO, `[${targetLabel}] Minifying ${path.relative(this._configDirectory, absFile)}...`);
                await TsBuild.minify(file, absFile, minifyPlan.enabled, minifyPlan.useTerserCompanion, minifyPlan.options);
            }
        }
        if (buildItem.copy) {
            for (const { destination, files, clean } of buildItem.copy) {
                const absDestination = path.resolve(this._configDirectory, destination);
                const absFiles = [];
                for (const file of files) {
                    absFiles.push(path.resolve(targetDirectory, file));
                }
                await TsBuild.copy(absDestination, absFiles, clean ?? false);
            }
        }
        if (buildItem.templatesHtml) {
            for (const { filename, destination, variables } of buildItem.templatesHtml) {
                const absTemplate = path.resolve(targetDirectory, filename);
                const absDestination = path.resolve(this._configDirectory, destination);
                const variablesResolved = {};
                if (variables) {
                    for (const { name, type, value } of variables) {
                        switch (type) {
                            case 'string': {
                                if ('string' == typeof value) {
                                    variablesResolved[name] = value;
                                }
                                else {
                                    throw new Error(`Unexpected value for variable type "${type}"`);
                                }
                                break;
                            }
                            case 'mtime': {
                                const source = (('string' == typeof value) ? value : value[0]);
                                const mtime = (await stat(path.resolve(targetDirectory, source))).mtime.getTime();
                                const mtimeB64 = Buffer.from(BigInt(mtime).toString(16).padStart(16, '0'), 'hex').toString('base64url');
                                variablesResolved[name] = ('string' == typeof value) ? mtime : TsBuild._formatTupleToken(source, value[1], mtimeB64);
                                break;
                            }
                            case 'hash-sha2-224':
                            case 'hash-sha3-224':
                            case 'hash-blake2s-256':
                            case 'hash-shake256-64':
                            case 'hash-shake256-96':
                            case 'hash-md5-128': {
                                const [algorithm, outputLength] = TsBuild._hashAlgorithmMap[type];
                                if (getHashes().includes(algorithm)) {
                                    const source = path.resolve(targetDirectory, (('string' == typeof value) ? value : value[0]));
                                    const contents = await readFile(source);
                                    const hash = createHash(algorithm, (('undefined' != typeof outputLength) ? { outputLength: outputLength } : undefined));
                                    const digest = hash.update(contents).digest('base64url');
                                    variablesResolved[name] = ('string' == typeof value) ? digest : TsBuild._formatTupleToken(source, value[1], digest);
                                }
                                else {
                                    throw new Error(`Hash algorithm "${algorithm}" is unavailable for variable type "${type}"`);
                                }
                                break;
                            }
                            default: {
                                throw new Error(`Unsupported variable type "${type}"`);
                            }
                        }
                    }
                }
                await TsBuild.templating(absTemplate, absDestination, variablesResolved);
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