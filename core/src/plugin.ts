// Core's view of the plugin API is the whole of it: core *is* a host, so it needs the boot-assembly
// half (`/host`) as well as the author-facing root. Everything reached through this module is therefore
// available to core internals and, via core's index, to an embedding app.
export * from '@matatbread/matbot-plugin-api';
export * from '@matatbread/matbot-plugin-api/host';
