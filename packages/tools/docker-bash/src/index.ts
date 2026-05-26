import type { MatbotPlugin } from '@matbot/plugin-api';
import { PLUGIN_API_VERSION } from '@matbot/plugin-api';
import { createBashTool }    from '@matbot/tool-bash';

/**
 * Replaces the `bash` tool with a Docker-backed implementation.
 *
 * Because this plugin registers a tool with the same name (`bash`) as
 * @matbot/tool-bash, loading it after the base bash plugin silently swaps the
 * executor. The LLM sees an identical tool schema and description — it cannot
 * tell whether its scripts run locally or inside a container.
 *
 * Required matbot.yaml config:
 *
 *   extensions:
 *     docker-bash:
 *       dockerImage: ubuntu:24.04   # required — image to run scripts in
 *       dockerNetwork: none         # optional — Docker --network value
 */
export const plugin: MatbotPlugin = {
  name:       'docker-bash',
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Replaces the bash tool with a sandboxed Docker implementation. Same interface, isolated execution.',
    config:      ['dockerImage', 'dockerNetwork'],
  },

  async setup(services) {
    const cfg = services.extensions?.['docker-bash'] as Record<string, unknown> | undefined;
    const image = cfg?.['dockerImage'] as string | undefined;

    if (!image) {
      throw new Error(
        'docker-bash requires extensions.docker-bash.dockerImage in matbot.yaml. ' +
        'Example: dockerImage: ubuntu:24.04',
      );
    }

    const network = cfg?.['dockerNetwork'] as string | undefined;

    services.tools.register(createBashTool({
      image,
      ...(network !== undefined ? { network } : {}),
    }));
  },
};
