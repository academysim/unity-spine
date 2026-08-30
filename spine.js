#!/usr/bin/env node
// Unity automation spine.
// Drives the editor headlessly so an agent can compile, test and build without a GUI.
//
//   node spine.js compile              -- compile only, report errors
//   node spine.js run Class.Method     -- execute any static editor method
//   node spine.js build win|webgl      -- produce a player
//   node spine.js testinit             -- install the test framework + a smoke test
//   node spine.js test [edit|play]     -- run the test framework, parse results
//   node spine.js scaffold <name>      -- create a project with the spine installed
//   node spine.js doctor               -- report what is installed and licensed
//
// Flags: --project <path>  --unity <path to Unity.exe>  --timeout <seconds>  --verbose

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const HUB = 'C:\\Program Files\\Unity Hub\\Unity Hub.exe';
const SPINE_DIR = __dirname;

// ---------- args ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const positional = argv.slice(1).filter(a => !a.startsWith('--'));
function flag(name, def = null) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}
const VERBOSE = argv.includes('--verbose');
const TIMEOUT_S = parseInt(flag('timeout', '900'), 10);

// ---------- locating things ----------
function findUnity() {
  const override = flag('unity');
  if (override) return override;
  if (process.env.UNITY_EXE) return process.env.UNITY_EXE;

  // ask the Hub, which is authoritative
  try {
    const r = spawnSync(HUB, ['--', '--headless', 'editors', '-i', '-j'],
      { encoding: 'utf8', timeout: 60000 });
    const m = (r.stdout || '').match(/"location"\s*:\s*"([^"]+)"/g);
    if (m && m.length) {
      const locs = m.map(x => x.match(/"location"\s*:\s*"([^"]+)"/)[1].replace(/\\\\/g, '\\'));
      locs.sort().reverse();               // newest version first
      if (fs.existsSync(locs[0])) return locs[0];
    }
  } catch { /* fall through */ }

  // fall back to scanning the default install root
  const root = 'C:\\Program Files\\Unity\\Hub\\Editor';
  if (fs.existsSync(root)) {
    const vers = fs.readdirSync(root).sort().reverse();
    for (const v of vers) {
      const p = path.join(root, v, 'Editor', 'Unity.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function projectPath() {
  const p = flag('project') || process.env.UNITY_PROJECT || process.cwd();
  return path.resolve(p);
}

// ---------- running the editor ----------
// Always log to a FILE. Writing to stdout interleaves with Unity's own noise and
// truncates unpredictably when the editor is killed.
function runUnity(args, { label = 'unity', timeoutS = TIMEOUT_S } = {}) {
  const unity = findUnity();
  if (!unity) { console.error('FATAL: no Unity editor found. Pass --unity <path>.'); process.exit(2); }

  const logDir = path.join(os.tmpdir(), 'unity-spine');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${label}-${Date.now()}.log`);

  const full = [...args, '-logFile', logFile];
  if (VERBOSE) console.log('> ' + unity + ' ' + full.join(' '));

  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(unity, full, { windowsHide: true });
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch {}
    }, timeoutS * 1000);

    child.on('exit', code => {
      clearTimeout(timer);
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      resolve({ code, killed, log, logFile, seconds: (Date.now() - t0) / 1000 });
    });
    child.on('error', e => {
      clearTimeout(timer);
      resolve({ code: -1, killed, log: 'spawn error: ' + e.message, logFile, seconds: 0 });
    });
  });
}

// ---------- reading the log ----------
// Exit code alone is not trustworthy: a script that throws can still let the editor
// close cleanly. So we cross-check the log and a marker the C# side writes.
// Scraping only for "error CS" misses asmdef, shader, IL2CPP, linker and package
// failures, all of which also break a build. Collect them under one roof.
// Scraping only for "error CS" misses asmdef, shader, IL2CPP, linker and package
// failures, all of which also break a build. Collect them under one roof.
function compileErrors(log) {
  const out = [];
  const push = (o) => { if (!out.some(e => e.key === o.key)) out.push(o); };

  const cs = /(Assets[\\/][^\s:(]+\.cs)\((\d+),(\d+)\):\s*error\s+(CS\d+):\s*(.*)/g;
  let m;
  while ((m = cs.exec(log))) {
    push({ key: m[1] + ":" + m[2] + ":" + m[4], kind: "csharp",
           file: m[1], line: +m[2], col: +m[3], code: m[4], msg: m[5].trim() });
  }

  const others = [
    [/(Assembly has duplicate references:[^\n]*)/g,      "asmdef"],
    [/(Assembly Definition File[^\n]*?has[^\n]*?error[^\n]*)/gi, "asmdef"],
    [/Shader error in '([^']+)':\s*([^\n]*)/g,          "shader"],
    [/(Unable to resolve reference[^\n]*)/g,            "asmdef"],
    [/(Assembly Definition[^\n]*error[^\n]*)/gi,        "asmdef"],
    [/IL2CPP error[^\n]*?:\s*([^\n]*)/g,               "il2cpp"],
    [/\[Package Manager\][^\n]*?error[^\n]*?:\s*([^\n]*)/gi, "package"],
    [/(Build completed with a result of 'Failed'[^\n]*)/g, "build"],
  ];
  for (const pair of others) {
    const re = pair[0], kind = pair[1];
    let x;
    while ((x = re.exec(log))) {
      const msg = String(x[2] || x[1] || "").trim();
      if (!msg) continue;
      push({ key: kind + ":" + msg.slice(0, 90), kind, file: null, line: null, code: kind, msg });
    }
  }
  return out;
}

function unityExceptions(log) {
  const re = /^(?:\w+Exception|Exception):\s*(.*)$/gm;
  const out = [];
  let m;
  while ((m = re.exec(log))) out.push(m[1].trim());
  return [...new Set(out)].slice(0, 10);
}

function marker(project, name) {
  const p = path.join(project, name);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { raw: fs.readFileSync(p, 'utf8') }; }
}

function report(res, project, { markerFile = null } = {}) {
  const errs = compileErrors(res.log);
  // Unity prints this summary even when the specific diagnostic is in a form we did not
  // match. Never report "no compile errors" when the editor said otherwise.
  if (!errs.length && /Scripts have compiler errors\./.test(res.log)) {
    errs.push({ key: 'summary', kind: 'compile', file: null, line: null, code: 'compile',
                msg: 'Unity reported "Scripts have compiler errors." - see the log for the diagnostic' });
  }
  const exs = unityExceptions(res.log);

  if (res.killed) {
    console.error(`TIMEOUT after ${TIMEOUT_S}s - editor killed. Log: ${res.logFile}`);
    return 3;
  }
  if (errs.length) {
    console.error(`COMPILE FAILED - ${errs.length} error(s):\n`);
    for (const e of errs) {
      console.error(e.file
        ? `  ${e.file}:${e.line}:${e.col}  ${e.code}  ${e.msg}`
        : `  [${e.kind}]  ${e.msg}`);
    }
    console.error(`\nLog: ${res.logFile}`);
    return 1;
  }
  if (res.code !== 0) {
    console.error(`Unity exited ${res.code} with no compile errors.`);
    if (exs.length) { console.error('Exceptions seen:'); exs.forEach(e => console.error('  ' + e)); }
    console.error(`Log: ${res.logFile}`);
    return res.code;
  }
  if (markerFile) {
    const m = marker(project, markerFile);
    if (!m) {
      console.error(`Unity exited 0 but never wrote ${markerFile} - the method did not complete.`);
      console.error(`Log: ${res.logFile}`);
      return 4;
    }
    console.log(JSON.stringify(m, null, 2));
  }
  console.log(`OK in ${res.seconds.toFixed(1)}s`);
  return 0;
}


// -runTests on a project with no test framework and no tests does not error - it HANGS.
// Check before spending a timeout on it.
function testPreflight(project) {
  const mfPath = path.join(project, 'Packages', 'manifest.json');
  if (!fs.existsSync(mfPath)) return { ok: false, reason: 'no Packages/manifest.json' };
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  const hasFramework = !!(mf.dependencies && mf.dependencies['com.unity.test-framework']);

  const asmdefs = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.asmdef')) asmdefs.push(p);
    }
  };
  walk(path.join(project, 'Assets'));

  const testAsmdefs = asmdefs.filter(p => {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const refs = JSON.stringify(j.references || []) + JSON.stringify(j.precompiledReferences || []);
      return /test-framework|TestRunner|nunit/i.test(refs);
    } catch { return false; }
  });

  return { ok: hasFramework && testAsmdefs.length > 0, hasFramework,
           testAsmdefs: testAsmdefs.length, mfPath, mf };
}

function addTestFramework(mfPath, mf) {
  mf.dependencies['com.unity.test-framework'] = '1.5.1';
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2) + '\n');
}

// Unity allows exactly one editor per project. Two spine runs racing produce confusing
// half-failures, so take our own lock first rather than letting Unity arbitrate.
function acquireRunLock(project) {
  const dir = path.join(os.tmpdir(), 'unity-spine');
  fs.mkdirSync(dir, { recursive: true });
  const key = Buffer.from(project.toLowerCase()).toString('hex').slice(0, 40);
  const lockPath = path.join(dir, 'run-' + key + '.lock');

  if (fs.existsSync(lockPath)) {
    let stale = true;
    try {
      const prev = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const alive = spawnSync('tasklist', ['/FI', 'PID eq ' + prev.pid], { encoding: 'utf8' });
      stale = !(alive.stdout || '').includes(String(prev.pid));
    } catch (e) { /* unreadable lock is stale */ }
    if (!stale) {
      console.error('Another spine run holds this project. Wait for it, or use --project.');
      process.exit(5);
    }
    try { fs.unlinkSync(lockPath); } catch (e) {}
  }

  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), project }));
  const release = () => { try { fs.unlinkSync(lockPath); } catch (e) {} };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  return release;
}

// A stale lock means a previous editor died holding the project. Unity will refuse to open.
function clearStaleLock(project) {
  const lock = path.join(project, 'Temp', 'UnityLockfile');
  if (!fs.existsSync(lock)) return;
  try {
    fs.closeSync(fs.openSync(lock, 'r+'));   // throws if genuinely held
    fs.unlinkSync(lock);
    if (VERBOSE) console.log('removed stale UnityLockfile');
  } catch {
    console.error('A Unity editor already has this project open. Close it, or pass a different --project.');
    process.exit(5);
  }
}

const BASE = p => ['-batchmode', '-nographics', '-projectPath', p];

// ---------- commands ----------
async function main() {
  const project = projectPath();

  if (cmd === 'doctor') {
    const unity = findUnity();
    console.log('unity exe   :', unity || 'NOT FOUND');
    console.log('project     :', project, fs.existsSync(path.join(project, 'Assets')) ? '(valid)' : '(no Assets/ - not a project)');
    const lic = path.join(process.env.LOCALAPPDATA || '', 'Unity', 'licenses', 'UnityEntitlementLicense.xml');
    console.log('license     :', fs.existsSync(lic) ? 'present' : 'NOT FOUND - editor will refuse batchmode');
    if (unity) {
      const modules = path.join(path.dirname(unity), 'Data', 'PlaybackEngines');
      if (fs.existsSync(modules)) console.log('build targets:', fs.readdirSync(modules).join(', '));
    }
    const spineCs = path.join(project, 'Assets', 'Editor', 'Spine.cs');
    console.log('spine installed in project:', fs.existsSync(spineCs) ? 'yes' : 'no (run: node spine.js install)');
    return 0;
  }

  if (cmd === 'fishnet') {
    const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (!String(git.stdout || '').startsWith('git version')) {
      console.error('git must be on PATH - Unity resolves git package URLs by shelling out to it.');
      return 2;
    }
    const mf = path.join(project, 'Packages', 'manifest.json');
    if (!fs.existsSync(mf)) { console.error('no Packages/manifest.json at ' + project); return 2; }
    const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
    const KEY = 'com.firstgeargames.fishnet';
    const pin = flag('rev');
    j.dependencies[KEY] =
      'https://github.com/FirstGearGames/FishNet.git?path=Assets/FishNet' + (pin ? '#' + pin : '');
    fs.writeFileSync(mf, JSON.stringify(j, null, 2) + '\n');
    console.log('manifest.json now has:\n  "' + KEY + '": "' + j.dependencies[KEY] + '"');
    if (!pin) console.log('note: unpinned. Pass --rev <tag-or-commit> for a reproducible build.');
    console.log('resolving (the first git fetch can take a while)...');
    const res = await runUnity([...BASE(project), '-quit', '-executeMethod', 'Spine.Ping'],
      { label: 'fishnet', timeoutS: Math.max(TIMEOUT_S, 1800) });
    return report(res, project, { markerFile: 'spine-ping.json' });
  }

  if (cmd === 'install') {
    const dest = path.join(project, 'Assets', 'Editor');
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(SPINE_DIR, 'editor', 'Spine.cs'), path.join(dest, 'Spine.cs'));
    console.log('installed Spine.cs -> ' + path.join(dest, 'Spine.cs'));
    return 0;
  }

  if (cmd === 'scaffold') {
    const name = positional[0];
    if (!name) { console.error('usage: spine.js scaffold <name> [--project <parentDir>]'); return 2; }
    const target = path.resolve(flag('project') || process.cwd(), name);
    console.log('creating ' + target + ' ...');
    const res = await runUnity(['-quit', '-batchmode', '-nographics', '-createProject', target],
      { label: 'scaffold', timeoutS: 900 });
    if (res.code !== 0) { console.error('createProject failed. Log: ' + res.logFile); return res.code; }
    const dest = path.join(target, 'Assets', 'Editor');
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(SPINE_DIR, 'editor', 'Spine.cs'), path.join(dest, 'Spine.cs'));
    console.log('project created and spine installed.');
    console.log('next: node spine.js compile --project "' + target + '"');
    return 0;
  }

  acquireRunLock(project);
  clearStaleLock(project);

  if (cmd === 'compile') {
    const res = await runUnity([...BASE(project), '-quit', '-executeMethod', 'Spine.Ping'],
      { label: 'compile' });
    return report(res, project, { markerFile: 'spine-ping.json' });
  }

  if (cmd === 'run') {
    const method = positional[0];
    if (!method) { console.error('usage: spine.js run <Class.Method>'); return 2; }
    const res = await runUnity([...BASE(project), '-quit', '-executeMethod', method], { label: 'run' });
    return report(res, project);
  }

  if (cmd === 'build') {
    const target = (positional[0] || 'win').toLowerCase();
    if (!['win', 'webgl'].includes(target)) { console.error('build target must be win or webgl'); return 2; }
    const method = target === 'win' ? 'Spine.BuildWindows' : 'Spine.BuildWebGL';
    // Unity documents that switching the active build target inside -executeMethod is
    // unreliable: it can trigger recompilation and a domain reload mid-method. Set the
    // target on the command line and use one process per target instead.
    const unityTarget = target === 'win' ? 'Win64' : 'WebGL';
    console.log(`building ${target} (webgl is slow the first time - IL2CPP has to warm up)...`);
    const res = await runUnity([...BASE(project), '-buildTarget', unityTarget,
      '-quit', '-executeMethod', method],
      { label: 'build-' + target, timeoutS: Math.max(TIMEOUT_S, 3600) });
    return report(res, project, { markerFile: 'spine-build.json' });
  }

  if (cmd === 'testinit') {
    const pre = testPreflight(project);
    if (!pre.mfPath) { console.error('not a Unity project'); return 2; }
    if (!pre.hasFramework) {
      addTestFramework(pre.mfPath, pre.mf);
      console.log('added com.unity.test-framework to manifest.json');
    }

    // Two assemblies, because the platform list is what decides which lane a test
    // belongs to. includePlatforms:["Editor"] is an EditMode assembly; an empty list
    // means every platform, which the runner treats as PlayMode. One asmdef cannot
    // serve both, and a single all-platforms asmdef silently yields "0 tests" in EditMode.
    const asmdef = (name, editorOnly) => JSON.stringify({
      name,
      rootNamespace: '',
      references: ['UnityEngine.TestRunner', 'UnityEditor.TestRunner'],
      includePlatforms: editorOnly ? ['Editor'] : [],
      excludePlatforms: [],
      allowUnsafeCode: false,
      overrideReferences: true,
      precompiledReferences: ['nunit.framework.dll'],
      autoReferenced: false,
      defineConstraints: ['UNITY_INCLUDE_TESTS'],
      versionDefines: [],
      noEngineReferences: false,
    }, null, 2) + '\n';

    const editDir = path.join(project, 'Assets', 'Tests', 'EditMode');
    const playDir = path.join(project, 'Assets', 'Tests', 'PlayMode');
    fs.mkdirSync(editDir, { recursive: true });
    fs.mkdirSync(playDir, { recursive: true });

    fs.writeFileSync(path.join(editDir, 'EditModeTests.asmdef'), asmdef('EditModeTests', true));
    fs.writeFileSync(path.join(playDir, 'PlayModeTests.asmdef'), asmdef('PlayModeTests', false));

    fs.writeFileSync(path.join(editDir, 'EditModeSmokeTests.cs'),
`using NUnit.Framework;

// Runs without entering play mode. Good for pure logic.
public class EditModeSmokeTests
{
    [Test]
    public void Arithmetic_Works()
    {
        Assert.AreEqual(4, 2 + 2);
    }
}
`);

    fs.writeFileSync(path.join(playDir, 'PlayModeSmokeTests.cs'),
`using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

// Runs with the engine ticking. This is the lane that matters for a multiplayer game:
// it is where you can spin up a host, connect clients and let frames actually advance.
public class PlayModeSmokeTests
{
    [Test]
    public void SceneCanCreateObjects()
    {
        var go = new GameObject("probe");
        Assert.IsNotNull(go);
        Object.DestroyImmediate(go);
    }

    [UnityTest]
    public IEnumerator PhysicsAdvancesOverFrames()
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
        go.transform.position = new Vector3(0f, 10f, 0f);
        go.AddComponent<Rigidbody>();
        var startY = go.transform.position.y;

        for (int i = 0; i < 30; i++) yield return new WaitForFixedUpdate();

        Assert.Less(go.transform.position.y, startY, "gravity should have pulled it down");
        Object.Destroy(go);
    }
}
`);
    console.log('created Assets/Tests/EditMode and Assets/Tests/PlayMode with smoke tests');
    console.log('resolving packages...');
    const res = await runUnity([...BASE(project), '-quit', '-executeMethod', 'Spine.Ping'],
      { label: 'testinit', timeoutS: Math.max(TIMEOUT_S, 1200) });
    return report(res, project, { markerFile: 'spine-ping.json' });
  }

  if (cmd === 'test') {
    const pre = testPreflight(project);
    if (!pre.ok) {
      console.error('Cannot run tests - this would hang rather than fail:');
      if (!pre.hasFramework) console.error('  com.unity.test-framework is not in Packages/manifest.json');
      if (!pre.testAsmdefs)  console.error('  no test assembly definition found under Assets/');
      console.error('\nRun:  node spine.js testinit --project "' + project + '"');
      return 2;
    }
    const platform = (positional[0] || 'play').toLowerCase() === 'edit' ? 'EditMode' : 'PlayMode';
    const results = path.join(project, 'spine-tests.xml');
    try { fs.unlinkSync(results); } catch {}
    // note: -runTests must NOT be combined with -quit, or the editor exits before tests finish
    const res = await runUnity([...BASE(project), '-runTests', '-testPlatform', platform,
      '-testResults', results], { label: 'test-' + platform, timeoutS: Math.min(Math.max(TIMEOUT_S, 600), 900) });

    const errs = compileErrors(res.log);
    if (errs.length) return report(res, project);
    if (!fs.existsSync(results)) {
      console.error('The test run did not produce results - it broke rather than failed.');
      console.error('Log: ' + res.logFile);
      return 4;
    }
    const xml = fs.readFileSync(results, 'utf8');
    const g = re => { const m = xml.match(re); return m ? +m[1] : 0; };
    const total = g(/\btotal="(\d+)"/), passed = g(/\bpassed="(\d+)"/);
    const failed = g(/\bfailed="(\d+)"/), skipped = g(/\bskipped="(\d+)"/);
    console.log(`${platform}: ${passed}/${total} passed, ${failed} failed, ${skipped} skipped`);
    if (total === 0) {
      // Codex's classification: zero tests when tests were expected is infrastructure
      // broken, not tests passing. Reporting success here would hide a wiring mistake.
      console.error('\nNo tests were discovered. The run worked, the discovery did not.');
      console.error('Most often the assembly definition platform list is wrong:');
      console.error('  EditMode assembly needs  includePlatforms: ["Editor"]');
      console.error('  PlayMode assembly needs  includePlatforms: []');
      return 4;
    }
    if (failed) {
      const re = /<test-case[^>]*\bname="([^"]+)"[^>]*\bresult="Failed"/g;
      let m; const names = [];
      while ((m = re.exec(xml))) names.push(m[1]);
      names.slice(0, 15).forEach(n => console.error('  FAILED  ' + n));
    }
    console.log('results: ' + results);
    return failed ? 1 : 0;
  }

  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 14).join('\n').replace(/^\/\/ ?/gm, ''));
  return cmd ? 2 : 0;
}

main().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(1); });
