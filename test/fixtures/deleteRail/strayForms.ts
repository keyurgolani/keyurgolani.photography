/**
 * The delete rail's second positive control (test/deleteRail.test.ts, #181's
 * A10 review item 16): each form the second review found the rail missed.
 * Nothing imports or runs it.
 */

import * as cp from 'node:child_process';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import * as vm from 'node:vm';
import * as workers from 'node:worker_threads';
import { Worker, Worker as NamedWorker } from 'node:worker_threads';
import { Script as VmScript } from 'node:vm';

declare const fse: { remove(dir: string): Promise<void>; removeSync(dir: string): void; emptyDir(dir: string): Promise<void>; emptyDirSync(dir: string): void };

export function viaArrayElement(dir: string): void {
    spawnSync('sh', ['-c', 'rm -rf build/']);
    execFileSync('xargs', ['rm', dir]);
}

export function viaComputedCommand(command: string, args: string[]): void {
    cp.spawn(command, args);
    cp.exec(`${command} --now`);
}

export function viaShellScript(script: string): void {
    spawnSync('bash', ['-c', `${script}`]);
}

export function viaGitAndFind(): void {
    execFileSync('git', ['clean', '-fdx']);
    cp.execSync('git clean -fd');
    spawnSync('find', ['.', '-name', '*.tmp', '-delete']);
}

export async function viaComputedAccess(name: 'rm' | 'unlink', file: string): Promise<void> {
    await fs.promises['unlink'](file);
    const method = fsp[name];
    await method(file);
    const reached = Reflect.get(fs, 'rmSync') as (file: string) => void;
    reached(file);
}

export async function viaExtraNames(dir: string): Promise<void> {
    await fse.remove(dir);
    fse.removeSync(dir);
    await fse.emptyDir(dir);
    fse.emptyDirSync(dir);
}

export class Janitor {
    sweep(file: string): void {
        fs.rmSync(file);
    }
}

// Round 4 (#181's A10 review, items 22 and 24): what the third review found
// the rail still missed, and the forms it can't resolve, which fail it closed.

export function viaGitOptions(dir: string, args: string[]): void {
    cp.execSync(`git -C ${dir} clean -fdx`);
    execFileSync('git', ['-C', dir, 'clean', '-fd']);
    execFileSync('git', args);
}

export function viaInterpreters(args: string[], code: string): void {
    spawnSync('bash', args);
    spawnSync('env', ['FOO=1', 'sh', '-c', code]);
    spawnSync('node', ['-e', code]);
    spawnSync('perl', ['-e', code]);
    spawnSync('python3', ['-c', code]);
    spawnSync('ls', [code], { shell: true });
}

export function viaRmFamily(): void {
    cp.execSync('\\rm -rf build');
    cp.execSync('"rm" -rf build');
    execFileSync('rmdir', ['build']);
    execFileSync('unlink', ['build/x']);
}

export async function viaIndirectProcess(command: string): Promise<void> {
    const { exec } = cp;
    exec(command);
    const loaded = await import('node:child_process');
    loaded.execSync('rm -rf x');
    const run = promisify(cp.exec);
    await run('rm -rf y');
}

export async function viaFsAliases(name: string): Promise<void> {
    const p = fs.promises;
    await p[name as 'rm']('x');
    const { promises } = fs;
    await promises[name as 'rm']('x');
    const { ['rm']: r } = fsp;
    await r('x');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the rail's positive control: a form it must catch
    Reflect.get(require('fs'), name);
}

export async function viaDynamicModule(name: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the rail's positive control: a form it must catch
    require(name);
    await import(name);
    const load = createRequire(import.meta.url);
    load('rimraf/dist/sync');
    createRequire(import.meta.url)('del');
}

export function viaHandOff(hand: (run: (command: string) => unknown) => void): void {
    hand(cp.execSync);
}

// Round 5 (#181's A10 review, item 27): the rail fails closed for real.

declare const disposable: { mkdtempDisposableSync(prefix: string): unknown; mkdtempDisposable(prefix: string): Promise<unknown> };

export function viaQuotedRm(dir: string): void {
    cp.execSync('bash -c "rm -rf build"');
    cp.execSync("eval 'rm -rf build'");
    cp.execSync(`sh -c \`rm -rf ${dir}\``);
}

export function viaProcessElement(name: 'exec'): void {
    cp['execSync']('rm -rf x');
    cp[name]('ls');
}

export function viaBuiltinLoaders(): void {
    process.getBuiltinModule('node:child_process').execSync('rm -rf x');
    module.require('node:child_process').execSync('rm -rf y');
    const load = require;
    load('node:child_process').execSync('rm -rf z');
}

