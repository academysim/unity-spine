# Unity automation spine

Drives the Unity editor entirely from a terminal, so an agent can compile, author scenes,
run tests and produce builds with nobody clicking anything.

Verified against Unity **6000.5.10f1** on Windows 11.

## Use

```bash
node spine.js doctor                       # what is installed, licensed, buildable
node spine.js scaffold MyGame              # new project with the spine already in it
node spine.js install --project <path>     # add the spine to an existing project
node spine.js compile --project <path>     # compile, report errors, exit 1 on failure
node spine.js run Spine.NewEmptyScene      # execute any static editor method
node spine.js build win                    # StandaloneWindows64
node spine.js build webgl                  # browser build, no install for playtesters
node spine.js testinit                     # install the test framework + a smoke test
node spine.js test play                    # play-mode tests via the Test Framework
node spine.js fishnet                      # add FishNet to manifest.json and resolve it
```

Flags: `--project <path>`, `--unity <Unity.exe>`, `--timeout <seconds>`, `--verbose`,
and `--rev <tag>` for `fishnet`.

## Exit codes

| code | meaning |
|---|---|
| 0 | success |
| 1 | compile error, failed build, or failing tests |
| 2 | bad usage |
| 3 | timed out, editor was killed |
| 4 | Unity exited 0 but never wrote its result file, or a test run discovered zero tests |
| 5 | another run holds this project |

Code 4 exists because **Unity's exit code lies**. A method that throws, or one that
ignores a failed `BuildReport`, can still let the editor close with status 0. Every
spine method writes a JSON marker before exiting and the driver treats a missing marker
as failure.

## Why it is built this way

Each of these was a real failure mode, not a preference.

**Log to a file, never `-logFile -`.** Piping Unity's log to stdout means that if the
parent stops draining the pipe, Unity blocks on a full buffer and hangs forever. A file
also survives a crash, and `-nographics` requires an explicit log path anyway.

**Set `-buildTarget` on the command line.** Calling `SwitchActiveBuildTarget` inside
`-executeMethod` can trigger a recompile and a domain reload in the middle of your
method, which wipes static state and is documented as unreliable. One process per
target. `Spine.cs` refuses to build if the editor booted on the wrong target rather
than silently producing the wrong artifact.

**One external deadline per run, with a process-tree kill.** Package resolution, a
deadlocked importer, or a play-mode test waiting on a frame that never comes will all
hang indefinitely. Timeouts are reported as code 3, distinct from a failure.

**Our own lock, not Unity's.** Unity permits one editor per project, but discovering
that by collision is slow and produces confusing half-failures. The spine takes a
PID-stamped lock keyed on the project path and detects stale ones.

**Look for more than `error CS`.** Assembly-definition problems, shader errors, IL2CPP
and linker failures, and package resolution errors all break a build and none of them
match that pattern.

**Never `-quit` with `-runTests`.** The test runner owns its own shutdown; adding
`-quit` exits before the tests finish.

**An EditMode and a PlayMode test assembly are not interchangeable.** The platform list
is what decides the lane: `includePlatforms: ["Editor"]` is EditMode, an empty list is
every platform and the runner treats it as PlayMode. A single all-platforms asmdef
compiles fine, contains the tests, and then reports `0/0 passed` in EditMode with no
error at all. `testinit` therefore generates two assemblies under `Assets/Tests/`.

**Zero discovered tests is a failure, not a pass.** A run that executes nothing exits 0
from Unity and looks green. The spine returns code 4 instead, because that state almost
always means the wiring is wrong rather than that there was nothing to do.

**Check before running tests.** `-runTests` against a project with no test framework
and no test assemblies does not report an error - it hangs until the timeout kills it.
That cost 10 minutes to discover. `spine.js test` now refuses in under a second and
tells you to run `testinit`.

## Measured on this machine

| operation | time |
|---|---|
| compile + verify (warm Library) | ~5s |
| Windows build, incremental | ~6s |
| WebGL build, first ever | ~93s |
| EditMode tests | ~40s |
| PlayMode tests | ~60s |
| project creation from nothing | ~2 min |

The 5-second compile is the number that matters: it means the write-compile-read-errors
loop is fast enough to iterate in, which was not obvious before measuring it.

## WebGL notes

The build sets `compressionFormat = Disabled` and `decompressionFallback = true` on
purpose. Compressed WebGL output needs the server to send `Content-Encoding: br` or
`gzip` and `Content-Type: application/wasm`; a plain static host that does not will
serve a build that fails in the browser with no useful error. Uncompressed is larger
and slower to load, and it works anywhere.

Serve the output over HTTP. Opening `index.html` from disk will not work.

## FishNet

`node spine.js fishnet` adds this to `Packages/manifest.json` and resolves it:

```json
"com.firstgeargames.fishnet": "https://github.com/FirstGearGames/FishNet.git?path=Assets/FishNet"
```

Git must be on `PATH` - Unity shells out to it for git package URLs. Pass
`--rev <tag-or-commit>` to pin a version; unpinned means a later run can silently pull
different code. Installing FishNet does **not** install a transport; Steam P2P or
WebSocket transports are separate.
