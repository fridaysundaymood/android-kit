import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [destination, tag] = process.argv.slice(2);
if (!destination || !tag?.startsWith('v')) {
  throw new Error(
    'Usage: node scripts/prepare-publish.mjs <destination> <version tag>',
  );
}
const stagingRoot = resolve(destination);
await mkdir(stagingRoot, { recursive: true });
await cp(
  join(root, 'tsconfig.base.json'),
  join(stagingRoot, 'tsconfig.base.json'),
);
await symlink(
  join(root, 'node_modules'),
  join(stagingRoot, 'node_modules'),
  'junction',
);

for (const directory of ['kit-schema', 'server', 'cli']) {
  const source = join(root, 'packages', directory);
  const manifest = JSON.parse(
    await readFile(join(source, 'package.json'), 'utf8'),
  );
  if (`v${manifest.version}` !== tag) {
    throw new Error(
      `${manifest.name}: version ${manifest.version} does not match tag ${tag}`,
    );
  }
  for (const section of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (!spec.startsWith('file:')) continue;
      const dependency = JSON.parse(
        await readFile(resolve(source, spec.slice(5), 'package.json'), 'utf8'),
      );
      if (
        dependency.name !== name ||
        dependency.private ||
        !dependency.version
      ) {
        throw new Error(
          `Invalid publish dependency ${name} in ${manifest.name}`,
        );
      }
      manifest[section][name] = `^${dependency.version}`;
    }
  }
  const target = resolve(destination, directory);
  await mkdir(target, { recursive: true });
  await cp(join(source, 'src'), join(target, 'src'), { recursive: true });
  const tsconfig = JSON.parse(
    await readFile(join(source, 'tsconfig.json'), 'utf8'),
  );
  tsconfig.extends = '../tsconfig.base.json';
  await writeFile(
    join(target, 'tsconfig.json'),
    `${JSON.stringify(tsconfig, null, 2)}\n`,
  );
  for (const file of manifest.files) {
    const asset = ['README.md', 'LICENSE', 'CHANGELOG.md'].includes(file);
    await cp(join(asset ? root : source, file), join(target, file), {
      recursive: true,
    });
  }
  await writeFile(
    join(target, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
