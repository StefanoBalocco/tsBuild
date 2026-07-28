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
    try {
        await stat(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function fileSize(filePath) {
    const stats = await stat(filePath);
    return stats.size;
}
test.after.always(async () => {
    await rm(worksRoot, { recursive: true, force: true });
});
test.serial('fromConfigFile builds one configured target', async (t) => {
    const workspace = await createWorkspace('minimal');
    const builder = await TsBuild.fromConfigFile(path.join(workspace, 'tsBuild.json'));
    const result = await builder.build(new Set(['lib']));
    t.true(result);
    t.true(await exists(path.join(workspace, 'dist/index.js')));
    t.false(await exists(path.join(workspace, 'dist/index.min.js')));
});
test.serial('build runs all configured targets in declaration order', async (t) => {
    const workspace = await createWorkspace('multi');
    const builder = await TsBuild.fromConfigFile(path.join(workspace, 'tsBuild.json'));
    const result = await builder.build(new Set(['all']));
    t.true(result);
    t.true(await exists(path.join(workspace, 'dist/beta.js')));
    t.true(await exists(path.join(workspace, 'dist/alpha.js')));
});
test.serial('build runs multiple explicitly named targets', async (t) => {
    const workspace = await createWorkspace('multi');
    const builder = await TsBuild.fromConfigFile(path.join(workspace, 'tsBuild.json'));
    const result = await builder.build(new Set(['alpha', 'beta']));
    t.true(result);
    t.true(await exists(path.join(workspace, 'dist/alpha.js')));
    t.true(await exists(path.join(workspace, 'dist/beta.js')));
});
test.serial('build runs a selected subset', async (t) => {
    const workspace = await createWorkspace('multi');
    const builder = await TsBuild.fromConfigFile(path.join(workspace, 'tsBuild.json'));
    const result = await builder.build(new Set(['alpha']));
    t.true(result);
    t.true(await exists(path.join(workspace, 'dist/alpha.js')));
    t.false(await exists(path.join(workspace, 'dist/beta.js')));
});
test.serial('build resolves prefix from the configuration file directory', async (t) => {
    const workspace = await createWorkspace('prefixed');
    const builder = await TsBuild.fromConfigFile(path.join(workspace, 'tsBuild.json'));
    const result = await builder.build(new Set(['lib']));
    t.true(result);
    t.true(await exists(path.join(workspace, 'packages/lib/dist/index.js')));
});
test.serial('minify configuration supports all requested modes', async (t) => {
    const terserWorkspace = await createWorkspace('minify');
    const terserBuilder = await TsBuild.fromConfigFile(path.join(terserWorkspace, 'terser.json'));
    const terserResult = await terserBuilder.build(new Set(['lib']));
    t.true(terserResult);
    const terserMinPath = path.join(terserWorkspace, 'dist/index.min.js');
    t.true(await exists(terserMinPath));
    const terserSourceSize = await fileSize(path.join(terserWorkspace, 'dist/index.js'));
    const terserMinSize = await fileSize(terserMinPath);
    t.true(terserMinSize <= terserSourceSize);
    const companionWorkspace = await createWorkspace('minify');
    const companionBuilder = await TsBuild.fromConfigFile(path.join(companionWorkspace, 'companion.json'));
    const companionResult = await companionBuilder.build(new Set(['lib']));
    t.true(companionResult);
    t.true(await exists(path.join(companionWorkspace, 'dist/index.min.js')));
    const defaultWorkspace = await createWorkspace('minify');
    const defaultBuilder = await TsBuild.fromConfigFile(path.join(defaultWorkspace, 'tsBuild.json'));
    const defaultResult = await defaultBuilder.build(new Set(['lib']));
    t.true(defaultResult);
    t.true(await exists(path.join(defaultWorkspace, 'dist/index.min.js')));
    const disabledWorkspace = await createWorkspace('minify');
    const disabledBuilder = await TsBuild.fromConfigFile(path.join(disabledWorkspace, 'disabled.json'));
    const disabledResult = await disabledBuilder.build(new Set(['lib']));
    t.true(disabledResult);
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
test.serial('installed-package bin executes the build with copy and templates', async (t) => {
    const uniqueDir = path.join(worksRoot, `bin_test_${Date.now()}`);
    await mkdir(uniqueDir, { recursive: true });
    const fixtureDir = path.join(uniqueDir, 'fixture');
    await cp(path.join(fixturesRoot, 'post-build'), fixtureDir, { recursive: true });
    const projectRoot = path.resolve(__dirname, '../..');
    const packResult = (await execFileAsync('npm', ['pack', '--pack-destination', uniqueDir, '--json'], { cwd: projectRoot })).stdout;
    const packEntry = JSON.parse(packResult)[0];
    const tarballFilename = packEntry.filename;
    const consumerDir = path.join(uniqueDir, 'consumer');
    await mkdir(consumerDir, { recursive: true });
    await writeFile(path.join(consumerDir, 'package.json'), '{"private":true}\n');
    const tarballPath = path.join(uniqueDir, tarballFilename);
    await execFileAsync('npm', ['install', tarballPath], { cwd: consumerDir });
    const binPath = path.join(consumerDir, 'node_modules/.bin/tsBuild');
    await execFileAsync(binPath, ['-f', path.join(fixtureDir, 'default.json'), 'lib'], { cwd: uniqueDir });
    t.true(await exists(path.join(fixtureDir, 'project/dist/index.js')), 'output project/dist/index.js exists');
    const templatePath = path.join(fixtureDir, 'out/pages/page.html');
    t.true(await exists(templatePath), 'rendered template exists at out/pages/page.html');
    const html = await readFile(templatePath, 'utf8');
    t.true(html.includes('tsBuild template'), 'template variable rendered via published bin');
});
test.serial('minifyFile on .mjs writes sibling .min.mjs and leaves original unchanged', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/lib.mjs');
    const minPath = path.join(ws, 'dist/lib.min.mjs');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, 'export const version = "1.0.0";\n');
    const result = await TsBuild.minifyFile(sourcePath, true, false);
    t.true(result);
    t.true(await exists(minPath));
    const originalContent = await readFile(sourcePath, 'utf8');
    t.is(originalContent, 'export const version = "1.0.0";\n');
});
test.serial('minifyFile on .cjs writes sibling .min.cjs and leaves original unchanged', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/lib.cjs');
    const minPath = path.join(ws, 'dist/lib.min.cjs');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, 'module.exports = { x: 1 };\n');
    const result = await TsBuild.minifyFile(sourcePath, true, false);
    t.true(result);
    t.true(await exists(minPath));
    const originalContent = await readFile(sourcePath, 'utf8');
    t.is(originalContent, 'module.exports = { x: 1 };\n');
});
test.serial('minifyFile on extensionless file writes sibling .min and leaves original unchanged', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/bundle');
    const minPath = path.join(ws, 'dist/bundle.min');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, 'export const version = "1.0.0";\n');
    const result = await TsBuild.minifyFile(sourcePath, true, false);
    t.true(result);
    t.true(await exists(minPath));
    const originalContent = await readFile(sourcePath, 'utf8');
    t.is(originalContent, 'export const version = "1.0.0";\n');
});
test.serial('minifyFile on comments-only .js removes stale .min.js and returns false', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/empty.js');
    const minPath = path.join(ws, 'dist/empty.min.js');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '// just a comment\n/* another one */\n');
    await writeFile(minPath, 'stale content\n');
    const result = await TsBuild.minifyFile(sourcePath, true, false);
    t.false(result);
    t.true(await exists(sourcePath));
    t.is(await readFile(sourcePath, 'utf8'), '// just a comment\n/* another one */\n');
    t.false(await exists(minPath));
});
test.serial('minifyFile with both transforms on comments-only source lets TerserCompanion fall back to original', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/empty.js');
    const minPath = path.join(ws, 'dist/empty.min.js');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '// just a comment\n/* another one */\n');
    const result = await TsBuild.minifyFile(sourcePath, true, true);
    t.true(result);
    t.true(await exists(minPath));
    t.is(await readFile(minPath, 'utf8'), '// just a comment\n/* another one */\n');
    t.is(await readFile(sourcePath, 'utf8'), '// just a comment\n/* another one */\n');
});
test.serial('default copy and templates resolve prefix sources and config-root destinations', async (t) => {
    const workspace = await createWorkspace('post-build');
    await mkdir(path.join(workspace, 'out/assets'), { recursive: true });
    await writeFile(path.join(workspace, 'out/assets/stale.txt'), 'stale');
    const builder = await TsBuild.fromConfigFile(path.join(workspace, 'default.json'));
    const result = await builder.build(new Set(['lib']));
    t.true(result);
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
    const builder = await TsBuild.fromConfigFile(path.join(workspace, 'clean.json'));
    const result = await builder.build(new Set(['lib']));
    t.true(result);
    t.false(await exists(path.join(workspace, 'out/assets/stale.txt')), 'stale.txt removed by clean');
    t.true(await exists(path.join(workspace, 'out/assets/one.txt')), 'one.txt copied after clean');
    t.true(await exists(path.join(workspace, 'out/assets/two.txt')), 'two.txt copied after clean');
});
test.serial('build all targets in declaration order: last target output overwrites previous', async (t) => {
    const workspace = await createWorkspace('target-order');
    const builder = await TsBuild.fromConfigFile(path.join(workspace, 'tsBuild.json'));
    const result = await builder.build(new Set(['all']));
    t.true(result);
    t.true(await exists(path.join(workspace, 'shared/index.js')), 'shared/index.js exists');
    const content = await readFile(path.join(workspace, 'shared/index.js'), 'utf8');
    t.true(content.includes('ALPHA_VERSION'), 'shared/index.js contains alpha marker (last target wins)');
});
test.serial('copy with clean precedes template rendering to same destination', async (t) => {
    const workspace = await createWorkspace('post-build');
    const builder = await TsBuild.fromConfigFile(path.join(workspace, 'ordered.json'));
    const result = await builder.build(new Set(['lib']));
    t.true(result);
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
test.serial('compileTsc throws on malformed tsconfig JSON', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'tsconfig.json'), '{ invalid json }');
    t.throws(() => TsBuild.compileTsc(path.join(ws, 'tsconfig.json')));
});
test.serial('compileTsc throws on type diagnostics', async (t) => {
    const ws = await createWorkspace('minimal');
    await writeFile(path.join(ws, 'src/index.ts'), 'const value: number = \'wrong\';\n');
    t.throws(() => TsBuild.compileTsc(path.join(ws, 'tsconfig.json')));
});
test.serial('minifyFile on comments-only .js rethrows EISDIR from unlink when output path is a directory', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/dirpath.js');
    const dirPath = path.join(ws, 'dist/dirpath.min.js');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '// just a comment\n');
    await mkdir(dirPath, { recursive: true });
    const error = await t.throwsAsync(async () => TsBuild.minifyFile(sourcePath, true, false));
    t.is(error.code, 'EISDIR');
});
test.serial('minifyFile on absent .min file catches ENOENT from unlink', async (t) => {
    const ws = await createWorkspace('minify');
    const sourcePath = path.join(ws, 'dist/absent.js');
    const minPath = path.join(ws, 'dist/absent.min.js');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '// just a comment\n/* another one */\n');
    const result = await TsBuild.minifyFile(sourcePath, true, false);
    t.false(result);
    t.false(await exists(minPath));
});
test.serial('minifyFile picks companion when its output is strictly smaller', async (t) => {
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
    const result = await TsBuild.minifyFile(sourcePath, true, true);
    t.true(result);
    t.true(await exists(minPath));
    const minContent = await readFile(minPath, 'utf8');
    t.is(minContent, companionOutput);
});
test.serial('build returns false for unknown target name', async (t) => {
    const ws = await createWorkspace('minimal');
    const builder = await TsBuild.fromConfigFile(path.join(ws, 'tsBuild.json'));
    const result = await builder.build(new Set(['unknown']));
    t.false(result);
});
test.serial('build returns false for empty target selection', async (t) => {
    const ws = await createWorkspace('minimal');
    const builder = await TsBuild.fromConfigFile(path.join(ws, 'tsBuild.json'));
    const result = await builder.build(new Set());
    t.false(result);
});
test.serial('runCli returns exit code 1 for missing config file', async (t) => {
    const ws = await createWorkspace('minimal');
    const exitCode = await TsBuild.runCli(['-f', path.join(ws, 'missing.json'), 'lib']);
    t.is(exitCode, 1);
});