export function viaEscapes(hand: (value: unknown) => void): unknown {
    hand(fs);
    void import('node:fs').then((loaded) => loaded.rmSync('x'));
    const copy = { ...cp };
    const alias: unknown = fsp;
    void copy;
    void alias;
    return fs.promises;
}

export { fsp as exportedFs };

export function viaStdin(): void {
    spawnSync('sh', [], { input: 'rm -rf x' });
    spawnSync('python3', ['script.py']);
}

export function viaOptions(file: string, options: object): void {
    spawnSync('ls', [file], options);
    spawnSync('ls', [file], { ...options });
    const shell = true;
    spawnSync('ls', [file], { shell });
}

export function viaNodeScript(): void {
    spawnSync('node', ['-e', "require('fs').rmSync('x')"]);
    spawnSync('node22', ['-e', 'require("fs").rmSync("x")']);
    spawnSync('node', ['-e', 'console.log(1)']);
}

export function viaInterpreterScripts(): void {
    spawnSync('perl', ['-e', 'print 1']);
    spawnSync('python', ['-c', 'print(1)']);
    spawnSync('python3.12', ['-c', 'print(1)']);
    spawnSync('ruby', ['-e', 'puts 1']);
    spawnSync('bun', ['-e', '1']);
    spawnSync('deno', ['eval', '1']);
}

export function viaEval(code: string): void {
    eval(code);
    void new Function(code);
    void new Worker(code, { eval: true });
}

export function viaMissingControls(name: 'rmSync' | 'unlinkSync', x: string): void {
    const { [name]: anything } = fs;
    void anything;
    spawnSync('sh', ['-c', 'echo "$1"', 'sh', x]);
}

export function viaWrappers(args: string[]): void {
    execFileSync('sudo', ['-u', 'root', 'git', 'clean', '-fd']);
    execFileSync('nice', ['-n', '10', 'git', 'clean', '-fd']);
    execFileSync('timeout', ['5', 'git', 'rm', '-r', 'x']);
    execFileSync('xargs', ['-0', 'git', 'worktree', 'remove']);
    execFileSync('npx', ['--yes', 'rimraf', 'build']);
    execFileSync('env', args);
    execFileSync('sudo', args);
    cp.execSync('npx rimraf build');
}

export async function viaDisposable(): Promise<void> {
    disposable.mkdtempDisposableSync('x');
    await disposable.mkdtempDisposable('y');
}

// Round 6 (#181's A10 review, items 31 and 32): the rail's false negatives.

export function viaReflectProcess(): void {
    Reflect.get(cp, 'execSync');
}

export function viaExecWords(): void {
    cp.execSync('bash -s', { input: 'echo hi' });
    cp.execSync('node -e "require(\'fs\').rmSync(1)"');
    cp.execSync('python -c "print(1)"');
}

export function viaWrapperFlags(): void {
    execFileSync('npx', ['-c', 'echo hi']);
    execFileSync('env', ['-S', 'sh -c "echo hi"']);
    execFileSync('sudo', ['-s']);
    execFileSync('sudo', ['-i']);
    execFileSync('xargs', ['-I', 'rm -rf {}']);
}

export function viaQuotedKeys(file: string): void {
    spawnSync('ls', [file], { 'shell': true });
    void new Worker('x', { 'eval': true });
}

export function viaNamespacedWorker(code: string): void {
    void new workers.Worker(code, { eval: true });
}

export function viaIndirectEval(code: string): void {
    (0, eval)(code);
    globalThis.eval(code);
    window.eval(code);
}

export function viaMoreLoaders(): void {
    process['getBuiltinModule']('node:child_process').execSync('rm -rf a');
    globalThis.process.getBuiltinModule('node:child_process').execSync('rm -rf b');
    process.mainModule?.require('node:child_process').execSync('rm -rf c');
}

export function viaAbsoluteAndAlias(): void {
    execFileSync('/usr/local/bin/rm', ['-rf', 'x']);
    cp.execSync('/usr/local/bin/rm -rf x');
    execFileSync('git', ['config', 'alias.wipe', '!rm -rf .']);
}

export function viaMoreWrappers(): void {
    execFileSync('nohup', ['git', 'clean', '-fd']);
    execFileSync('doas', ['git', 'rm', 'x']);
    execFileSync('busybox', ['rm', '-rf', 'x']);
    execFileSync('npx', ['--yes', 'rm', '-rf', 'x']);
}

export function viaVm(code: string): void {
    vm.runInNewContext(code);
    vm.runInThisContext(code);
    void new vm.Script(code);
}

// Round 7 (#181's A10 review, item 37).

