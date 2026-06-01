# Endform Playwright Packages

This directory contains Endform-only tooling for publishing this Playwright fork under scoped npm package names while preserving canonical Playwright module names at runtime.

## Published Packages

The fork is published as three scoped packages:

| Package | Source package | Purpose |
| --- | --- | --- |
| `@endform/playwright-core` | `packages/playwright-core` | Browser automation engine |
| `@endform/playwright` | `packages/playwright` | Public Playwright package plus Endform's `playwright/programmatic-runner` export |
| `@endform/playwright-test` | `packages/playwright-test` | Wrapper equivalent of upstream `@playwright/test` |

The source workspace package names stay unchanged: `playwright-core`, `playwright`, and `@playwright/test`. This keeps normal Playwright build tooling, tests, generated files, and internal imports working without a fork-wide rename.

## Why Runtime Names Stay Canonical

Playwright packages intentionally import each other by canonical package name. Examples:

```js
require('playwright-core')
require('playwright/test')
```

The Endform packages therefore use npm alias dependencies in their staged `package.json` files:

```json
{
  "name": "@endform/playwright",
  "dependencies": {
    "playwright-core": "npm:@endform/playwright-core@1.60.0-beta.1"
  }
}
```

```json
{
  "name": "@endform/playwright-test",
  "dependencies": {
    "playwright": "npm:@endform/playwright@1.60.0-beta.1"
  }
}
```

This means code can keep using canonical imports when a project installs the fork through aliases:

```json
{
  "dependencies": {
    "playwright-core": "npm:@endform/playwright-core@1.60.0-beta.1",
    "playwright": "npm:@endform/playwright@1.60.0-beta.1",
    "@playwright/test": "npm:@endform/playwright-test@1.60.0-beta.1"
  }
}
```

With that install shape, these imports all resolve to the Endform fork:

```js
require('playwright')
require('playwright/test')
require('playwright/programmatic-runner')
require('@playwright/test')
```

## LambdaRunner Symlink Strategy

LambdaRunner can install both upstream Playwright and Endform Playwright into isolated roots in the Docker image:

```text
/opt/playwright-upstream/node_modules/
  playwright
  playwright-core
  @playwright/test

/opt/playwright-endform/node_modules/
  playwright
  playwright-core
  @playwright/test
```

The Endform root should be installed with canonical alias names that point at the scoped packages:

```json
{
  "dependencies": {
    "playwright-core": "npm:@endform/playwright-core@1.60.0-beta.1",
    "playwright": "npm:@endform/playwright@1.60.0-beta.1",
    "@playwright/test": "npm:@endform/playwright-test@1.60.0-beta.1"
  }
}
```

At invocation time, LambdaRunner should select a matched package set and create execution-directory symlinks such as:

```text
/tmp/node_modules/playwright -> selected root/node_modules/playwright
/tmp/node_modules/playwright-core -> selected root/node_modules/playwright-core
/tmp/node_modules/@playwright/test -> selected root/node_modules/@playwright/test
```

Do not symlink only one package. `@playwright/test`, `playwright`, and `playwright-core` must be selected as a matched set so that all canonical package imports bind to the same implementation.

The switch must happen before the Node host imports Playwright. Once Node loads `playwright`, `playwright-core`, or `@playwright/test`, the module cache makes in-process switching unsafe.

Avoid using `NODE_OPTIONS=--preserve-symlinks` as the main solution. It changes module identity globally and can create duplicate-module problems. Prefer isolated install roots plus canonical symlinks.

## Staging Packages

Build Playwright first:

```bash
npm run build
```

Stage and validate Endform tarballs:

```bash
node utils/endform/stage_endform_packages.js
```

By default, tarballs are written to `endform-packages/`:

```text
endform-packages/endform-playwright-core-<version>.tgz
endform-packages/endform-playwright-<version>.tgz
endform-packages/endform-playwright-test-<version>.tgz
```

The staging script validates canonical alias installation, which is the install shape LambdaRunner needs for symlink selection. Direct scoped installation requires the packages to already exist in the npm registry because the staged packages intentionally depend on each other through npm aliases.

## Publishing

For a beta release:

```bash
node utils/workspace.js --set-version 1.60.0-beta.1
npm run build
utils/endform/publish_endform_packages.sh --beta --dry-run
utils/endform/publish_endform_packages.sh --beta
```

For a stable release:

```bash
node utils/workspace.js --set-version 1.60.0
npm run build
utils/endform/publish_endform_packages.sh --release --dry-run
utils/endform/publish_endform_packages.sh --release
```

`--beta` publishes with the `beta` dist-tag and requires a version containing `-beta`. `--release` publishes with the `latest` dist-tag and rejects pre-release versions.

The publish order is dependency-safe:

1. `@endform/playwright-core`
2. `@endform/playwright`
3. `@endform/playwright-test`
