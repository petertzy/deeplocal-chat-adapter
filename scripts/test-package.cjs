// Exercise the shipped files in isolation. Requires Node 22.18+ (vsce's runtime).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { createRequire } = require('node:module');

const checkout = path.resolve(__dirname, '..');
const vsceEntry = require.resolve('@vscode/vsce/vsce');
// Resolve through vsce: yauzl is already its ZIP reader, not a new dependency.
const yauzl = createRequire(vsceEntry)('yauzl');

async function extract(archive, destination) {
  const zip = await new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value));
  });
  return new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', async entry => {
      try {
        const target = path.resolve(destination, entry.fileName);
        assert(target.startsWith(destination + path.sep), 'Archive entry escapes extraction directory');
        if (entry.fileName.endsWith('/')) {
          fs.mkdirSync(target, { recursive: true });
        } else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const input = await new Promise((resolveStream, rejectStream) => {
            zip.openReadStream(entry, (error, stream) => error ? rejectStream(error) : resolveStream(stream));
          });
          await pipeline(input, fs.createWriteStream(target));
        }
        zip.readEntry();
      } catch (error) {
        zip.close();
        reject(error);
      }
    });
    zip.readEntry();
  });
}

// This runs in a fresh process whose cwd and module search paths are outside
// the checkout. Only the extension-host API is stubbed; koffi loads for real.
const probe = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
assert.equal(process.env.NODE_PATH, undefined);
const manifest = require('./package.json');
const extension = require(path.resolve(manifest.main));
assert.equal(typeof extension.activate, 'function');
assert.equal(typeof extension.deactivate, 'function');
// Resolve from the packaged extension's own module scope.
const extensionRequire = Module.createRequire(path.resolve(manifest.main));
const koffiPath = extensionRequire.resolve('koffi');
assert(koffiPath.startsWith(process.cwd() + path.sep));
const koffi = extensionRequire('koffi');
assert.equal(koffi.version, extensionRequire('koffi/package.json').version);
assert.equal(typeof koffi.load, 'function');
assert.equal(koffi.sizeof('int'), 4);
const native = Object.keys(require.cache).filter(file => file.endsWith('.node'));
assert(native.some(file => file.startsWith(path.join(process.cwd(), 'node_modules', 'koffi') + path.sep)),
  'No packaged koffi native binding was loaded');
console.log('Packaged extension and koffi native binding loaded: ' + native.join(', '));
`;

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'deeplocal-package-'));
  assert(!temporary.startsWith(checkout + path.sep), 'Smoke directory must be outside checkout');
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (['NODE_PATH', 'NODE_OPTIONS'].includes(key.toUpperCase())) delete environment[key];
  }
  environment.npm_config_cache = path.join(temporary, 'npm-cache');
  // Keep prepublish's node invocation on the same runtime as this command.
  const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') || 'PATH';
  environment[pathKey] = path.dirname(process.execPath) + path.delimiter + (environment[pathKey] || '');
  try {
    const archive = path.join(temporary, 'extension.vsix');
    const packed = spawnSync(process.execPath, [vsceEntry, 'package', '--out', archive], {
      cwd: checkout, env: environment, stdio: 'inherit', timeout: 180000,
    });
    if (packed.error) throw packed.error;
    assert.equal(packed.status, 0, 'VSIX packaging failed');
    const extracted = path.join(temporary, 'unpacked');
    await extract(archive, extracted);
    const extensionRoot = path.join(extracted, 'extension');
    const koffiRoot = path.join(extensionRoot, 'node_modules', 'koffi');
    for (const name of ['package.json', 'index.js', 'LICENSE.txt']) {
      assert(fs.existsSync(path.join(koffiRoot, name)), 'Missing packaged koffi/' + name);
    }
    const payload = fs.readdirSync(path.join(koffiRoot, 'build', 'koffi'), { recursive: true });
    assert(payload.some(name => name.endsWith('.node')), 'No native binaries in VSIX');
    const probePath = path.join(extensionRoot, 'package-smoke.cjs');
    fs.writeFileSync(probePath, probe);
    const runProbe = () => spawnSync(process.execPath, [probePath], {
      cwd: extensionRoot, env: environment, encoding: 'utf8', timeout: 30000,
    });
    const positive = runProbe();
    if (positive.error) throw positive.error;
    assert.equal(positive.status, 0, positive.stderr || positive.stdout);
    console.log(positive.stdout.trim());
    // A fresh process must detect the original packaging regression.
    fs.renameSync(koffiRoot, path.join(temporary, 'removed-koffi'));
    const negative = runProbe();
    if (negative.error) throw negative.error;
    assert.notEqual(negative.status, 0, 'Control unexpectedly loaded without packaged koffi');
    assert.match(negative.stderr, /Cannot find module ['"]koffi['"]/);
    console.log('Missing-koffi control failed as expected. Packaged VSIX smoke passed.');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
