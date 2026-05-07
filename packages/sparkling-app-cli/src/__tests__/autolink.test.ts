// Copyright (c) 2025 TikTok Pte. Ltd.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { autolink } from '../commands/autolink';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a unique temp directory for each test. */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sparkling-autolink-test-'));
}

/** Minimal Podfile with the sparkling_methods_dep placeholder. */
function podfileTemplate(existingPods = ''): string {
  return [
    "platform :ios, '12.0'",
    '',
    'def sparkling_methods_dep',
    existingPods || '  # placeholder',
    'end',
    '',
    "target 'SparklingGo' do",
    '  sparkling_methods_dep',
    'end',
  ].join('\n');
}

/** Minimal settings.gradle.kts with optional existing autolink block. */
function settingsTemplate(existingBlock = ''): string {
  return [
    'rootProject.name = "Sparkling"',
    'include(":app")',
    existingBlock,
  ].join('\n');
}

/** Minimal build.gradle.kts with a dependencies block. */
function buildGradleTemplate(existingBlock = ''): string {
  return [
    'plugins {',
    '    alias(libs.plugins.android.application)',
    '}',
    '',
    'android {',
    '    namespace = "com.example.sparkling.go"',
    '}',
    '',
    'dependencies {',
    '    implementation(libs.androidx.core.ktx)',
    existingBlock,
    '}',
  ].join('\n');
}

/** Write a module.config.json inside a sparkling method package in node_modules. */
function createMethodModule(
  cwd: string,
  name: string,
  opts: { iosModuleName?: string; iosClassName?: string; androidPackage?: string; androidClassName?: string } = {},
): string {
  const moduleDir = path.join(cwd, 'node_modules', name);
  fs.mkdirpSync(path.join(moduleDir, 'ios'));
  fs.mkdirpSync(path.join(moduleDir, 'android'));

  // Write a minimal podspec so resolvePodName can derive the pod name
  const podspecContent = `Pod::Spec.new do |s|\n  s.name = '${name}'\nend`;
  fs.writeFileSync(path.join(moduleDir, 'ios', `${name}.podspec`), podspecContent);

  // Write a minimal build.gradle.kts
  fs.writeFileSync(path.join(moduleDir, 'android', 'build.gradle.kts'), 'plugins {}');

  const config: Record<string, unknown> = { name };
  if (opts.iosModuleName || opts.iosClassName) {
    config.ios = {
      moduleName: opts.iosModuleName ?? name,
      className: opts.iosClassName ?? `${name}Module`,
      podspecPath: path.join(moduleDir, 'ios', `${name}.podspec`),
    };
  }
  if (opts.androidPackage || opts.androidClassName) {
    config.android = {
      packageName: opts.androidPackage ?? `com.sparkling.${name}`,
      className: opts.androidClassName ?? `${name}Module`,
    };
  }

  fs.writeFileSync(path.join(moduleDir, 'module.config.json'), JSON.stringify(config, null, 2));
  return moduleDir;
}

function createLynxExtension(
  cwd: string,
  name: string,
  config: Record<string, unknown>,
): string {
  const moduleDir = path.join(cwd, 'node_modules', ...name.split('/'));
  fs.mkdirpSync(path.join(moduleDir, 'ios'));
  fs.mkdirpSync(path.join(moduleDir, 'android'));

  const podName = String((config.platforms as any)?.ios?.podName ?? 'Sparkling-Button');
  fs.writeFileSync(path.join(moduleDir, 'ios', `${podName}.podspec`), `Pod::Spec.new do |s|\n  s.name = '${podName}'\nend`);
  fs.writeFileSync(path.join(moduleDir, 'android', 'build.gradle.kts'), 'plugins {}');
  fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ name }, null, 2));
  fs.writeFileSync(path.join(moduleDir, 'lynx.ext.json'), JSON.stringify(config, null, 2));
  return moduleDir;
}

