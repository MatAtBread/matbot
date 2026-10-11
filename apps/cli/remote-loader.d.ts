// Types for the hook-side loader, which is plain JS because `register.js` and `ts-hooks.js` load before
// any type stripping is in place. Only what typed source calls is declared here.
export function materialiseUrl(url: string, dotPlugins: string): Promise<string>;