export function viaNestedShellScripts(): void {
    spawnSync('sh', ['-c', "node -e \"require('fs').rmSync('x')\""]);
    spawnSync('bash', ['-c', 'python3 -c "print(1)"']);
    spawnSync('sh', ['-c', 'sh -s']);
    spawnSync('sh', ['-c', '/usr/local/bin/rm -rf x']);
}

export function viaInputStrings(): void {
    spawnSync('ls', [], { input: 'git clean -fdx' });
}

export function viaBareOwner(): void {
    (process as NodeJS.Process).getBuiltinModule('node:child_process').execSync('rm -rf d');
}

export function viaWrapperFlagForms(): void {
    execFileSync('sudo', ['-si']);
    execFileSync('env', ['--split-string=sh -c x']);
    execFileSync('npx', ['--call=echo hi']);
    execFileSync('busybox', ['sh']);
}

export function viaMoreEval(code: string): void {
    globalThis['eval'](code);
    Reflect.get(globalThis, 'eval');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the rail's positive control: a form it must catch
    void new (require('node:worker_threads').Worker)(code, { eval: true });
    const Spawned = workers.Worker;
    void new Spawned(code, { eval: true });
}

export function notFindings(): void {
    class Script {}
    void new Script();
}

// Round 8 (#181's A10 review, item 39): every process call is a finding, so what node --version reopened is closed by rule.
export function nowFindings(): void {
    cp.execSync('node --version');
    spawnSync('node', ['--version']);
}

export function viaNodeB1(x: string): void {
    spawnSync('node', [], { input: "require('fs').rmSync('x')" });
    spawnSync('node', ['--eval=require("fs").rmSync("x")']);
    spawnSync('node', ['-pe', 'require("fs").rmSync("x")']);
    spawnSync('node', ['--import', 'data:text/javascript,1']);
    spawnSync('node', ['-r', '/opt/other/wipe.js', '-e', '1']);
    spawnSync('node', ['/opt/other/wipe.js']);
    spawnSync('node', [x]);
}

// Round 8 (item 41): global, Worker and Script forms.
let g: unknown;

export function viaGlobalForms(n: string): unknown {
    g = globalThis;
    const alias = globalThis;
    return [
        globalThis.globalThis[n as keyof typeof globalThis],
        (globalThis satisfies typeof globalThis)[n as keyof typeof globalThis],
        (<Record<string, unknown>>(globalThis as unknown))[n],
        alias[n as keyof typeof globalThis],
        g,
    ];
}

export function viaWorkerForms(code: string, opts: { eval: boolean }): void {
    const W = workers.Worker;
    void new W(code, opts);
    void new NamedWorker(code);
}

export async function viaVmForms(code: string): Promise<void> {
    void new (await import('node:vm')).Script(code);
    void new (vm as unknown as { default: typeof vm }).default.Script(code);
    void new VmScript(code);
}

/** preview-reader.ts's sharedState, its local renamed, so the entry can't depend on the name `global`. */
const RENAMED_STATE_KEY = Symbol.for('kg.catalog.previewReader');
export function renamedSharedState(): unknown {
    const store = globalThis as typeof globalThis & { [RENAMED_STATE_KEY]?: unknown };
    store[RENAMED_STATE_KEY] ??= {};
    return store[RENAMED_STATE_KEY];
}

export function viaComputedGlobal(name: string): unknown {
    return [globalThis[name as keyof typeof globalThis], (globalThis as unknown as Record<string, unknown>)[name]];
}

// Round 9 (#181's A10 review, item 48): general rules for the forms left.
declare const anything: Record<string, (...args: unknown[]) => unknown>;

export function viaLoaderMembers(): void {
    const proc = process as unknown as Record<string, (...args: unknown[]) => unknown>;
    proc.binding('fs');
    proc['_linkedBinding']('x');
    void (process as unknown as { dlopen: unknown }).dlopen;
    void (process as unknown as { execve: unknown }).execve;
    void anything.getBuiltinModule;
    void anything.createRequire;
    anything._load('fs');
}

export function viaProcessEscapes(hand: (value: unknown) => void): void {
    const p = process;
    const { env } = process;
    hand(process);
    hand(globalThis.process);
    void p;
    void env;
}

export function viaGlobalAliasMembers(): void {
    const g2 = globalThis;
    void g2.process;
    void g2.Function;
}

export function viaConstructor(): void {
    void ({}).constructor.constructor('return 1')();
    void (globalThis as unknown as { Function: (code: string) => unknown }).Function('return 1');
}

export function viaAnyWorker(): void {
    void new Worker('./worker.js');
    void new workers.Worker(new URL('./worker.js', import.meta.url));
}

export function notFindingsEither(): void {
    // Reading process by a member, and typeof process, are not escapes.
    void process.env.HOME;
    void (typeof process === 'undefined');
}
