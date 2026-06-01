# Endform Lambda Playwright Programmatic Runner Plan

## Summary

Endform runs Playwright tests remotely inside AWS Lambda. The current Lambda Runner invokes Playwright through the normal CLI after preparing scratch files, dependencies, proxy state, config rewrites, reporter shims, and environment variables. This works, but it serializes too much startup work and expresses Endform policy through fragile command-line arguments and temporary edits to the user's Playwright config file.

The new target architecture is a per-invocation Node host process that starts as early as possible, imports Playwright, preforks Playwright workers, and later receives a structured `runTests` request from Rust over IPC. The Playwright fork should expose generic programmatic runner primitives. Endform-specific config policy, reporter pipeline construction, generated reporters, and Rust IPC protocol should stay in the Lambda Runner repository, ideally inside an Endform-owned Node host script.

The Playwright fork should not expose Endform-shaped APIs. It should expose a small, stable, Playwright-shaped API that lets an external host load a user config, mutate that config in normal JavaScript, and run selected tests with preforked workers and native Playwright reporting.

## Goals

- Start the Node Playwright host as early as possible in each Lambda invocation.
- Import Playwright and prefork one or more Playwright workers while Rust downloads dependencies, prepares scratch space, starts proxy infrastructure, and computes run parameters.
- Replace CLI argument construction with a typed programmatic `runTests` call.
- Replace temporary mutation of `playwright.config.*` with direct mutation of the raw user config object in the Endform Node host.
- Replace `--test-list=<file>` with structured in-memory test selection.
- Keep reporter execution in the Playwright host process, preserving native Playwright reporter lifecycle and object identity.
- Keep Endform-specific policy out of the Playwright fork where practical.
- Keep the fork surface small enough to carry across multiple Playwright version branches.
- Design the generic pieces so some can plausibly be upstreamed later without bringing Endform-specific behavior with them.

## Non-Goals

- Do not move Playwright native reporters into worker processes.
- Do not make the Playwright fork understand Endform concepts such as suite-control, completion assets, trace upload policy, remote reporters, or test attempt IDs.
- Do not introduce a Playwright-fork-owned config mutation DSL such as `deleteTopLevel`, `mergeUse`, or `reporterPipeline`.
- Do not require the Playwright fork to own the Rust-to-Node IPC protocol.
- Do not remove Chrome launch monkey patching in this phase. Endform can continue using `NODE_OPTIONS` and spawn/fork monkey patches for Chrome flags and related process behavior.
- Do not optimize away runner-side test loading or prewarm browser contexts until the generic prefork/programmatic runner path is measured.

## Current Endform Flow

The current Lambda Runner flow is roughly:

1. Rust receives the Lambda invocation.
2. Rust builds a `PlaywrightController` with middlewares.
3. Controller setup downloads dependent files, creates symlinks, writes env vars, starts proxy infrastructure, creates generated JS reporters, and prepares config overrides.
4. The controller writes a generated config override shim.
5. The controller temporarily edits the user's `playwright.config.*` file so it imports/requires that shim.
6. The controller spawns `node <playwright cli.js> test ...`.
7. Playwright CLI loads the modified config file.
8. Playwright runs tests normally.
9. Generated reporters send observer events back to Rust through a file descriptor transport.
10. Rust waits for Playwright exit, restores the config file, runs teardowns, uploads artifacts, and reports results.

This means Playwright startup begins late, after much of setup has already completed. It also means config policy is expressed partly as CLI flags and partly as generated JavaScript injected into the user's config file.

## Current CLI Arguments To Replace

Endform currently constructs Playwright CLI arguments equivalent to:

```text
node <playwright-cli-path> test
--config=<config>
--retries=0
--workers=1
--max-failures=0
--no-deps
--timeout=<capped timeout>
--update-snapshots=<mode>
--test-list=<generated file>
```

These should become structured parameters to `runTests`:

```ts
await runTests({
  config,
  configLocation,
  configOverrides: {
    retries: 0,
    workers: 1,
    maxFailures: 0,
    timeout,
    updateSnapshots,
  },
  ignoreProjectDependencies: true,
  testSelection,
  workerEnv,
  preforkedWorkers,
  reporter,
});
```

The exact field names can follow Playwright naming, but the important boundary is that these are programmatic run options, not CLI strings.

## Current Config File Mutations To Move Out Of The Fork

Endform currently mutates the loaded config through a generated shim. Examples include:

- Delete top-level `webServer`.
- Delete top-level `globalSetup`.
- Delete top-level `globalTeardown`.
- Delete `use.launchOptions.executablePath` from top-level `use`.
- Delete `use.launchOptions.executablePath` from every project `use`.
- Set top-level and project `outputDir`.
- Set top-level and project `use.trace`.
- Set top-level and project `use.browserName = "chromium"`.
- Set top-level and project `use.defaultBrowserType = "chromium"`.
- Set top-level and project `use.channel = "chromium"`.
- Merge Endform-provided `extraHTTPHeaders` into top-level and project `use.extraHTTPHeaders` with user config taking precedence.
- Rewrite `reporter` to include generated Endform reporters, selected pre-existing user reporters, OTEL reporter, and blob reporter in the correct order.

The Playwright fork should not own a schema for these mutations. Instead, the Lambda Runner's Node host should load the raw user config object and mutate it directly with ordinary JavaScript before passing it to Playwright's new `runTests` export.

Example Endform-owned host logic:

```ts
const config = await loadUserConfig(configLocation);

delete config.webServer;
delete config.globalSetup;
delete config.globalTeardown;

deleteNestedUse(config.use, ['launchOptions', 'executablePath']);
for (const project of config.projects ?? [])
  deleteNestedUse(project.use, ['launchOptions', 'executablePath']);

setOutputDirEverywhere(config, request.outputDir);
setUseEverywhere(config, {
  trace: request.trace,
  browserName: 'chromium',
  defaultBrowserType: 'chromium',
  channel: 'chromium',
});
mergeUseEverywhere(config, 'extraHTTPHeaders', request.extraHTTPHeaders, 'lower');

config.reporter = buildEndformReporterList(config.reporter, request);

await runTests({
  configLocation,
  config,
  configOverrides,
  testSelection,
  reporter,
  preforkedWorkers,
});
```

This keeps Endform's policy close to Endform and avoids coupling the fork to Lambda Runner implementation details.

## Target Architecture

```text
Rust Lambda Runner
  starts Node host early
  continues dependency/scratch/proxy setup
  sends structured run request over IPC
  receives lifecycle/result/timing data

Endform Node Host, owned by Lambda Runner repo
  imports generic Playwright fork exports
  owns Rust-to-Node IPC protocol
  owns Endform config mutation policy
  owns reporter pipeline generation
  owns generated reporter files/modules
  owns mapping Endform test attempts to Playwright structured test selection

Playwright Fork
  exposes generic runTests/loadConfig/prefork APIs
  loads user configs without forcing immediate CLI execution
  accepts an already-mutated config object
  normalizes config into FullConfigInternal
  runs selected tests through normal Playwright dispatcher/worker/reporter flow
  supports preforked delayed-init workers
```

## Proposed Playwright Export

Add a deliberate package export such as:

```json
{
  "exports": {
    "./programmatic-runner": {
      "types": "./programmatic-runner.d.ts",
      "import": "./programmatic-runner.mjs",
      "require": "./programmatic-runner.js",
      "default": "./programmatic-runner.js"
    }
  }
}
```

The exact export name can change. The important part is that consumers do not import `playwright/lib/runner`, `WorkerHost`, `Dispatcher`, or other private internals directly.

The primary exported function can simply be named `runTests`:

```ts
export async function runTests(params: RunTestsParams): Promise<RunTestsResult>;
```

Supporting exports should be generic and minimal:

```ts
export async function loadUserConfig(location: ConfigLocation): Promise<Config>;

export async function createPreforkedWorkers(params: {
  workers: number;
}): Promise<PreforkedWorkers>;

export async function disposePreforkedWorkers(workers: PreforkedWorkers): Promise<void>;
```

If a class is more ergonomic than separate functions, expose a generic host-like object, but keep method names Playwright-shaped:

```ts
const runner = await createRunnerHost({ workers: 1 });
await runner.ready();
await runner.runTests(params);
await runner.stop();
```

Do not expose `WorkerHost` itself.

## Proposed Generic `runTests` Parameters

The run parameters should use Playwright concepts and avoid Endform-specific names:

```ts
type RunTestsParams = {
  configLocation: ConfigLocation;
  config: Config;
  configOverrides?: ConfigCLIOverrides;
  ignoreProjectDependencies?: boolean;
  projectFilter?: string[];
  testSelection?: StructuredTestSelection;
  reporter?: Reporter | Reporter[];
  disableConfigReporters?: boolean;
  preforkedWorkers?: PreforkedWorkers;
  workerEnv?: Record<string, string | undefined>;
  metadata?: Record<string, unknown>;
};
```

Notes:

- `config` is the raw user config object, possibly mutated by the caller before `runTests` receives it.
- `configOverrides` should map to the existing `ConfigCLIOverrides` structure where possible.
- `ignoreProjectDependencies` is the programmatic equivalent of `--no-deps`.
- `reporter` should allow the caller to provide additional in-process reporters without requiring them to exist in `config.reporter`.
- `disableConfigReporters` is useful for tests, but Endform will usually build the desired config reporter list itself and pass it in `config.reporter`.
- `preforkedWorkers` should be an opaque handle, not an array of internal `WorkerHost` instances.

## Structured Test Selection

Endform should move away from generating a `--test-list` file. The Node host should send an in-memory structured test selection to Playwright.

Use whichever shape best matches Playwright's existing test-list implementation and title filtering model. A likely shape is:

```ts
type StructuredTestSelection = {
  tests: StructuredSelectedTest[];
};

type StructuredSelectedTest = {
  projectName?: string;
  file: string;
  titlePath: string[];
};
```

For Endform, `titlePath` should be the test's describe path plus case name:

```ts
{
  projectName: request.projectName,
  file: test.fileName,
  titlePath: [...test.describes, test.caseName],
}
```

The Playwright implementation should internally convert this to the same filtering behavior as the existing test-list code:

- Filter files to only the selected files.
- Filter tests by project and title path.
- Preserve behavior for duplicate titles as strictly as Playwright's current test-list behavior allows.
- Surface useful errors for selected tests that are not found.

This should live as a generic in-memory sibling of the current `testList` file support, not as an Endform-specific selector.

Potential implementation path:

1. Keep existing `loadTestList` file parsing unchanged.
2. Add a new helper that builds the same `{ testFilter, fileFilter }` pair from structured entries.
3. Add `structuredTestSelection?: StructuredTestSelection` to `TestRunOptions`.
4. Apply it in `createLoadTask` at the same point as `testList`.
5. Thread it through the new exported `runTests` API.

## Preforked Worker Support

The current smoke implementation proved this internal flow:

```ts
const worker = new WorkerHost(0);
await worker.prefork();

await testRunner.runTests(reporter, {
  locations: [selectedTestFile],
  projects: [selectedProjectName],
  preforkedWorkers: [worker],
  workerEnv,
});
```

The maintained implementation should hide this behind an opaque prefork handle:

```ts
const preforkedWorkers = await createPreforkedWorkers({ workers: 1 });

await runTests({
  configLocation,
  config,
  preforkedWorkers,
  testSelection,
});
```

Required internal Playwright changes remain:

- Split process startup from runner initialization in `ProcessHost`.
- Allow `WorkerHost` to start without a `TestGroup` and initialize later.
- Allow `Dispatcher` to consume preforked delayed-init workers.
- Ensure preforked workers are leased safely across phases and not reused incompatibly.

Avoid leaking these classes across the public export boundary.

## Reporter Pipeline Ownership

Reporter pipeline construction should stay in the Endform Node host.

The Playwright fork should only need to support normal Playwright reporter declarations and optional direct reporter objects passed to `runTests`. Endform can continue to generate reporter modules on disk where that is the lowest-risk approach.

The Endform Node host owns logic such as:

- Preserve selected user reporters from the original user config.
- Drop unapproved user reporters.
- Inject a synchronous test-property reporter before blob reporter.
- Inject observer reporters that write events to the Rust-side reporter runtime transport.
- Inject `playwright-opentelemetry` with options when configured.
- Inject blob reporter for completion assets.

This can be implemented by setting the mutated raw config's `reporter` field before calling Playwright:

```ts
config.reporter = [
  [testPropertyReporterPath],
  ...preservedUserReporters,
  [testOutcomeObserverReporterPath],
  [traceObserverReporterPath],
  ...maybeOtelReporter,
  ['blob'],
];
```

The generated observer reporter transport can continue using file descriptor `3` initially. The Endform Node host, not the Playwright fork, should be responsible for opening/owning whatever transport is used between reporter JS and Rust or between reporter JS and the Node host.

## Chrome Flags And Process Monkey Patching

Do not include Chrome flag support in the Playwright fork API for this phase.

Endform can continue using its current generated `NODE_OPTIONS` scripts to monkey patch:

- `child_process.spawn` for Chromium launch flags.
- `child_process.fork` for propagation into Playwright worker processes.
- `worker_threads.Worker` for propagation into worker threads.

This keeps the fork focused on runner orchestration and avoids opening another browser-launch-specific API surface before measurement proves it is needed.

## Endform Node Host Responsibilities

The Lambda Runner repository should add a Node host script/package that imports the Playwright fork export.

Responsibilities:

- Start immediately when Rust receives an invocation.
- Import Playwright and create preforked workers before scratch setup is complete.
- Expose a simple Rust-to-Node IPC protocol, likely over stdio or a Unix domain socket.
- Receive structured run parameters from Rust.
- Load the raw user Playwright config through the Playwright export.
- Mutate the config according to Endform policy.
- Generate any Endform reporter modules needed for the run.
- Build the final Playwright reporter list.
- Build structured test selection from Endform test attempt data.
- Call the Playwright fork's generic `runTests` export.
- Return status, timing data, stdout/stderr if captured, and any structured failure data Rust needs.
- Stop preforked workers and cleanup host resources on cancellation or invocation completion.

This keeps rapidly changing Endform behavior in the Endform repository and keeps the fork as a lower-level runner API provider.

## Rust Lambda Runner Changes

The Rust controller should be reorganized so process execution can be backed either by the existing CLI path or by the new Node host path.

Suggested phases:

1. Start Node host early.
2. Run existing middleware setup.
3. Instead of collecting CLI args/config shim, collect structured run inputs for the Node host.
4. Send a `runTests` IPC request to the Node host.
5. Wait for completion/cancellation.
6. Run existing middleware teardown.
7. Keep the CLI backend as a fallback until parity is proven.

The current `PlaywrightConfigMiddleware` should eventually split into more explicit responsibilities:

- Lambda browser/runtime defaults.
- Endform config policy inputs.
- Test selection construction.
- Programmatic run options.
- Legacy CLI arg generation for fallback only.

## Cancellation And Failure Handling

The Node host should support cancellation explicitly:

```text
Rust -> Node: cancel current run
Node -> Playwright: stop current run
Node -> Rust: cancelled/finished
```

The host must also handle:

- Preforked worker exits before run starts.
- Worker crashes during initialization.
- Selected test not found.
- Config load errors.
- Reporter startup errors.
- Observer transport failure.
- Rust disconnecting or killing the invocation.

For safety, the first implementation can fall back to starting a fresh worker when a preforked worker is unavailable or incompatible.

## Measurement

Add timings at the Playwright host level and return them to Rust:

- host process start to ready
- Playwright import complete
- worker prefork start to ready
- run request received
- user config load
- Endform config mutation time, measured in the Endform Node host
- config normalization
- test collection/filtering
- runner-side test file load
- worker initialization
- worker-side test file load
- test execution
- reporter finalization
- total run time

Only after these timings are available should we decide whether to optimize discovery, avoid double test-file load, or prewarm browsers.

## Implementation Order

1. Add the new Playwright package export with no Endform-specific types.
2. Export `loadUserConfig` or equivalent raw config loading helper.
3. Export generic `runTests({ configLocation, config, ... })` that can run from an already-loaded raw config object.
4. Add structured in-memory test selection and wire it into the same filtering phase as current test-list support.
5. Hide prefork support behind an opaque `PreforkedWorkers` handle.
6. Update the existing smoke test to consume the new export instead of importing `playwright/lib/runner` internals.
7. Add Playwright-side tests for config-object execution, structured test selection, preforked worker execution, late worker env, reporter lifecycle, attachments, stdout/stderr attribution, and selected-test-not-found behavior.
8. Add the Endform Node host in the Lambda Runner repository.
9. Implement config mutation and reporter pipeline construction inside the Endform Node host.
10. Add a Rust execution backend flag to switch between legacy CLI and new host backend.
11. Add parity tests comparing legacy CLI/shim output with the new host backend.
12. Enable the new backend gradually and retain CLI fallback until production metrics are stable.

## Maintained Fork Strategy

Keep the fork patch set focused on generic seams:

- Programmatic `runTests` from a raw config object.
- Structured in-memory test selection.
- Process fork/init split.
- Delayed worker initialization.
- Opaque preforked worker pool consumed by dispatcher.

Avoid placing these in the fork:

- Endform config mutation policy.
- Endform reporter pipeline semantics.
- Rust-to-Node IPC protocol.
- Suite-control reporting details.
- Completion asset and trace upload details.
- Chrome flag policy.

Maintain one fork branch per supported Playwright version line, with this file as the intended architecture reference. Each branch should carry the smallest possible version-specific adaptation of the same generic public export.

## Success Criteria

- Lambda Runner can start a Node host and prefork a worker before dependency setup completes.
- Endform can run the selected tests without invoking the Playwright CLI.
- Endform can run without modifying the user's Playwright config file on disk.
- Endform can select tests through structured in-memory data, not a test-list file.
- Existing reporter lifecycle remains intact: `onConfigure`, `onBegin`, `onTestBegin`, step hooks, stdio attribution, attachments, `onTestEnd`, `onError`, `onEnd`, and `onExit`.
- Endform-specific config and reporter behavior can evolve in the Lambda Runner repository without changing the Playwright fork API.
- The Playwright fork surface is small enough to rebase across Playwright versions with predictable conflicts.
