---
"@matatbread/matbot-tool-types": patch
---

Installed from npm, source-declared tools are typed, validated and described again (#121). tool-types recognised plugin-api by a `/plugin-api/` path fragment, which an npm install (`node_modules/@matatbread/matbot-plugin-api`) never matches, and treated anything under `node_modules` as external, which in an npm install is every plugin. So `tool_function`, `single_turn`, `about_matbot`, `function_runner_config` and every installed plugin's tools got no ts-validation validator, no arm in the dts a function body is checked against, and no wire contract; with plugin-api found, an installed plugin's own result types would still have been `unknown` in the dts, its augmentations dropped, and named shapes left unexpanded on the wire. A file is now classified by the package the scan anchored on and the packages of its roots. A cached build from `caching-tool-types` is discarded on upgrade, its key including tool-types' source.