/** Scaffold the minimal iOS + Android project structure. */
function scaffoldProject(cwd: string, opts?: { podfileContent?: string; settingsContent?: string; buildGradleContent?: string }): void {
  // iOS
  const iosDir = path.join(cwd, 'ios');
  const swiftDir = path.join(iosDir, 'SparklingGo', 'SparklingGo');
  fs.mkdirpSync(swiftDir);
  fs.writeFileSync(path.join(iosDir, 'Podfile'), opts?.podfileContent ?? podfileTemplate());

  // Android
  const androidAppDir = path.join(cwd, 'android', 'app');
  fs.mkdirpSync(androidAppDir);
  fs.writeFileSync(path.join(cwd, 'android', 'settings.gradle.kts'), opts?.settingsContent ?? settingsTemplate());
  fs.writeFileSync(path.join(androidAppDir, 'build.gradle.kts'), opts?.buildGradleContent ?? buildGradleTemplate());

  // node_modules (empty)
  fs.mkdirpSync(path.join(cwd, 'node_modules'));
}

// ── Mock loadAppConfig so we don't need a real app.config.ts ─────────────────

jest.mock('../config', () => ({
  loadAppConfig: jest.fn().mockResolvedValue({
    config: {
      lynxConfig: {},
      platform: {
        android: { packageName: 'com.test.app' },
        ios: { bundleIdentifier: 'com.test.app' },
      },
    },
    configPath: '/mock/app.config.ts',
  }),
}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe('autolink', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTmpDir();
  });

  afterEach(() => {
    fs.removeSync(cwd);
  });

  // ── One module ──────────────────────────────────────────────────────────

  describe('one sparkling method module', () => {
    beforeEach(() => {
      scaffoldProject(cwd);
      createMethodModule(cwd, 'sparkling-navigation', {
        iosModuleName: 'Router',
        iosClassName: 'RouterModule',
        androidPackage: 'com.sparkling.navigation',
        androidClassName: 'NavigationModule',
      });
    });

    it('injects the module into the Podfile', async () => {
      await autolink({ cwd, platform: 'ios' });

      const podfile = fs.readFileSync(path.join(cwd, 'ios', 'Podfile'), 'utf8');
      expect(podfile).toContain('# BEGIN SPARKLING AUTOLINK');
      expect(podfile).toContain('# END SPARKLING AUTOLINK');
      expect(podfile).toContain("pod 'sparkling-navigation'");
      expect(podfile).not.toContain('# No Sparkling methods found');
    });

    it('writes the iOS registry with one entry', async () => {
      await autolink({ cwd, platform: 'ios' });

      const registry = fs.readFileSync(
        path.join(cwd, 'ios', 'SparklingGo', 'SparklingGo', 'SparklingAutolink.swift'),
        'utf8',
      );
      expect(registry).toContain('sparkling-navigation');
      expect(registry).toContain('Router');
      expect(registry).toContain('RouterModule');
    });

    it('injects the module into settings.gradle.kts', async () => {
      await autolink({ cwd, platform: 'android' });

      const settings = fs.readFileSync(path.join(cwd, 'android', 'settings.gradle.kts'), 'utf8');
      expect(settings).toContain('// BEGIN SPARKLING AUTOLINK');
      expect(settings).toContain('// END SPARKLING AUTOLINK');
      expect(settings).toContain('"sparkling-navigation"');
    });

    it('injects the module into build.gradle.kts dependencies', async () => {
      await autolink({ cwd, platform: 'android' });

      const gradle = fs.readFileSync(path.join(cwd, 'android', 'app', 'build.gradle.kts'), 'utf8');
      expect(gradle).toContain('// BEGIN SPARKLING AUTOLINK');
      expect(gradle).toContain('// END SPARKLING AUTOLINK');
      expect(gradle).toContain(':sparkling-navigation');
    });

    it('writes the Android registry with one entry', async () => {
      await autolink({ cwd, platform: 'android' });

      const registryPath = path.join(cwd, 'android', 'app', 'src', 'main', 'java', 'com', 'test', 'app', 'SparklingAutolink.kt');
      expect(fs.existsSync(registryPath)).toBe(true);
      const registry = fs.readFileSync(registryPath, 'utf8');
      expect(registry).toContain('sparkling-navigation');
      expect(registry).toContain('com.sparkling.navigation');
      expect(registry).toContain('NavigationModule');
    });

    it('returns the discovered module', async () => {
      const modules = await autolink({ cwd, platform: 'all' });
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('sparkling-navigation');
    });
  });

  // ── Multiple modules ───────────────────────────────────────────────────

  describe('multiple sparkling method modules', () => {
    beforeEach(() => {
      scaffoldProject(cwd);
      createMethodModule(cwd, 'sparkling-navigation', {
        iosModuleName: 'Router',
        iosClassName: 'RouterModule',
        androidPackage: 'com.sparkling.navigation',
        androidClassName: 'NavigationModule',
      });
      createMethodModule(cwd, 'sparkling-storage', {
        iosModuleName: 'Storage',
        iosClassName: 'StorageModule',
        androidPackage: 'com.sparkling.storage',
        androidClassName: 'StorageModule',
      });
      createMethodModule(cwd, 'sparkling-media', {
        iosModuleName: 'Media',
        iosClassName: 'MediaModule',
        androidPackage: 'com.sparkling.media',
        androidClassName: 'MediaModule',
      });
    });

    it('injects all modules into the Podfile', async () => {
      await autolink({ cwd, platform: 'ios' });

      const podfile = fs.readFileSync(path.join(cwd, 'ios', 'Podfile'), 'utf8');
      expect(podfile).toContain("pod 'sparkling-navigation'");
      expect(podfile).toContain("pod 'sparkling-storage'");
      expect(podfile).toContain("pod 'sparkling-media'");
    });

    it('writes the iOS registry with all entries', async () => {
      await autolink({ cwd, platform: 'ios' });

      const registry = fs.readFileSync(
        path.join(cwd, 'ios', 'SparklingGo', 'SparklingGo', 'SparklingAutolink.swift'),
        'utf8',
      );
      expect(registry).toContain('sparkling-navigation');
      expect(registry).toContain('sparkling-storage');
      expect(registry).toContain('sparkling-media');
    });

    it('injects all modules into settings.gradle.kts', async () => {
      await autolink({ cwd, platform: 'android' });

      const settings = fs.readFileSync(path.join(cwd, 'android', 'settings.gradle.kts'), 'utf8');
      expect(settings).toContain('"sparkling-navigation"');
      expect(settings).toContain('"sparkling-storage"');
      expect(settings).toContain('"sparkling-media"');
    });

    it('injects all modules into build.gradle.kts dependencies', async () => {
      await autolink({ cwd, platform: 'android' });

      const gradle = fs.readFileSync(path.join(cwd, 'android', 'app', 'build.gradle.kts'), 'utf8');
      expect(gradle).toContain(':sparkling-navigation');
      expect(gradle).toContain(':sparkling-storage');
      expect(gradle).toContain(':sparkling-media');
    });

    it('writes the Android registry with all entries', async () => {
      await autolink({ cwd, platform: 'android' });

      const registryPath = path.join(cwd, 'android', 'app', 'src', 'main', 'java', 'com', 'test', 'app', 'SparklingAutolink.kt');
      const registry = fs.readFileSync(registryPath, 'utf8');
      expect(registry).toContain('sparkling-navigation');
      expect(registry).toContain('sparkling-storage');
      expect(registry).toContain('sparkling-media');
    });

    it('returns all discovered modules', async () => {
      const modules = await autolink({ cwd, platform: 'all' });
      expect(modules).toHaveLength(3);
      const names = modules.map(m => m.name).sort();
      expect(names).toEqual(['sparkling-media', 'sparkling-navigation', 'sparkling-storage']);
    });
  });

  describe('lynx extension modules', () => {
    beforeEach(() => {
      scaffoldProject(cwd);
      createLynxExtension(cwd, '@lynxjs/button', {
        name: '@lynxjs/button',
        platforms: {
          android: {
            packageName: 'com.lynxjs.button',
            buildGradle: 'android/build.gradle.kts',
            elements: [{ name: 'native-button', className: 'ButtonElement' }],
            nativeModules: [
              { name: 'NativeLocalStorage', className: 'NativeLocalStorageModule', scope: 'global' },
              { name: 'ToastModule', className: 'com.lynxjs.button.ToastModule', scope: 'view' },
            ],
            services: [{ className: 'CustomImageService' }],
            sparklingMethods: { classes: ['ButtonClickMethod'] },
          },
          ios: {
            importName: 'Sparkling_Button',
            podspecPath: 'ios/Sparkling-Button.podspec',
            elements: [{ name: 'native-button', className: 'ButtonElement' }],
            nativeModules: [{ name: 'NativeLocalStorage', className: 'NativeLocalStorageModule' }],
            services: [{ className: 'ButtonLogService', protocolName: 'LynxServiceLogProtocol' }],
            sparklingMethods: { classes: ['ButtonClickMethod'] },
          },
        },
      });
    });

    it('generates Android runtime registration entries from lynx.ext.json', async () => {
      await autolink({ cwd, platform: 'android' });

      const registryPath = path.join(cwd, 'android', 'app', 'src', 'main', 'java', 'com', 'test', 'app', 'SparklingAutolink.kt');
      const registry = fs.readFileSync(registryPath, 'utf8');
      expect(registry).toContain('SparklingAutolinkRegistry.registerElement("native-button", "com.lynxjs.button.ButtonElement")');
      expect(registry).toContain('SparklingAutolinkRegistry.registerGlobalModule("NativeLocalStorage", "com.lynxjs.button.NativeLocalStorageModule")');
      expect(registry).toContain('SparklingAutolinkRegistry.registerViewModule("ToastModule", "com.lynxjs.button.ToastModule")');
      expect(registry).toContain('SparklingAutolinkRegistry.registerService("com.lynxjs.button.CustomImageService")');
      expect(registry).toContain('SparklingAutolinkRegistry.registerSparklingMethod("com.lynxjs.button.ButtonClickMethod")');

      const settings = fs.readFileSync(path.join(cwd, 'android', 'settings.gradle.kts'), 'utf8');
      const gradle = fs.readFileSync(path.join(cwd, 'android', 'app', 'build.gradle.kts'), 'utf8');
      expect(settings).toContain('"lynxjs-button"');
      expect(gradle).toContain(':lynxjs-button');
    });

    it('generates iOS runtime registration entries from lynx.ext.json', async () => {
      await autolink({ cwd, platform: 'ios' });

      const registryPath = path.join(cwd, 'ios', 'SparklingGo', 'SparklingGo', 'SparklingAutolink.swift');
      const registry = fs.readFileSync(registryPath, 'utf8');
      expect(registry).toContain('#if canImport(Sparkling_Button)');
      expect(registry).toContain('SPKAutolinkRegistry.shared.registerElement(name: "native-button", type: ButtonElement.self)');
      expect(registry).toContain('SPKAutolinkRegistry.shared.registerModule(name: "NativeLocalStorage", type: NativeLocalStorageModule.self)');
      expect(registry).toContain('LynxServices.registerService(withProtocol: ButtonLogService.self, protocol: LynxServiceLogProtocol.self)');
      expect(registry).toContain('MethodRegistry.global.register(methodType: ButtonClickMethod.self)');
      const podfile = fs.readFileSync(path.join(cwd, 'ios', 'Podfile'), 'utf8');
      expect(podfile).toContain("pod 'Sparkling-Button'");
    });

    it('prefers lynx.ext.json over legacy module.config.json for the same package', async () => {
      const moduleDir = path.join(cwd, 'node_modules', '@lynxjs', 'button');
      fs.writeFileSync(path.join(moduleDir, 'module.config.json'), JSON.stringify({
        name: '@lynxjs/button',
        android: {
          packageName: 'com.legacy.button',
          className: 'LegacyButton',
        },
      }, null, 2));

      const modules = await autolink({ cwd, platform: 'android' });

      expect(modules).toHaveLength(1);
      expect(modules[0].android?.elements?.[0]?.className).toBe('com.lynxjs.button.ButtonElement');
      const registryPath = path.join(cwd, 'android', 'app', 'src', 'main', 'java', 'com', 'test', 'app', 'SparklingAutolink.kt');
      const registry = fs.readFileSync(registryPath, 'utf8');
      expect(registry).not.toContain('LegacyButton');
    });
  });

  // ── Zero modules ───────────────────────────────────────────────────────

  describe('no sparkling method modules', () => {
    it('cleans stale Podfile entries when all modules are removed', async () => {
      // Start with one module linked
      scaffoldProject(cwd, {
        podfileContent: podfileTemplate([
          '  # BEGIN SPARKLING AUTOLINK',
          "  pod 'sparkling-navigation', :path => '../node_modules/sparkling-navigation/ios'",
          '  # END SPARKLING AUTOLINK',
        ].join('\n')),
      });

      // No modules in node_modules — simulate user removing sparkling-navigation
      await autolink({ cwd, platform: 'ios' });

      const podfile = fs.readFileSync(path.join(cwd, 'ios', 'Podfile'), 'utf8');
      expect(podfile).toContain('# BEGIN SPARKLING AUTOLINK');
      expect(podfile).toContain('# No Sparkling methods found');
      expect(podfile).not.toContain('sparkling-navigation');
    });

    it('cleans stale settings.gradle.kts entries when all modules are removed', async () => {
      const staleBlock = [
        '',
        '// BEGIN SPARKLING AUTOLINK',
        'val sparklingAutolinkProjects = listOf<Pair<String, java.io.File>>()',
        'sparklingAutolinkProjects.forEach { (name, dir) ->',
        '    include(":$name")',
        '    project(":$name").projectDir = dir',
        '}',
        '// END SPARKLING AUTOLINK',
      ].join('\n');

      scaffoldProject(cwd, { settingsContent: settingsTemplate(staleBlock) });

      await autolink({ cwd, platform: 'android' });

      const settings = fs.readFileSync(path.join(cwd, 'android', 'settings.gradle.kts'), 'utf8');
      expect(settings).not.toContain('// BEGIN SPARKLING AUTOLINK');
      expect(settings).not.toContain('// END SPARKLING AUTOLINK');
    });

    it('cleans stale build.gradle.kts entries when all modules are removed', async () => {
      const staleBlock = [
        '    // BEGIN SPARKLING AUTOLINK',
        '    listOf(',
        '        project(":sparkling-navigation")',
        '    ).forEach { dep -> add("implementation", dep) }',
        '    // END SPARKLING AUTOLINK',
      ].join('\n');

      scaffoldProject(cwd, { buildGradleContent: buildGradleTemplate(staleBlock) });

      await autolink({ cwd, platform: 'android' });

      const gradle = fs.readFileSync(path.join(cwd, 'android', 'app', 'build.gradle.kts'), 'utf8');
      expect(gradle).not.toContain('// BEGIN SPARKLING AUTOLINK');
      expect(gradle).not.toContain('sparkling-navigation');
    });

    it('writes empty iOS registry when no modules exist', async () => {
      scaffoldProject(cwd);

      await autolink({ cwd, platform: 'ios' });

      const registryPath = path.join(cwd, 'ios', 'SparklingGo', 'SparklingGo', 'SparklingAutolink.swift');
      expect(fs.existsSync(registryPath)).toBe(true);
      const registry = fs.readFileSync(registryPath, 'utf8');
      expect(registry).toContain('sparklingAutolinkModules');
      // The array should be empty (only whitespace between brackets)
      const match = registry.match(/sparklingAutolinkModules.*?=\s*\[([\s\S]*?)\]/);
      expect(match).toBeTruthy();
      expect(match![1].trim()).toBe('');
    });

    it('writes empty Android registry when no modules exist', async () => {
      scaffoldProject(cwd);

      await autolink({ cwd, platform: 'android' });

      const registryPath = path.join(cwd, 'android', 'app', 'src', 'main', 'java', 'com', 'test', 'app', 'SparklingAutolink.kt');
      expect(fs.existsSync(registryPath)).toBe(true);
      const registry = fs.readFileSync(registryPath, 'utf8');
      expect(registry).toContain('val modules = listOf(');
      // No module entries between listOf( and )
      const match = registry.match(/listOf\(\s*([\s\S]*?)\s*\)/);
      expect(match).toBeTruthy();
      expect(match![1].trim()).toBe('');
    });

    it('returns empty array', async () => {
      scaffoldProject(cwd);
      const modules = await autolink({ cwd, platform: 'all' });
      expect(modules).toHaveLength(0);
    });
  });

  // ── Idempotency ────────────────────────────────────────────────────────

  describe('idempotency', () => {
    it('running autolink twice produces the same result', async () => {
      scaffoldProject(cwd);
      createMethodModule(cwd, 'sparkling-navigation', {
        iosModuleName: 'Router',
        iosClassName: 'RouterModule',
      });

      await autolink({ cwd, platform: 'all' });
      const podfileAfterFirst = fs.readFileSync(path.join(cwd, 'ios', 'Podfile'), 'utf8');
      const settingsAfterFirst = fs.readFileSync(path.join(cwd, 'android', 'settings.gradle.kts'), 'utf8');
      const gradleAfterFirst = fs.readFileSync(path.join(cwd, 'android', 'app', 'build.gradle.kts'), 'utf8');

      await autolink({ cwd, platform: 'all' });
      const podfileAfterSecond = fs.readFileSync(path.join(cwd, 'ios', 'Podfile'), 'utf8');
      const settingsAfterSecond = fs.readFileSync(path.join(cwd, 'android', 'settings.gradle.kts'), 'utf8');
      const gradleAfterSecond = fs.readFileSync(path.join(cwd, 'android', 'app', 'build.gradle.kts'), 'utf8');

      expect(podfileAfterSecond).toBe(podfileAfterFirst);
      expect(settingsAfterSecond).toBe(settingsAfterFirst);
      expect(gradleAfterSecond).toBe(gradleAfterFirst);
    });

    it('adding then removing a module restores clean state', async () => {
      scaffoldProject(cwd);

      // First: link a module
      createMethodModule(cwd, 'sparkling-navigation', {
        iosModuleName: 'Router',
        iosClassName: 'RouterModule',
      });
      await autolink({ cwd, platform: 'all' });

      // Verify it was linked
      const podfileWithModule = fs.readFileSync(path.join(cwd, 'ios', 'Podfile'), 'utf8');
      expect(podfileWithModule).toContain('sparkling-navigation');

      // Second: remove the module and re-autolink
      fs.removeSync(path.join(cwd, 'node_modules', 'sparkling-navigation'));
      await autolink({ cwd, platform: 'all' });

      // Verify stale entries are cleaned
      const podfileClean = fs.readFileSync(path.join(cwd, 'ios', 'Podfile'), 'utf8');
      expect(podfileClean).not.toContain('sparkling-navigation');
      expect(podfileClean).toContain('# No Sparkling methods found');

      const settings = fs.readFileSync(path.join(cwd, 'android', 'settings.gradle.kts'), 'utf8');
      expect(settings).not.toContain('sparkling-navigation');

      const gradle = fs.readFileSync(path.join(cwd, 'android', 'app', 'build.gradle.kts'), 'utf8');
      expect(gradle).not.toContain('sparkling-navigation');
    });
  });
});
