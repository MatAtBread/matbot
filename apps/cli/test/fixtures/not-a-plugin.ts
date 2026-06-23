// Importable, but exports no `plugin` — the shape of a bare library mistaken for a plugin, which once
// bricked boot when added to matbot.yaml. The loader fails it (skip at startup; a typed NotAPluginError
// on an explicit load), and `discover_local` no longer offers such a module in the first place.
export const notAPlugin = true;
