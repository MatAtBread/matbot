// Shaped like a real plugin, but its bare import resolves nowhere — which is exactly an http-fetched
// plugin declaring a dependency the host does not have.
import 'no-such-package-anywhere';

export const plugin = { apiVersion: '0.4' };
