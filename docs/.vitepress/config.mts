import * as emu from '@budaknyenyel/emu-lab';
import * as i18n from '@budaknyenyel/i18n-mcp';
import { composeConfigSchema } from '@budaknyenyel/kit-schema';
import * as maestro from '@budaknyenyel/maestro-flow';
import * as backend from '@budaknyenyel/supa-multiuser-harness';
import * as release from '@budaknyenyel/supa-release-gate-mcp';
import { defineConfig } from 'vitepress';

const sections = [emu, maestro, backend, i18n, release];
const configReference = JSON.stringify(
  composeConfigSchema(
    Object.fromEntries(
      sections.map(({ configSection, configSectionSchema }) => [
        configSection,
        configSectionSchema,
      ]),
    ),
  ),
  null,
  2,
);

const repository = process.env.GITHUB_REPOSITORY?.split('/')[1];

export default defineConfig({
  title: 'android-kit',
  description: 'Android development tools and lifecycle guidance',
  base: process.env.GITHUB_ACTIONS && repository ? `/${repository}/` : '/',
  markdown: {
    config(md) {
      md.core.ruler.before('normalize', 'config-reference', (state) => {
        state.src = state.src.replace(
          '<!-- CONFIG_SCHEMA -->',
          `\`\`\`json\n${configReference}\n\`\`\``,
        );
      });
    },
  },
  themeConfig: {
    nav: [
      { text: 'Getting started', link: '/getting-started' },
      { text: 'Lifecycle', link: '/lifecycle' },
      { text: 'Fixture walkthrough', link: '/fixture' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/getting-started' },
          { text: 'Lifecycle', link: '/lifecycle' },
          { text: 'Fixture walkthrough', link: '/fixture' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Configuration', link: '/android-kit-yaml' },
          { text: 'Result schema', link: '/kit-schema' },
        ],
      },
    ],
    search: { provider: 'local' },
  },
});
