// Remap *.js imports to *.ts for TypeScript source files that don't ship compiled output.
// Required because Node's native strip-types does not perform this remapping across
// pnpm workspace symlinks.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js')) {
    try {
      return await nextResolve(specifier.slice(0, -3) + '.ts', context);
    } catch {
      // .ts counterpart doesn't exist — fall through to the original specifier
    }
  }
  return nextResolve(specifier, context);
}
