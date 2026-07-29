import test from 'ava';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { minify } from 'terser';
import terserCompanion from '@stefanobalocco/tersercompanion';
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
    t.true(terserMinSize <= terserSourceSize);
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
test.serial('minify on comments-only .js removes stale .min.js and returns false', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/empty.js');
    const minPath = path.join(ws, 'dist/empty.min.js');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '// just a comment\n/* another one */\n');
    await writeFile(minPath, 'stale content\n');
    const result = await TsBuild.minify(sourcePath, true, false);
    t.false(result);
    t.true(await exists(sourcePath));
    t.is(await readFile(sourcePath, 'utf8'), '// just a comment\n/* another one */\n');
    t.false(await exists(minPath));
});
test.serial('minify with both transforms on comments-only source lets TerserCompanion fall back to original', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/empty.js');
    const minPath = path.join(ws, 'dist/empty.min.js');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '// just a comment\n/* another one */\n');
    const result = await TsBuild.minify(sourcePath, true, true);
    t.true(result);
    t.true(await exists(minPath));
    t.is(await readFile(minPath, 'utf8'), '// just a comment\n/* another one */\n');
    t.is(await readFile(sourcePath, 'utf8'), '// just a comment\n/* another one */\n');
});
test.serial('default copy and templates resolve prefix sources and config-root destinations', async (t) => {
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
    t.true(html.includes(String(mtimeStat.mtimeMs)), 'raw mtimeMs rendered');
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
test.serial('minify on comments-only .js rethrows EISDIR from unlink when output path is a directory', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/dirpath.js');
    const dirPath = path.join(ws, 'dist/dirpath.min.js');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '// just a comment\n');
    await mkdir(dirPath, { recursive: true });
    const error = await t.throwsAsync(async () => TsBuild.minify(sourcePath, true, false));
    t.is(error.code, 'EISDIR');
});
test.serial('minify on absent .min file catches ENOENT from unlink', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/absent.js');
    const minPath = path.join(ws, 'dist/absent.min.js');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '// just a comment\n/* another one */\n');
    const result = await TsBuild.minify(sourcePath, true, false);
    t.false(result);
    t.false(await exists(minPath));
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
