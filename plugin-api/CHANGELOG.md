# @matatbread/matbot-plugin-api

## 0.2.3

## 0.2.2

## 0.2.1

## 0.2.0

## 0.1.8

### Patch Changes

- 4891bf7: fix: prevent (and survive) duplicate plugin-api/core copies splitting the principal carrier

  Two layers of fix for the "No PrincipalCarrier installed" failure seen when a published
  install ends up with two physical copies of the host singletons:

  - **Caret dependency ranges.** Inter-package and peer deps were published as exact pins
    (`workspace:*` → `0.1.7`), so any version skew (e.g. an in-place CLI upgrade over an older
    tree) forced npm to nest a second copy of `plugin-api`/`core` — which `npm dedupe` cannot
    merge across exact-but-different requirements. They now publish as caret (`workspace:^` →
    `^0.1.7`), so a single highest copy satisfies the whole tree.

  - **Process-global principal carrier.** The carrier was a module-level `let`, so two copies of
    `plugin-api` each had their own — the host installed into one, a plugin read the other, and
    every principal read threw. It now lives on `globalThis` under `Symbol.for(...)`, so all
    copies share the single carrier the host installs at boot. Deduping is still preferred; this
    makes duplication harmless rather than fatal.

## 0.1.7

## 0.1.6

## 0.1.5

## 0.1.4

## 0.1.3

## 0.1.2

## 0.1.1
