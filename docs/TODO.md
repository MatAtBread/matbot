Things I think we're missing, esp in an enterprise env. No specific order

* Mark createdBy [module/plugin], createdFor [principal]
* ~~Need to actually try and implment the web-only bundle~~ — done: `apps/web-bundle` (single self-contained `matbot.html`, in-browser type-strip; browser defaults are plugins under `packages/plugins/browser` + `frontend/dom`)
* Media input & output (esp pdf, html, etc) - maybe pdfmake?
* Removing storage should revert to the code File system (or Memory & drain?)