import test from 'ava';
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
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(__dirname, '../fixtures');
const worksRoot = path.resolve(__dirname, '../.works');
const cliPath = path.resolve(__dirname, '../../dist/tsBuild.js');
const execFileAsync = promisify(execFile);
let workspaceCounter = 0;
async function createWorkspace(fixtureName) {
    await mkdir(worksRoot, { recursive: true });
    workspaceCounter++;
    const workspace = path.join(worksRoot, `workspace_${workspaceCounter}`);
    await cp(path.join(fixturesRoot, fixtureName), workspace, { recursive: true });
    return workspace;
}
async function exists(filePath) {
    let returnValue;
    try {
        await stat(filePath);
        returnValue = true;
    }
    catch {
        returnValue = false;
    }
    return returnValue;
}
async function fileSize(filePath) {
    const stats = await stat(filePath);
    return stats.size;
}
async function buildItem(workspace, configFile, targetName) {
    const configPath = path.join(workspace, configFile);
    const content = await readFile(configPath, 'utf8');
    const buildItems = JSON.parse(content);
    const builder = new TsBuild(path.dirname(configPath));
    const item = buildItems.find((entry) => entry.target === targetName);
    if (!item) {
        throw new Error(`Target "${targetName}" not found in ${configFile}`);
    }
    await builder.build(item);
}
async function runCliWithCapturedLog(argumentsInput) {
    let returnValue;
    const loggerDestination = ZeptoLogger.instance._destination;
    let capturedOutput = '';
    const collector = new Writable({
        write(chunk, _encoding, callback) {
            capturedOutput += chunk.toString();
            callback();
        }
    });
    ZeptoLogger.instance.destination = collector;
    try {
        const exitCode = await TsBuild.runCli(argumentsInput);
        returnValue = { exitCode, output: capturedOutput };
    }
    finally {
        ZeptoLogger.instance.destination = loggerDestination;
    }
    return returnValue;
}
const abcSha224 = 'Iwl9IjQF2CKGQqR3vaJVsyqtvOS9oLP342ydpw';
const abcSha3_224 = '5kKCTD-M8krQkjTufTx2b8mjpRaNDJStc7Rv3w';
const abcBlake2s256 = 'UIxejDJ8FOLhpyujTutFLzdFiyCe1jopTZmbTIZnWYI';
const abcShake256_64 = 'SDNmYBNgqHc';
const abcShake256_96 = 'SDNmYBNgqHccaGMI';
const abcMd5_128 = 'kAFQmDzST7DWlj99KOF_cg';
async function renderedValue(workspace, relPath, variableName) {
    const html = await readFile(path.join(workspace, relPath), 'utf8');
    const match = html.match(new RegExp(`${variableName}=\\[<span>([^<]*)<\\/span>\\]`));
    if (!match) {
        throw new Error(`Variable "${variableName}" not found in ${relPath}`);
    }
    return match[1];
}
test.after.always(async () => {
    await rm(worksRoot, { recursive: true, force: true });
});
test.serial('build one configured target', async (t) => {
    const workspace = await createWorkspace('minimal');
    await buildItem(workspace, 'tsBuild.json', 'lib');
    t.true(await exists(path.join(workspace, 'dist/index.js')));
    t.false(await exists(path.join(workspace, 'dist/index.min.js')));
});
test.serial('runCli builds all configured targets in declaration order', async (t) => {
    const workspace = await createWorkspace('multi');
    const exitCode = await TsBuild.runCli(['-f', path.join(workspace, 'tsBuild.json'), 'all']);
    t.is(exitCode, 0);
    t.true(await exists(path.join(workspace, 'dist/beta.js')));
    t.true(await exists(path.join(workspace, 'dist/alpha.js')));
});
test.serial('runCli builds multiple explicitly named targets', async (t) => {
    const workspace = await createWorkspace('multi');
    const exitCode = await TsBuild.runCli(['-f', path.join(workspace, 'tsBuild.json'), 'alpha', 'beta']);
    t.is(exitCode, 0);
    t.true(await exists(path.join(workspace, 'dist/alpha.js')));
    t.true(await exists(path.join(workspace, 'dist/beta.js')));
});
test.serial('runCli builds a selected subset', async (t) => {
    const workspace = await createWorkspace('multi');
    const exitCode = await TsBuild.runCli(['-f', path.join(workspace, 'tsBuild.json'), 'alpha']);
    t.is(exitCode, 0);
    t.true(await exists(path.join(workspace, 'dist/alpha.js')));
    t.false(await exists(path.join(workspace, 'dist/beta.js')));
});
test.serial('build resolves prefix from the configuration file directory', async (t) => {
    const workspace = await createWorkspace('prefixed');
    await buildItem(workspace, 'tsBuild.json', 'lib');
    t.true(await exists(path.join(workspace, 'packages/lib/dist/index.js')));
});
test.serial('minify configuration supports all requested modes', async (t) => {
    const terserWorkspace = await createWorkspace('minify');
    await buildItem(terserWorkspace, 'terser.json', 'lib');
    const terserMinPath = path.join(terserWorkspace, 'dist/index.min.js');
    t.true(await exists(terserMinPath));
    const terserSourceSize = await fileSize(path.join(terserWorkspace, 'dist/index.js'));
    const terserMinSize = await fileSize(terserMinPath);
    t.true(terserMinSize < terserSourceSize);
    const companionWorkspace = await createWorkspace('minify');
    await buildItem(companionWorkspace, 'companion.json', 'lib');
    t.true(await exists(path.join(companionWorkspace, 'dist/index.min.js')));
    const defaultWorkspace = await createWorkspace('minify');
    await buildItem(defaultWorkspace, 'tsBuild.json', 'lib');
    t.true(await exists(path.join(defaultWorkspace, 'dist/index.min.js')));
    const disabledWorkspace = await createWorkspace('minify');
    await buildItem(disabledWorkspace, 'disabled.json', 'lib');
    t.false(await exists(path.join(disabledWorkspace, 'dist/index.min.js')));
});
test.serial('runCli reads the default config from the process working directory', async (t) => {
    const workspace = await createWorkspace('minimal');
    await execFileAsync(process.execPath, [cliPath, 'lib'], { cwd: workspace });
    t.true(await exists(path.join(workspace, 'dist/index.js')));
});
test.serial('runCli accepts a custom config path', async (t) => {
    const workspace = await createWorkspace('minimal');
    const exitCode = await TsBuild.runCli(['-f', path.join(workspace, 'custom.json'), 'lib']);
    t.is(exitCode, 0);
    t.true(await exists(path.join(workspace, 'dist/index.js')));
});
test.serial('minify on .mjs writes sibling .min.mjs and leaves original unchanged', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/lib.mjs');
    const minPath = path.join(ws, 'dist/lib.min.mjs');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, 'export const version = "1.0.0";\n');
    const result = await TsBuild.minify(sourcePath, true, false);
    t.true(result);
    t.true(await exists(minPath));
    const originalContent = await readFile(sourcePath, 'utf8');
    t.is(originalContent, 'export const version = "1.0.0";\n');
});
test.serial('minify defaults partial terser options to module mode', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/lib.mjs');
    const minPath = path.join(ws, 'dist/lib.min.mjs');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, 'const unused = "unused";\nexport const version = "1.0.0";\n');
    const result = await TsBuild.minify(sourcePath, true, false, {});
    t.true(result);
    t.true(await exists(minPath));
    const minifiedSource = await readFile(minPath, 'utf8');
    t.false(minifiedSource.includes('unused'));
});
test.serial('minify on .cjs writes sibling .min.cjs and leaves original unchanged', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/lib.cjs');
    const minPath = path.join(ws, 'dist/lib.min.cjs');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, 'module.exports = { x: 1 };\n');
    const result = await TsBuild.minify(sourcePath, true, false);
    t.true(result);
    t.true(await exists(minPath));
    const originalContent = await readFile(sourcePath, 'utf8');
    t.is(originalContent, 'module.exports = { x: 1 };\n');
});
test.serial('minify on extensionless file writes sibling .min and leaves original unchanged', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/bundle');
    const minPath = path.join(ws, 'dist/bundle.min');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, 'export const version = "1.0.0";\n');
    const result = await TsBuild.minify(sourcePath, true, false);
    t.true(result);
    t.true(await exists(minPath));
    const originalContent = await readFile(sourcePath, 'utf8');
    t.is(originalContent, 'export const version = "1.0.0";\n');
});
test.serial('minify on comments-only .js writes an empty .min sibling', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/empty.js');
    const minPath = path.join(ws, 'dist/empty.min.js');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '// just a comment\n/* another one */\n');
    await writeFile(minPath, 'stale content\n');
    const result = await TsBuild.minify(sourcePath, true, false);
    t.true(result);
    t.true(await exists(sourcePath));
    t.is(await readFile(sourcePath, 'utf8'), '// just a comment\n/* another one */\n');
    t.true(await exists(minPath));
    t.is(await readFile(minPath, 'utf8'), '');
});
test.serial('minify with both transforms on comments-only source writes an empty .min sibling', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/empty.js');
    const minPath = path.join(ws, 'dist/empty.min.js');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '// just a comment\n/* another one */\n');
    await writeFile(minPath, 'stale content\n');
    const result = await TsBuild.minify(sourcePath, true, true);
    t.true(result);
    t.is(await readFile(sourcePath, 'utf8'), '// just a comment\n/* another one */\n');
    t.true(await exists(minPath));
    t.is(await readFile(minPath, 'utf8'), '');
});
test.serial('minify writes the .min sibling with the source content when Terser output is larger than source', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/larger.js');
    const minPath = path.join(ws, 'dist/larger.min.js');
    const source = 'console.log(1)';
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, source);
    await writeFile(minPath, 'stale content\n');
    const terserResult = await minify(source, {
        module: true,
        toplevel: false,
        compress: { defaults: true, passes: 2 },
        mangle: { properties: { regex: /^_/ } }
    });
    const terserOutput = terserResult.code ?? '';
    t.true(0 < terserOutput.length);
    t.true(Buffer.byteLength(source, 'utf8') < Buffer.byteLength(terserOutput, 'utf8'));
    const result = await TsBuild.minify(sourcePath, true, false);
    t.true(result);
    t.true(await exists(minPath));
    t.is(await readFile(minPath, 'utf8'), source);
    t.is(await readFile(sourcePath, 'utf8'), source);
});
test.serial('minify selects Terser output by UTF-8 byte length even when it has more characters than the source', async (t) => {
    const workspace = await createWorkspace('minify');
    const sourcePath = path.join(workspace, 'dist/multibyte.js');
    const minPath = path.join(workspace, 'dist/multibyte.min.js');
    const source = '//\u00e9\nconsole.log("A\u2028B");';
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, source);
    const terserResult = await minify(source, {
        module: true,
        toplevel: false,
        compress: { defaults: true, passes: 2 },
        mangle: { properties: { regex: /^_/ } }
    });
    const terserOutput = terserResult.code ?? '';
    t.is(terserOutput, 'console.log("A\\u2028B");');
    t.true(Buffer.byteLength(terserOutput, 'utf8') < Buffer.byteLength(source, 'utf8'));
    t.true(source.length < terserOutput.length);
    t.is(terserCompanion(terserOutput), terserOutput);
    t.is(terserCompanion(source), source);
    const result = await TsBuild.minify(sourcePath, true, true);
    t.true(result);
    t.true(await exists(minPath));
    t.is(await readFile(minPath, 'utf8'), terserOutput);
});
test.serial('minify with no gain still renders the tuple hash from the surviving source', async (t) => {
    const workspace = await createWorkspace('minify-hash-no-gain');
    const sourcePath = path.join(workspace, 'project/assets/no-gain.js');
    const minPath = path.join(workspace, 'project/assets/no-gain.min.js');
    await buildItem(workspace, 'tsBuild.json', 'lib');
    t.true(await exists(sourcePath));
    t.true(await exists(minPath));
    const source = await readFile(sourcePath);
    const expectedDigest = createHash('sha224').update(source).digest('base64url');
    t.is(await renderedValue(workspace, 'out/token.html', 'token'), `assets/no-gain.js?${expectedDigest}`);
});
test.serial('default copy and templatesHtml resolve prefix sources and config-root destinations', async (t) => {
    const workspace = await createWorkspace('post-build');
    await mkdir(path.join(workspace, 'out/assets'), { recursive: true });
    await writeFile(path.join(workspace, 'out/assets/stale.txt'), 'stale');
    await buildItem(workspace, 'default.json', 'lib');
    t.true(await exists(path.join(workspace, 'out/assets/one.txt')), 'one.txt copied');
    t.true(await exists(path.join(workspace, 'out/assets/two.txt')), 'two.txt copied');
    t.true(await exists(path.join(workspace, 'out/assets/stale.txt')), 'stale.txt preserved');
    const templatePath = path.join(workspace, 'out/pages/page.html');
    t.true(await exists(templatePath), 'page.html exists at out/pages/page.html');
    t.false(await exists(path.join(workspace, 'out/pages/templates/page.html')), 'templates/ directory not replicated under out/pages');
    const html = await readFile(templatePath, 'utf8');
    t.true(html.includes('tsBuild template'), 'title variable rendered');
    const mtimeStat = await stat(path.join(workspace, 'project/assets/mtime.txt'));
    t.true(html.includes(String(mtimeStat.mtime.getTime())), 'raw mtime rendered');
});
test.serial('clean copy removes destination then copies files', async (t) => {
    const workspace = await createWorkspace('post-build');
    await mkdir(path.join(workspace, 'out/assets'), { recursive: true });
    await writeFile(path.join(workspace, 'out/assets/stale.txt'), 'stale');
    await buildItem(workspace, 'clean.json', 'lib');
    t.false(await exists(path.join(workspace, 'out/assets/stale.txt')), 'stale.txt removed by clean');
    t.true(await exists(path.join(workspace, 'out/assets/one.txt')), 'one.txt copied after clean');
    t.true(await exists(path.join(workspace, 'out/assets/two.txt')), 'two.txt copied after clean');
});
test.serial('runCli builds all targets in declaration order: last target output overwrites previous', async (t) => {
    const workspace = await createWorkspace('target-order');
    const exitCode = await TsBuild.runCli(['-f', path.join(workspace, 'tsBuild.json'), 'all']);
    t.is(exitCode, 0);
    t.true(await exists(path.join(workspace, 'shared/index.js')), 'shared/index.js exists');
    const content = await readFile(path.join(workspace, 'shared/index.js'), 'utf8');
    t.true(content.includes('ALPHA_VERSION'), 'shared/index.js contains alpha marker (last target wins)');
});
test.serial('copy with clean precedes template rendering to same destination', async (t) => {
    const workspace = await createWorkspace('post-build');
    await buildItem(workspace, 'ordered.json', 'lib');
    t.true(await exists(path.join(workspace, 'ordered/one.txt')), 'one.txt copied to ordered/');
    t.true(await exists(path.join(workspace, 'ordered/page.html')), 'page.html rendered to ordered/');
    const html = await readFile(path.join(workspace, 'ordered/page.html'), 'utf8');
    t.true(html.includes('tsBuild ordered'), 'template variable rendered');
});
test.serial('library import with nonexistent argv[1] does not trigger CLI build', async (t) => {
    const uniqueDir = path.join(worksRoot, `import_test_${Date.now()}`);
    await mkdir(uniqueDir, { recursive: true });
    const helperScript = path.join(uniqueDir, 'import_nonexistent_argv.mjs');
    await writeFile(helperScript, [
        `process.argv = [ process.argv[ 0 ], '/nonexistent/path/to/module.mjs' ];`,
        `await import( ${JSON.stringify(cliPath)} );`,
    ].join('\n'));
    await execFileAsync(process.execPath, [helperScript]);
    t.pass('import with nonexistent argv[1] exits 0 (or promise would reject)');
});
test.serial('compile throws on malformed tsconfig JSON', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsconfig.json'), '{ invalid json }');
    t.throws(() => TsBuild.compile(path.join(ws, 'tsconfig.json')));
});
test.serial('compile throws on type diagnostics', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'src/index.ts'), 'const value: number = \'wrong\';\n');
    t.throws(() => TsBuild.compile(path.join(ws, 'tsconfig.json')));
});
test.serial('minify rethrows EISDIR from writing the .min output when the output path is a directory', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/dirpath.js');
    const dirPath = path.join(ws, 'dist/dirpath.min.js');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '// just a comment\n');
    await mkdir(dirPath, { recursive: true });
    const error = await t.throwsAsync(async () => TsBuild.minify(sourcePath, true, false));
    t.is(error.code, 'EISDIR');
});
test.serial('minify on absent .min file writes the .min sibling', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/absent.js');
    const minPath = path.join(ws, 'dist/absent.min.js');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '// just a comment\n/* another one */\n');
    const result = await TsBuild.minify(sourcePath, true, false);
    t.true(result);
    t.true(await exists(minPath));
});
test.serial('minify on empty .js writes an empty .min sibling and returns true', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/blank.js');
    const minPath = path.join(ws, 'dist/blank.min.js');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '');
    const result = await TsBuild.minify(sourcePath, true, true);
    t.true(result);
    t.true(await exists(minPath));
    t.is(await readFile(minPath, 'utf8'), '');
});
test.serial('minify with Terser only on empty .js writes an empty .min sibling and returns true', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/blank-terser.js');
    const minPath = path.join(ws, 'dist/blank-terser.min.js');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '');
    const result = await TsBuild.minify(sourcePath, true, false);
    t.true(result);
    t.true(await exists(minPath));
    t.is(await readFile(minPath, 'utf8'), '');
});
test.serial('minify with TerserCompanion only on empty .js writes an empty .min sibling and returns true', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/blank-companion.js');
    const minPath = path.join(ws, 'dist/blank-companion.min.js');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '');
    const result = await TsBuild.minify(sourcePath, false, true);
    t.true(result);
    t.true(await exists(minPath));
    t.is(await readFile(minPath, 'utf8'), '');
});
test.serial('minify picks companion when its output is strictly smaller', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/companion-wins.js');
    const minPath = path.join(ws, 'dist/companion-wins.min.js');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, [
        'export function run() {',
        '	console.log( "VERY_LONG_STRING_THAT_APPEARS_MULTIPLE_TIMES_FOR_COMPANION_TO_ALIAS_A" );',
        '	console.log( "VERY_LONG_STRING_THAT_APPEARS_MULTIPLE_TIMES_FOR_COMPANION_TO_ALIAS_A" );',
        '	console.log( "VERY_LONG_STRING_THAT_APPEARS_MULTIPLE_TIMES_FOR_COMPANION_TO_ALIAS_A" );',
        '	console.log( "VERY_LONG_STRING_THAT_APPEARS_MULTIPLE_TIMES_FOR_COMPANION_TO_ALIAS_A" );',
        '	console.log( "VERY_LONG_STRING_THAT_APPEARS_MULTIPLE_TIMES_FOR_COMPANION_TO_ALIAS_A" );',
        '	console.log( "VERY_LONG_STRING_THAT_APPEARS_MULTIPLE_TIMES_FOR_COMPANION_TO_ALIAS_A" );',
        '}',
    ].join('\n'));
    const sourceText = await readFile(sourcePath, 'utf8');
    const terserResult = await minify(sourceText, {
        module: true,
        toplevel: true,
        compress: { defaults: true, passes: 2 },
        mangle: { properties: { regex: /^_/ } }
    });
    const terserOutput = terserResult.code ?? '';
    const companionOutput = terserCompanion(terserOutput);
    const terserSize = Buffer.byteLength(terserOutput, 'utf8');
    const companionSize = Buffer.byteLength(companionOutput, 'utf8');
    t.true(companionSize < terserSize, `expected companion ${companionSize} < terser ${terserSize}`);
    const result = await TsBuild.minify(sourcePath, true, true);
    t.true(result);
    t.true(await exists(minPath));
    const minContent = await readFile(minPath, 'utf8');
    t.is(minContent, companionOutput);
});
test.serial('runCli returns exit code 1 for unknown target name', async (t) => {
    const ws = await createWorkspace('minimal');
    const exitCode = await TsBuild.runCli(['-f', path.join(ws, 'tsBuild.json'), 'unknown']);
    t.is(exitCode, 1);
});
test.serial('runCli returns exit code 1 for empty target selection', async (t) => {
    const ws = await createWorkspace('minimal');
    const exitCode = await TsBuild.runCli(['-f', path.join(ws, 'tsBuild.json')]);
    t.is(exitCode, 1);
});
test.serial('runCli returns exit code 1 for missing config file', async (t) => {
    const ws = await createWorkspace('minimal');
    const exitCode = await TsBuild.runCli(['-f', path.join(ws, 'missing.json'), 'lib']);
    t.is(exitCode, 1);
});
test.serial('runCli rejects configs with unknown nested terser keys', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsBuild.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            minify: {
                files: ['dist/index.js'],
                terser: { enabled: true, unknownKey: true }
            }
        }
    ]));
    const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    const outputLines = result.output.split('\n');
    t.is(result.exitCode, 1);
    t.true(outputLines.includes('[0].minify.terser.unknownKey: Unrecognized key: "unknownKey"'));
    t.false(outputLines.some((line) => line.includes('Invalid input: expected boolean, received object')));
});
test.serial('runCli rejects configs with invalid mangle regex text', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsBuild.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            minify: {
                files: ['dist/index.js'],
                terser: { mangle: '[' }
            }
        }
    ]));
    const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    t.is(result.exitCode, 1);
    t.true(result.output.includes('[0].minify.terser.mangle'));
    t.true(result.output.includes('Invalid regular expression'));
});
test.serial('runCli rejects invalid js-template output enum', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsBuild.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            templatesJs: [
                { filename: 'page.tpl', destination: 'out', output: 'umd' }
            ]
        }
    ]));
    const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    t.is(result.exitCode, 1);
    t.true(result.output.includes('[0].templatesJs[0].output'));
});
test.serial('runCli rejects js-template missing required output', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsBuild.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            templatesJs: [
                { filename: 'page.tpl', destination: 'out' }
            ]
        }
    ]));
    const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    t.is(result.exitCode, 1);
    t.true(result.output.includes('[0].templatesJs[0].output'));
});
const strictSchemaCases = [
    {
        name: 'build item',
        config: { target: 'lib', tsConfig: 'tsconfig.json', unknownBuildField: true },
        expectedLine: '[0].unknownBuildField: Unrecognized key: "unknownBuildField"'
    },
    {
        name: 'build minify',
        config: { target: 'lib', tsConfig: 'tsconfig.json', minify: { files: ['dist/index.js'], unknownMinifyField: true } },
        expectedLine: '[0].minify.unknownMinifyField: Unrecognized key: "unknownMinifyField"'
    },
    {
        name: 'html template',
        config: { target: 'lib', tsConfig: 'tsconfig.json', templatesHtml: [{ filename: 'a.tpl', destination: 'out', unknownTemplateField: true }] },
        expectedLine: '[0].templatesHtml[0].unknownTemplateField: Unrecognized key: "unknownTemplateField"'
    },
    {
        name: 'variable',
        config: { target: 'lib', tsConfig: 'tsconfig.json', templatesHtml: [{ filename: 'a.tpl', destination: 'out', variables: [{ name: 'x', type: 'string', value: 'y', unknownVariableField: true }] }] },
        expectedLine: '[0].templatesHtml[0].variables[0].unknownVariableField: Unrecognized key: "unknownVariableField"'
    },
    {
        name: 'copy',
        config: { target: 'lib', tsConfig: 'tsconfig.json', copy: [{ destination: 'out', files: ['a.txt'], unknownCopyField: true }] },
        expectedLine: '[0].copy[0].unknownCopyField: Unrecognized key: "unknownCopyField"'
    }
];
let strictSchemaCase;
for (strictSchemaCase of strictSchemaCases) {
    test.serial(`runCli rejects unknown key in ${strictSchemaCase.name} object`, async (t) => {
        const ws = await createWorkspace('minimal');
        await writeFile(path.join(ws, 'tsBuild.json'), JSON.stringify([strictSchemaCase.config]));
        const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
        const outputLines = result.output.split('\n');
        t.is(result.exitCode, 1);
        t.true(outputLines.includes(strictSchemaCase.expectedLine));
    });
}
test.serial('runCli rejects legacy templates key as unrecognized', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsBuild.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            templates: [{ filename: 'a.tpl', destination: 'out' }]
        }
    ]));
    const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    const outputLines = result.output.split('\n');
    t.is(result.exitCode, 1);
    t.true(outputLines.includes('[0].templates: Unrecognized key: "templates"'));
});
test.serial('runCli rejects minify inside a templatesJs entry', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsBuild.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            templatesJs: [{ filename: 'a.tpl', destination: 'out', output: 'esm', minify: { terser: true } }]
        }
    ]));
    const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    const outputLines = result.output.split('\n');
    t.is(result.exitCode, 1);
    t.true(outputLines.includes('[0].templatesJs[0].minify: Unrecognized key: "minify"'));
});
test.serial('runCli rejects variables inside a templatesJs entry', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsBuild.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            templatesJs: [{ filename: 'a.tpl', destination: 'out', output: 'esm', variables: [{ name: 'x', type: 'string', value: 'y' }] }]
        }
    ]));
    const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    const outputLines = result.output.split('\n');
    t.is(result.exitCode, 1);
    t.true(outputLines.includes('[0].templatesJs[0].variables: Unrecognized key: "variables"'));
});
test.serial('runCli rejects output inside an templatesHtml entry', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsBuild.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            templatesHtml: [{ filename: 'a.tpl', destination: 'out', output: 'esm' }]
        }
    ]));
    const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    const outputLines = result.output.split('\n');
    t.is(result.exitCode, 1);
    t.true(outputLines.includes('[0].templatesHtml[0].output: Unrecognized key: "output"'));
});
test.serial('runCli rejects minify inside an templatesHtml entry', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsBuild.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            templatesHtml: [{ filename: 'a.tpl', destination: 'out', minify: { terser: true } }]
        }
    ]));
    const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    const outputLines = result.output.split('\n');
    t.is(result.exitCode, 1);
    t.true(outputLines.includes('[0].templatesHtml[0].minify: Unrecognized key: "minify"'));
});
test.serial('runCli reports root config type mismatch as root diagnostic', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsBuild.json'), JSON.stringify({ target: 'lib', tsConfig: 'tsconfig.json' }));
    const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    const outputLines = result.output.split('\n');
    t.is(result.exitCode, 1);
    t.true(outputLines.includes('(root): Invalid input: expected array, received object'));
});
test.serial('runCli rejects configs with duplicate targets', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsBuild.json'), JSON.stringify([
        { target: 'lib', tsConfig: 'tsconfig.json' },
        { target: 'lib', tsConfig: 'tsconfig.json' },
        { target: 'other', tsConfig: 'tsconfig.json' },
        { target: 'lib', tsConfig: 'tsconfig.json' },
        { target: 'other', tsConfig: 'tsconfig.json' }
    ]));
    const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    const outputLines = result.output.split('\n');
    t.is(result.exitCode, 1);
    t.true(outputLines.includes('[1].target: Duplicate target "lib"'));
    t.true(outputLines.includes('[3].target: Duplicate target "lib"'));
    t.true(outputLines.includes('[4].target: Duplicate target "other"'));
});
test.serial('runCli rejects malformed JSON config with validation prefix', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsBuild.json'), '{ invalid json');
    const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    const outputLines = result.output.split('\n');
    t.is(result.exitCode, 1);
    t.true(outputLines.some((line) => line.includes('Invalid tsBuild configuration:')));
});
test.serial('runCli reports every invalid terser object field path', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsBuild.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            minify: {
                files: ['dist/index.js'],
                terser: { mangle: 42, unknownOne: true, unknownTwo: true }
            }
        }
    ]));
    const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    const outputLines = result.output.split('\n');
    t.is(result.exitCode, 1);
    t.true(outputLines.includes('[0].minify.terser.mangle: Invalid input: expected false'));
    t.true(outputLines.includes('[0].minify.terser.mangle: Invalid input: expected string, received number'));
    t.true(outputLines.includes('[0].minify.terser.unknownOne: Unrecognized key: "unknownOne"'));
    t.true(outputLines.includes('[0].minify.terser.unknownTwo: Unrecognized key: "unknownTwo"'));
});
test.serial('object-form terser config minifies with mangle false preserving underscore properties', async (t) => {
    const ws = await createWorkspace('minify');
    await writeFile(path.join(ws, 'src/index.ts'), [
        'const widget = {',
        '	_private: 42,',
        '	render() { return this._private; }',
        '};',
        'console.log( widget.render() );',
    ].join('\n'));
    await writeFile(path.join(ws, 'object.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            minify: {
                files: ['dist/index.js'],
                terser: { enabled: true, module: false, toplevel: false, mangle: false },
                terserCompanion: false
            }
        }
    ]));
    await buildItem(ws, 'object.json', 'lib');
    const minPath = path.join(ws, 'dist/index.min.js');
    t.true(await exists(minPath));
    const minContent = await readFile(minPath, 'utf8');
    t.true(minContent.includes('_private'));
});
test.serial('object-form terser config with enabled false and companion false writes no .min sibling', async (t) => {
    const ws = await createWorkspace('minify');
    await writeFile(path.join(ws, 'object-disabled.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            minify: {
                files: ['dist/index.js'],
                terser: { enabled: false },
                terserCompanion: false
            }
        }
    ]));
    await buildItem(ws, 'object-disabled.json', 'lib');
    t.true(await exists(path.join(ws, 'dist/index.js')));
    t.false(await exists(path.join(ws, 'dist/index.min.js')));
});
test.serial('object-form terser config: toplevel false (the CJS default) retains unused helper, configured mangle regex renames customPrivate', async (t) => {
    const source = [
        'function unusedHelper() { return 42; }',
        'const widget = {',
        '	customPrivate: 1,',
        '	render() { return this.customPrivate; }',
        '};',
        'console.log( widget.render() );',
    ].join('\n');
    const wsRetain = await createWorkspace('minify');
    await mkdir(path.join(wsRetain, 'dist'), { recursive: true });
    await writeFile(path.join(wsRetain, 'dist/script.js'), source);
    await writeFile(path.join(wsRetain, 'retain.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            minify: {
                files: ['dist/script.js'],
                terser: { module: false, toplevel: false, mangle: '^custom' },
                terserCompanion: false
            }
        }
    ]));
    await buildItem(wsRetain, 'retain.json', 'lib');
    const retained = await readFile(path.join(wsRetain, 'dist/script.min.js'), 'utf8');
    t.true(retained.includes('unusedHelper'));
    t.false(retained.includes('customPrivate'));
    const wsDrop = await createWorkspace('minify');
    await mkdir(path.join(wsDrop, 'dist'), { recursive: true });
    await writeFile(path.join(wsDrop, 'dist/script.js'), source);
    await writeFile(path.join(wsDrop, 'drop.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            minify: {
                files: ['dist/script.js'],
                terser: { module: false, toplevel: true, mangle: false },
                terserCompanion: false
            }
        }
    ]));
    await buildItem(wsDrop, 'drop.json', 'lib');
    const dropped = await readFile(path.join(wsDrop, 'dist/script.min.js'), 'utf8');
    t.false(dropped.includes('unusedHelper'));
    t.true(dropped.includes('customPrivate'));
});
test.serial('minify toplevel true drops unused top-level declarations retained by toplevel false', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/toplevel.js');
    const minPath = path.join(ws, 'dist/toplevel.min.js');
    const source = [
        'function unusedHelper() { return 42; }',
        'function used() { return 1; }',
        'console.log( used() );',
    ].join('\n');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, source);
    const retainedResult = await TsBuild.minify(sourcePath, true, false, { module: false, toplevel: false });
    t.true(retainedResult);
    const retained = await readFile(minPath, 'utf8');
    t.true(retained.includes('unusedHelper'));
    const droppedResult = await TsBuild.minify(sourcePath, true, false, { module: false, toplevel: true });
    t.true(droppedResult);
    const dropped = await readFile(minPath, 'utf8');
    t.false(dropped.includes('unusedHelper'));
});
test.serial('esm js-template writes .mjs and renders from runtime data', async (t) => {
    const ws = await createWorkspace('template-output');
    await buildItem(ws, 'esm.json', 'lib');
    const pagePath = path.join(ws, 'out/page.mjs');
    t.true(await exists(pagePath));
    t.false(await exists(path.join(ws, 'out/page.html')));
    t.false(await exists(path.join(ws, 'out/page.min.mjs')));
    const mod = await import(pathToFileURL(pagePath).href);
    const html = mod.default({ title: 'ESM title', stamp: 42 });
    t.true(html.includes('ESM title'));
    t.true(html.includes('42'));
});
test.serial('cjs js-template writes .cjs and renders from runtime data', async (t) => {
    const ws = await createWorkspace('template-output');
    await buildItem(ws, 'cjs.json', 'lib');
    const pagePath = path.join(ws, 'out/page.cjs');
    t.true(await exists(pagePath));
    t.false(await exists(path.join(ws, 'out/page.min.cjs')));
    const require = createRequire(import.meta.url);
    const renderer = require(pagePath);
    const html = renderer({ title: 'CJS title', stamp: 7 });
    t.true(html.includes('CJS title'));
    t.true(html.includes('7'));
});
test.serial('templatesJs generate modules before global minify', async (t) => {
    const ws = await createWorkspace('template-output');
    await buildItem(ws, 'minify.json', 'lib');
    const pagePath = path.join(ws, 'out/page.mjs');
    const minPath = path.join(ws, 'out/page.min.mjs');
    t.true(await exists(pagePath));
    t.true(await exists(minPath));
    const mod = await import(pathToFileURL(minPath).href);
    const html = mod.default({ title: 'minified', stamp: 1 });
    t.true(html.includes('minified'));
});
test.serial('extensionless esm js-template writes name.mjs', async (t) => {
    const ws = await createWorkspace('template-output');
    await buildItem(ws, 'extensionless.json', 'lib');
    const pagePath = path.join(ws, 'out/plain.mjs');
    t.true(await exists(pagePath));
    const mod = await import(pathToFileURL(pagePath).href);
    t.true(mod.default({ title: 'plain', stamp: 1 }).includes('plain'));
});
test.serial('html template without variables renders basename with empty data', async (t) => {
    const ws = await createWorkspace('template-output');
    await buildItem(ws, 'html.json', 'lib');
    const pagePath = path.join(ws, 'out/page.html');
    t.true(await exists(pagePath));
    t.false(await exists(path.join(ws, 'out/page.min.html')));
    const html = await readFile(pagePath, 'utf8');
    t.true(html.includes('<h1></h1>'));
});
test.serial('direct hash variables render unpadded base64url digests of source raw bytes', async (t) => {
    const ws = await createWorkspace('hash-variables');
    await buildItem(ws, 'tsBuild.json', 'lib');
    t.is(await renderedValue(ws, 'out/page.html', 'hash_sha2'), abcSha224);
    t.is(await renderedValue(ws, 'out/page.html', 'hash_sha3'), abcSha3_224);
    t.is(await renderedValue(ws, 'out/page.html', 'hash_blake2s'), abcBlake2s256);
    t.is(await renderedValue(ws, 'out/page.html', 'hash_shake64'), abcShake256_64);
    t.is(await renderedValue(ws, 'out/page.html', 'hash_shake96'), abcShake256_96);
    t.is(await renderedValue(ws, 'out/page.html', 'hash_md5'), abcMd5_128);
    t.is(abcShake256_64.length, 11);
    t.is(abcShake256_96.length, 16);
    t.is(abcMd5_128.length, 22);
    const base64urlAlphabet = /^[A-Za-z0-9_-]+$/;
    t.true(base64urlAlphabet.test(abcShake256_64));
    t.true(base64urlAlphabet.test(abcShake256_96));
    t.true(base64urlAlphabet.test(abcMd5_128));
});
test.serial('direct hash variable digests raw bytes of a binary source', async (t) => {
    const ws = await createWorkspace('hash-variables');
    await buildItem(ws, 'tsBuild.json', 'lib');
    const binaryBuffer = await readFile(path.join(ws, 'project/assets/binary.bin'));
    const expectedDigest = createHash('sha224').update(binaryBuffer).digest('base64url');
    t.is(await renderedValue(ws, 'out/page.html', 'hash_binary'), expectedDigest);
});
test.serial('string-form mtime renders the whole-millisecond mtime', async (t) => {
    const ws = await createWorkspace('hash-variables');
    await buildItem(ws, 'tsBuild.json', 'lib');
    const abcStat = await stat(path.join(ws, 'project/assets/abc'));
    t.is(await renderedValue(ws, 'out/page.html', 'mtime_string'), String(abcStat.mtime.getTime()));
});
test.serial('tuple-form mtime renders prefix/basename?mtime', async (t) => {
    const ws = await createWorkspace('hash-variables');
    await buildItem(ws, 'tsBuild.json', 'lib');
    const abcStat = await stat(path.join(ws, 'project/assets/abc'));
    const mtimeB64 = Buffer.from(BigInt(abcStat.mtime.getTime()).toString(16).padStart(16, '0'), 'hex').toString('base64url');
    t.is(await renderedValue(ws, 'out/page.html', 'mtime_tuple'), `this/is/a/prefix/abc?${mtimeB64}`);
});
test.serial('tuple-form mtime with an empty prefix renders basename?mtime', async (t) => {
    const ws = await createWorkspace('hash-variables');
    await buildItem(ws, 'tsBuild.json', 'lib');
    const abcStat = await stat(path.join(ws, 'project/assets/abc'));
    const mtimeB64 = Buffer.from(BigInt(abcStat.mtime.getTime()).toString(16).padStart(16, '0'), 'hex').toString('base64url');
    t.is(await renderedValue(ws, 'out/page.html', 'mtime_tuple_empty'), `abc?${mtimeB64}`);
});
test.serial('tuple-form hash renders prefix/basename?digest', async (t) => {
    const ws = await createWorkspace('hash-variables');
    await buildItem(ws, 'tsBuild.json', 'lib');
    t.is(await renderedValue(ws, 'out/page.html', 'hash_tuple_sha3'), `this/is/a/prefix/abc?${abcSha3_224}`);
});
test.serial('tuple-form hash with an empty prefix renders basename?digest', async (t) => {
    const ws = await createWorkspace('hash-variables');
    await buildItem(ws, 'tsBuild.json', 'lib');
    t.is(await renderedValue(ws, 'out/page.html', 'hash_tuple_empty'), `abc?${abcSha224}`);
});
test.serial('tuple output is based on the target-relative source, not the output prefix path', async (t) => {
    const ws = await createWorkspace('hash-variables');
    await buildItem(ws, 'tsBuild.json', 'lib');
    const binaryBuffer = await readFile(path.join(ws, 'project/assets/binary.bin'));
    const expectedDigest = createHash('sha224').update(binaryBuffer).digest('base64url');
    t.is(await renderedValue(ws, 'out/page.html', 'hash_tuple_binary'), `this/is/a/prefix/binary.bin?${expectedDigest}`);
});
test.serial('tuple output prefix preserves a leading slash and strips trailing slashes', async (t) => {
    const ws = await createWorkspace('hash-variables');
    await buildItem(ws, 'leading.json', 'lib');
    await buildItem(ws, 'trailing.json', 'lib');
    t.is(await renderedValue(ws, 'out/leading/token.html', 'token'), `/assets/abc?${abcBlake2s256}`);
    t.is(await renderedValue(ws, 'out/trailing/token.html', 'token'), `this/is/a/prefix/abc?${abcSha224}`);
});
test.serial('tuple output prefix converts backslashes to forward slashes', async (t) => {
    const ws = await createWorkspace('hash-variables');
    await buildItem(ws, 'backslash.json', 'lib');
    t.is(await renderedValue(ws, 'out/backslash/token.html', 'token'), `this/is/a/prefix/abc?${abcSha224}`);
});
test.serial('tuple-form sha2 hash renders prefix/basename?digest', async (t) => {
    const ws = await createWorkspace('hash-variables');
    await buildItem(ws, 'tsBuild.json', 'lib');
    t.is(await renderedValue(ws, 'out/page.html', 'hash_tuple_sha2'), `this/is/a/prefix/abc?${abcSha224}`);
});
test.serial('tuple-form blake2s hash renders prefix/basename?digest', async (t) => {
    const ws = await createWorkspace('hash-variables');
    await buildItem(ws, 'tsBuild.json', 'lib');
    t.is(await renderedValue(ws, 'out/page.html', 'hash_tuple_blake2s'), `this/is/a/prefix/abc?${abcBlake2s256}`);
});
test.serial('tuple-form shake256-64 hash renders prefix/basename?digest', async (t) => {
    const ws = await createWorkspace('hash-variables');
    await buildItem(ws, 'tsBuild.json', 'lib');
    t.is(await renderedValue(ws, 'out/page.html', 'hash_tuple_shake64'), `this/is/a/prefix/abc?${abcShake256_64}`);
});
test.serial('tuple-form shake256-96 hash renders prefix/basename?digest', async (t) => {
    const ws = await createWorkspace('hash-variables');
    await buildItem(ws, 'tsBuild.json', 'lib');
    t.is(await renderedValue(ws, 'out/page.html', 'hash_tuple_shake96'), `this/is/a/prefix/abc?${abcShake256_96}`);
});
test.serial('tuple-form md5 hash renders prefix/basename?digest', async (t) => {
    const ws = await createWorkspace('hash-variables');
    await buildItem(ws, 'tsBuild.json', 'lib');
    t.is(await renderedValue(ws, 'out/page.html', 'hash_tuple_md5'), `this/is/a/prefix/abc?${abcMd5_128}`);
});
test.serial('tuple output prefix keeps internal repeated slashes unchanged', async (t) => {
    const ws = await createWorkspace('hash-variables');
    await buildItem(ws, 'repeated.json', 'lib');
    t.is(await renderedValue(ws, 'out/repeated/token.html', 'token'), `assets//current/abc?${abcSha224}`);
});
test.serial('tuple output root prefix renders /basename?TOKEN', async (t) => {
    const ws = await createWorkspace('hash-variables');
    await buildItem(ws, 'root.json', 'lib');
    t.is(await renderedValue(ws, 'out/root/token.html', 'token'), `/abc?${abcSha224}`);
});
test.serial('runCli builds the hash-variables target via the public CLI path', async (t) => {
    const ws = await createWorkspace('hash-variables');
    const exitCode = await TsBuild.runCli(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    t.is(exitCode, 0);
    t.true(await exists(path.join(ws, 'out/page.html')));
});
test.serial('hash variable with missing source propagates the fs ENOENT error', async (t) => {
    const ws = await createWorkspace('hash-variables');
    const error = await t.throwsAsync(async () => buildItem(ws, 'missing.json', 'lib'));
    t.is(error.code, 'ENOENT');
});
test.serial('hash variable reports an unavailable mapped algorithm', async (t) => {
    const ws = await createWorkspace('hash-variables');
    const hashAlgorithmMap = TsBuild._hashAlgorithmMap;
    const originalAlgorithm = hashAlgorithmMap['hash-sha2-224'];
    hashAlgorithmMap['hash-sha2-224'] = ['unavailable-test-hash'];
    try {
        const error = await t.throwsAsync(async () => buildItem(ws, 'tsBuild.json', 'lib'));
        t.is(error.message, 'Hash algorithm "unavailable-test-hash" is unavailable for variable type "hash-sha2-224"');
    }
    finally {
        hashAlgorithmMap['hash-sha2-224'] = originalAlgorithm;
    }
});
test.serial('runCli rejects an unsupported variable type at build time', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsBuild.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            templatesHtml: [{ filename: 'a.tpl', destination: 'out', variables: [{ name: 'x', type: 'bogus', value: 'y' }] }]
        }
    ]));
    const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    t.is(result.exitCode, 1);
    t.true(result.output.includes('Unsupported variable type "bogus"'));
});
test.serial('runCli rejects a tuple value for a string variable at build time', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsBuild.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            templatesHtml: [{ filename: 'a.tpl', destination: 'out', variables: [{ name: 'x', type: 'string', value: ['a', 'b'] }] }]
        }
    ]));
    const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    t.is(result.exitCode, 1);
    t.true(result.output.includes('Unexpected value for variable type "string"'));
});
test.serial('runCli rejects one- and three-element tuples under mtime', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsBuild.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            templatesHtml: [{ filename: 'a.tpl', destination: 'out', variables: [
                        { name: 'x', type: 'mtime', value: ['a'] },
                        { name: 'y', type: 'mtime', value: ['a', 'b', 'c'] }
                    ] }]
        }
    ]));
    const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    const outputLines = result.output.split('\n');
    t.is(result.exitCode, 1);
    t.true(outputLines.some((line) => line.includes('variables[0].value')));
    t.true(outputLines.some((line) => line.includes('variables[1].value')));
});
test.serial('runCli rejects a non-string member in a tuple', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsBuild.json'), JSON.stringify([
        {
            target: 'lib',
            tsConfig: 'tsconfig.json',
            templatesHtml: [{ filename: 'a.tpl', destination: 'out', variables: [{ name: 'x', type: 'mtime', value: ['a', 5] }] }]
        }
    ]));
    const result = await runCliWithCapturedLog(['-f', path.join(ws, 'tsBuild.json'), 'lib']);
    const outputLines = result.output.split('\n');
    t.is(result.exitCode, 1);
    t.true(outputLines.some((line) => line.includes('variables[0].value[1]')));
});
