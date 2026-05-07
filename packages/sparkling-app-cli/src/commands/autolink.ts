// Copyright (c) 2025 TikTok Pte. Ltd.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.
import path from 'node:path';
import fg from 'fast-glob';
import fs from 'fs-extra';
import { loadAppConfig } from '../config';
import {
  MethodModuleConfig,
  SparklingAutolinkElement,
  SparklingAutolinkMethod,
  SparklingAutolinkNativeModule,
  SparklingAutolinkService,
} from '../types';
import { relativeTo, toPosixPath } from '../utils/paths';
import { isVerboseEnabled, verboseLog } from '../utils/verbose';
import { ui } from '../utils/ui';

type GradleDsl = 'kotlin' | 'groovy';

const ANDROID_AUTOLINK_START = '// BEGIN SPARKLING AUTOLINK';
const ANDROID_AUTOLINK_END = '// END SPARKLING AUTOLINK';
const IOS_AUTOLINK_START = '# BEGIN SPARKLING AUTOLINK';
const IOS_AUTOLINK_END = '# END SPARKLING AUTOLINK';

export interface AutolinkOptions {
  cwd: string;
  configFile?: string;
  platform?: 'android' | 'ios' | 'all';
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => asString(item)).filter((item): item is string => Boolean(item));
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const str = asString(value);
    if (str) return str;
  }
  return undefined;
}

function isConfigNamed(filePath: string, name: string): boolean {
  return path.basename(filePath) === name;
}

function normalizeFullClassName(className: string | undefined, packageName?: string): string | undefined {
  if (!className) return undefined;
  if (className.includes('.')) return className;
  return packageName ? `${packageName}.${className}` : className;
}

function getPlatformConfig(config: JsonObject, platform: 'android' | 'ios'): JsonObject {
  const platformMap = asObject(config.platforms);
  const fromPlatforms = asObject(platformMap?.[platform]);
  const legacy = asObject(config[platform]);
  return { ...(legacy ?? {}), ...(fromPlatforms ?? {}) };
}

function supportsPlatform(config: JsonObject, platform: 'android' | 'ios'): boolean {
  const platforms = config.platforms;
  if (Array.isArray(platforms)) {
    return platforms.includes(platform);
  }
  if (asObject(platforms)) {
    return Boolean(asObject(platforms)?.[platform]);
  }
  return Boolean(asObject(config[platform]));
}

function normalizeEntries<T>(
  rawEntries: unknown,
  platformKey: 'android' | 'ios',
  normalize: (entry: JsonObject) => T | undefined,
): T[] {
  const entries = Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : [];
  const result: T[] = [];
  for (const rawEntry of entries) {
    const entry = asObject(rawEntry);
    if (!entry) continue;
    const platformEntry = asObject(entry[platformKey]);
    const normalized = normalize({ ...entry, ...(platformEntry ?? {}) });
    if (normalized) result.push(normalized);
  }
  return result;
}

function mergeEntries<T extends { name?: string; className?: string }>(base: T[], extra: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const entry of [...base, ...extra]) {
    const key = `${entry.name ?? ''}:${entry.className ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function normalizeElements(
  rawEntries: unknown,
  platformKey: 'android' | 'ios',
  defaultPackage?: string,
): SparklingAutolinkElement[] {
  return normalizeEntries(rawEntries, platformKey, entry => {
    const name = firstString(entry.name, entry.elementName, entry.tagName);
    const packageName = firstString(entry.packageName, defaultPackage);
    const className = normalizeFullClassName(firstString(entry.className, entry.uiClass, entry.type), packageName);
    return name && className ? { name, className, packageName } : undefined;
  });
}

function normalizeNativeModules(
  rawEntries: unknown,
  platformKey: 'android' | 'ios',
  defaultPackage?: string,
): SparklingAutolinkNativeModule[] {
  return normalizeEntries(rawEntries, platformKey, entry => {
    const name = firstString(entry.name, entry.moduleName);
    const packageName = firstString(entry.packageName, defaultPackage);
    const className = normalizeFullClassName(firstString(entry.className, entry.moduleClass, entry.type), packageName);
    const rawScope = firstString(entry.scope);
    const scope = rawScope === 'global' ? 'global' : 'view';
    return name && className ? { name, className, packageName, scope } : undefined;
  });
}

function normalizeServices(
  rawEntries: unknown,
  platformKey: 'android' | 'ios',
  defaultPackage?: string,
): SparklingAutolinkService[] {
  return normalizeEntries(rawEntries, platformKey, entry => {
    const packageName = firstString(entry.packageName, defaultPackage);
    const className = normalizeFullClassName(firstString(entry.className, entry.serviceClass, entry.type), packageName);
    const protocolName = firstString(entry.protocolName, entry.protocol);
    return className ? { className, packageName, protocolName } : undefined;
  });
}

function normalizeSparklingMethods(
  rawEntries: unknown,
  platformKey: 'android' | 'ios',
  defaultPackage?: string,
): SparklingAutolinkMethod[] {
  const fromArray = normalizeEntries(rawEntries, platformKey, entry => {
    const packageName = firstString(entry.packageName, defaultPackage);
    const className = normalizeFullClassName(firstString(entry.className, entry.methodClass, entry.type), packageName);
    return className ? { className, packageName } : undefined;
  });
  const fromClasses = asStringArray(asObject(rawEntries)?.classes).map(className => ({
    className: normalizeFullClassName(className, defaultPackage) ?? className,
    packageName: defaultPackage,
  }));
  return mergeEntries(fromArray, fromClasses);
}

function resolveDefaultIosPodspec(moduleRoot: string): string {
  const iosDir = path.resolve(moduleRoot, 'ios');
  if (fs.existsSync(iosDir)) {
    const podspecs = fs.readdirSync(iosDir)
      .filter(file => file.endsWith('.podspec'))
      .sort();
    if (podspecs[0]) return path.join(iosDir, podspecs[0]);
  }
  return iosDir;
}

function resolvePodspecFile(podspecPath: string): string | undefined {
  if (!fs.existsSync(podspecPath)) return undefined;
  const stat = fs.statSync(podspecPath);
  if (stat.isFile()) return podspecPath;
  if (!stat.isDirectory()) return undefined;
  const podspecs = fs.readdirSync(podspecPath)
    .filter(file => file.endsWith('.podspec'))
    .sort();
  return podspecs[0] ? path.join(podspecPath, podspecs[0]) : undefined;
}

function swiftModuleNameFromPodName(podName: string): string {
  return podName.replace(/[^A-Za-z0-9_]/g, '_');
}

function normalizeGradleProjectName(name: string): string {
  return name.replace(/^@/, '').replace(/[^A-Za-z0-9_.-]+/g, '-');
}

function androidProjectName(module: MethodModuleConfig): string {
  return module.android?.projectName ?? normalizeGradleProjectName(module.name);
}

/**
 * Extract workspace glob patterns from a candidate workspace root.
 * Supports npm/yarn (package.json "workspaces"), pnpm (pnpm-workspace.yaml),
 * and lerna (lerna.json "packages").
 * Returns the patterns array, or null if none could be extracted.
 */
function getWorkspacePatterns(candidateRoot: string): string[] | null {
  // 1. package.json with "workspaces" (npm / yarn)
  const pkgPath = path.join(candidateRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
      if (Array.isArray(pkg.workspaces?.packages)) return pkg.workspaces.packages;
    } catch { /* ignore */ }
  }

  // 2. pnpm-workspace.yaml — parse the "packages:" list with a simple regex
  //    since we don't have a YAML parser dependency.
  const pnpmWsPath = path.join(candidateRoot, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmWsPath)) {
    try {
      const content = fs.readFileSync(pnpmWsPath, 'utf8');
      const patterns: string[] = [];
      // Match lines like "  - 'packages/*'" or "  - packages/*"
      const lineRe = /^\s*-\s+['"]?([^'"#\n]+?)['"]?\s*$/gm;
      let m: RegExpExecArray | null;
      while ((m = lineRe.exec(content)) !== null) {
        const p = m[1].trim();
        if (p) patterns.push(p);
      }
      if (patterns.length) return patterns;
    } catch { /* ignore */ }
  }

  // 3. lerna.json with "packages"
  const lernaPath = path.join(candidateRoot, 'lerna.json');
  if (fs.existsSync(lernaPath)) {
    try {
      const lerna = JSON.parse(fs.readFileSync(lernaPath, 'utf8'));
      if (Array.isArray(lerna.packages)) return lerna.packages;
    } catch { /* ignore */ }
  }

  return null;
}

/**
 * Check whether `cwd` is a member of the workspace rooted at `wsRoot` by
 * testing the relative path of `cwd` against the workspace glob patterns.
 *
 * For example, if wsRoot has patterns ["packages/*"] and cwd is
 * "<wsRoot>/packages/my-app", the relative path "packages/my-app" matches
 * the pattern "packages/*", so this returns true.
 */
function isWorkspaceMember(wsRoot: string, cwd: string, patterns: string[]): boolean {
  const rel = toPosixPath(path.relative(wsRoot, cwd));
  if (!rel || rel.startsWith('..')) return false;

  // Use minimatch-style matching via fast-glob's micromatch (available
  // through fast-glob internals). We do a simple manual check instead to
  // avoid relying on internal APIs: convert each workspace pattern to a
  // regex that matches the relative path.
  for (const pattern of patterns) {
    const posixPattern = toPosixPath(pattern);
    // Convert glob pattern to regex:
    //   "packages/*"  -> matches "packages/foo" (one level)
    //   "packages/**" -> matches "packages/foo" and "packages/foo/bar"
    //   "apps/*"      -> matches "apps/my-app"
    const regexStr = posixPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex special chars (except * and ?)
      .replace(/\*\*/g, '__GLOBSTAR__')        // placeholder for **
      .replace(/\*/g, '[^/]+')                 // * matches one path segment
      .replace(/__GLOBSTAR__/g, '.+');          // ** matches one or more segments
    const re = new RegExp(`^${regexStr}$`);
    if (re.test(rel)) return true;
  }
  return false;
}

/**
 * Detect whether `cwd` lives inside a monorepo by walking up to find a
 * workspace-root marker (package.json with "workspaces", pnpm-workspace.yaml,
 * or lerna.json) between the parent directory and the filesystem root.
 *
 * To avoid false positives (e.g. an unrelated workspace root higher up in the
 * directory tree), this function also verifies that `cwd` actually matches one
 * of the workspace's glob patterns before accepting it as a monorepo member.
 *
 * Returns the workspace root path if found, otherwise null.
 */
function findWorkspaceRoot(cwd: string): string | null {
  const parentDir = path.dirname(cwd);
  let current = parentDir;
  const { root } = path.parse(cwd);

  while (true) {
    const patterns = getWorkspacePatterns(current);
    if (patterns && patterns.length > 0) {
      if (isWorkspaceMember(current, cwd, patterns)) {
        return current;
      }
      // Found a workspace root but cwd is not a member — keep searching
      // upward in case of nested workspaces, but this is uncommon. In most
      // cases we should stop here to avoid scanning unrelated directories.
      if (isVerboseEnabled()) {
        verboseLog(
          `Found workspace root at ${current} but ${cwd} is not listed as a member; skipping.`,
        );
      }
    }

    if (current === root) break;
    current = path.dirname(current);
  }
  return null;
}

function readPackageJsonName(moduleRoot: string): string | undefined {
  const pkgPath = path.join(moduleRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return undefined;
  try {
    const pkg = fs.readJSONSync(pkgPath) as JsonObject;
    return asString(pkg.name);
  } catch {
    return undefined;
  }
}

function shouldReplaceDiscoveredModule(
  existing: MethodModuleConfig | undefined,
  nextConfigPath: string,
  nextIsNodeModule: boolean,
): boolean {
  if (!existing) return true;
  const existingIsNodeModule = existing.root.includes(`${path.sep}node_modules${path.sep}`);
  if (existingIsNodeModule && !nextIsNodeModule) return true;
  if (!existingIsNodeModule && nextIsNodeModule) return false;

  const existingConfigPath = existing.configPath ?? '';
  if (isConfigNamed(existingConfigPath, 'module.config.json') && isConfigNamed(nextConfigPath, 'lynx.ext.json')) {
    return true;
  }
  return false;
}

function normalizeDiscoveredConfig(configPath: string, config: JsonObject): MethodModuleConfig | undefined {
  const moduleRoot = path.dirname(configPath);
  const name = firstString(config.name, readPackageJsonName(moduleRoot), path.basename(moduleRoot));
  if (!name) return undefined;

  const hasExplicitPlatforms = Array.isArray(config.platforms) || Boolean(asObject(config.platforms));
  const includeAndroid = hasExplicitPlatforms ? supportsPlatform(config, 'android') : true;
  const includeIos = hasExplicitPlatforms ? supportsPlatform(config, 'ios') : true;

  const androidConfig = includeAndroid ? getPlatformConfig(config, 'android') : undefined;
  const iosConfig = includeIos ? getPlatformConfig(config, 'ios') : undefined;

  const androidPackageName = firstString(androidConfig?.packageName, config.packageName);
  const iosModuleName = firstString(iosConfig?.moduleName, config.moduleName);

  const androidBuild = androidConfig
    ? firstString(androidConfig.buildGradle)
      ? path.resolve(moduleRoot, firstString(androidConfig.buildGradle)!)
      : resolveDefaultAndroidBuildGradle(moduleRoot)
    : undefined;
  const iosPodspecPath = iosConfig
    ? firstString(iosConfig.podspecPath)
      ? path.resolve(moduleRoot, firstString(iosConfig.podspecPath)!)
      : resolveDefaultIosPodspec(moduleRoot)
    : undefined;

  const topElements = config.elements;
  const topNativeModules = config.nativeModules ?? config.modules;
  const topServices = config.services;
  const topSparklingMethods = config.sparklingMethods;

  const androidElements = androidConfig
    ? mergeEntries(
      normalizeElements(topElements, 'android', androidPackageName),
      normalizeElements(androidConfig.elements, 'android', androidPackageName),
    )
    : [];
  const androidNativeModules = androidConfig
    ? mergeEntries(
      normalizeNativeModules(topNativeModules, 'android', androidPackageName),
      normalizeNativeModules(androidConfig.nativeModules ?? androidConfig.modules, 'android', androidPackageName),
    )
    : [];
  const androidServices = androidConfig
    ? mergeEntries(
      normalizeServices(topServices, 'android', androidPackageName),
      normalizeServices(androidConfig.services, 'android', androidPackageName),
    )
    : [];
  const androidSparklingRaw = asObject(topSparklingMethods)?.android ?? androidConfig?.sparklingMethods ?? topSparklingMethods;
  const androidSparklingMethods = androidConfig
    ? normalizeSparklingMethods(androidSparklingRaw, 'android', androidPackageName)
    : [];

  const iosElements = iosConfig
    ? mergeEntries(
      normalizeElements(topElements, 'ios'),
      normalizeElements(iosConfig.elements, 'ios'),
    )
    : [];
  const iosNativeModules = iosConfig
    ? mergeEntries(
      normalizeNativeModules(topNativeModules, 'ios'),
      normalizeNativeModules(iosConfig.nativeModules ?? iosConfig.modules, 'ios'),
    )
    : [];
  const iosServices = iosConfig
    ? mergeEntries(
      normalizeServices(topServices, 'ios'),
      normalizeServices(iosConfig.services, 'ios'),
    )
    : [];
  const iosSparklingRaw = asObject(topSparklingMethods)?.ios ?? iosConfig?.sparklingMethods ?? topSparklingMethods;
  const iosSparklingMethods = iosConfig
    ? normalizeSparklingMethods(iosSparklingRaw, 'ios')
    : [];

  return {
    name,
    root: moduleRoot,
    configPath,
    devtool: config.devtool === true,
    elements: mergeEntries(androidElements, iosElements),
    nativeModules: mergeEntries(androidNativeModules, iosNativeModules),
    services: mergeEntries(androidServices, iosServices),
    sparklingMethods: mergeEntries(androidSparklingMethods, iosSparklingMethods),
    android: androidConfig && androidBuild ? {
      packageName: androidPackageName,
      className: firstString(androidConfig.className, config.className),
      projectName: firstString(androidConfig.projectName, config.projectName),
      projectDir: path.dirname(androidBuild),
      buildGradle: androidBuild,
      elements: androidElements,
      nativeModules: androidNativeModules,
      services: androidServices,
      sparklingMethods: androidSparklingMethods,
    } : undefined,
    ios: iosConfig && iosPodspecPath ? {
      moduleName: iosModuleName,
      importName: firstString(iosConfig.importName, iosConfig.swiftModuleName),
      className: firstString(iosConfig.className, config.className),
      podspecPath: iosPodspecPath,
      elements: iosElements,
      nativeModules: iosNativeModules,
      services: iosServices,
      sparklingMethods: iosSparklingMethods,
    } : undefined,
  };
}

async function discoverModules(cwd: string): Promise<MethodModuleConfig[]> {
  if (!cwd || typeof cwd !== 'string') {
    console.warn(ui.warn('discoverModules: cwd must be a non-empty string'));
    return [];
  }

  const seen = new Map<string, MethodModuleConfig>();
  const nodeModulesDir = path.resolve(cwd, 'node_modules');

  interface SearchEntry {
    root: string;
    pattern: string;
    ignore: string[];
  }

  const searches: SearchEntry[] = [];

  // 1. Sibling packages — only scan when inside a monorepo to avoid crawling
  //    large directories (e.g. ~/Documents) for standalone projects.
  const workspaceRoot = findWorkspaceRoot(cwd);
  if (workspaceRoot) {
    if (isVerboseEnabled()) {
      verboseLog(`Detected workspace root at ${workspaceRoot}`);
    }
    searches.push({
      root: workspaceRoot,
      // Scan up to 3 levels deep to cover common monorepo layouts
      // (e.g. packages/methods/my-method/lynx.ext.json)
      pattern: '{*/,*/*/,*/*/*/}{lynx.ext.json,module.config.json}',
      ignore: ['node_modules/**', 'dist/**', '.turbo/**', '.rslib/**'],
    });
  } else if (isVerboseEnabled()) {
    verboseLog('No workspace root detected, skipping sibling package scan.');
  }

  // 2. node_modules — use targeted patterns for sparkling method packages
  //    instead of a full recursive crawl.
  if (fs.existsSync(nodeModulesDir)) {
    searches.push({
      root: nodeModulesDir,
      // lynx.ext.json is the RFC manifest, so scan normal top-level and
      // scoped packages. module.config.json remains targeted to Sparkling
      // method package naming to avoid crawling all node_modules recursively.
      pattern: '{*/,@*/*/}lynx.ext.json',
      ignore: ['**/dist/**', '**/.turbo/**', '**/.rslib/**'],
    });
    searches.push({
      root: nodeModulesDir,
      pattern: '{sparkling-*/,@*/sparkling-*/}module.config.json',
      ignore: ['**/dist/**', '**/.turbo/**', '**/.rslib/**'],
    });
  }

  for (const search of searches) {
    // Skip if root directory doesn't exist
    if (!fs.existsSync(search.root)) {
      continue;
    }

    if (isVerboseEnabled()) {
      verboseLog(`Scanning for ${search.pattern} under ${search.root}`);
    }

    let matches: string[] = [];
    try {
      matches = await fg(search.pattern, {
        cwd: search.root,
        absolute: true,
        ignore: search.ignore,
      });
    } catch (error) {
      console.warn(ui.warn(`Failed to search for modules in ${search.root}: ${error instanceof Error ? error.message : String(error)}`));
      continue;
    }

    if (isVerboseEnabled()) {
      verboseLog(`Found ${matches.length} module config(s) under ${search.root}`);
    }

    for (const configPath of matches) {
      const moduleRoot = path.dirname(configPath);

      let config: Record<string, unknown>;
      try {
        config = fs.readJSONSync(configPath);
      } catch (error) {
        console.warn(ui.warn(`Failed to read module config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`));
        continue;
      }

      const configObject = asObject(config);
      if (!configObject) {
        console.warn(ui.warn(`Invalid module config at ${configPath}: config must be an object`));
        continue;
      }

      const normalized = normalizeDiscoveredConfig(configPath, configObject);
      if (!normalized) {
        console.warn(ui.warn(`Invalid module config at ${configPath}: could not determine module name`));
        continue;
      }

      if (isVerboseEnabled()) {
        verboseLog(`Discovered native extension "${normalized.name}" at ${moduleRoot}`);
      }

      const isNodeModule = moduleRoot.includes(`${path.sep}node_modules${path.sep}`);
      const existing = seen.get(normalized.name);
      if (!shouldReplaceDiscoveredModule(existing, configPath, isNodeModule)) {
        continue;
      }
      seen.set(normalized.name, normalized);
    }
  }

  return Array.from(seen.values());
}

function detectGradleDsl(filePath: string): GradleDsl {
  return filePath.endsWith('.kts') ? 'kotlin' : 'groovy';
}

function resolveAndroidSettingsFile(cwd: string): { path: string; dsl: GradleDsl } | null {
  const kts = path.resolve(cwd, 'android/settings.gradle.kts');
  const groovy = path.resolve(cwd, 'android/settings.gradle');
  if (fs.existsSync(kts)) return { path: kts, dsl: 'kotlin' };
  if (fs.existsSync(groovy)) return { path: groovy, dsl: 'groovy' };
  return null;
}

function resolveAndroidAppGradle(cwd: string): { path: string; dsl: GradleDsl } | null {
  const kts = path.resolve(cwd, 'android/app/build.gradle.kts');
  const groovy = path.resolve(cwd, 'android/app/build.gradle');
  if (fs.existsSync(kts)) return { path: kts, dsl: 'kotlin' };
  if (fs.existsSync(groovy)) return { path: groovy, dsl: 'groovy' };
  return null;
}

function resolveDefaultAndroidBuildGradle(moduleRoot: string): string {
  const kts = path.resolve(moduleRoot, 'android', 'build.gradle.kts');
  const groovy = path.resolve(moduleRoot, 'android', 'build.gradle');
  if (fs.existsSync(kts)) return kts;
  if (fs.existsSync(groovy)) return groovy;
  return kts;
}

function stripExistingAndroidIncludes(content: string, moduleNames: string[]): string {
  let updated = content;
  for (const name of moduleNames) {
    const includeRegex = new RegExp(`\\s*include\\(?\\s*['"]:(${name})['"]\\)?\\s*\\n?`, 'g');
    const projectDirRegex = new RegExp(`\\s*project\\(":${name}"\\)\\.projectDir\\s*=\\s*file\\([^\\n]+\\)\\s*\\n?`, 'g');
    updated = updated.replace(includeRegex, '');
    updated = updated.replace(projectDirRegex, '');
  }
  return updated;
}

function injectAndroidSettings(settingsPath: string, modules: MethodModuleConfig[], projectDir: string) {
  if (!fs.existsSync(settingsPath)) {
    console.warn(ui.warn(`Android settings not found at ${settingsPath}, skipping android autolink`));
    return;
  }

  const dsl = detectGradleDsl(settingsPath);
  let content = fs.readFileSync(settingsPath, 'utf8');
  content = content.replace(new RegExp(`${ANDROID_AUTOLINK_START}[\\s\\S]*?${ANDROID_AUTOLINK_END}\\s*`, 'm'), '');
  content = stripExistingAndroidIncludes(content, modules.map(androidProjectName));

  if (!modules.length) {
    fs.writeFileSync(settingsPath, content);
    return;
  }

  const lines = modules.map(module => {
    const rel = relativeTo(projectDir, module.android?.projectDir ?? module.root);
    return `  "${androidProjectName(module)}" to file("${toPosixPath(rel)}")`;
  }).join(',\n');

  const ktsBlock = [
    ANDROID_AUTOLINK_START,
    'val sparklingAutolinkProjects = listOf<Pair<String, java.io.File>>(',
    lines,
    ')',
    'sparklingAutolinkProjects.forEach { (name, dir) ->',
    '    include(":$name")',
    '    project(":$name").projectDir = dir',
    '}',
    ANDROID_AUTOLINK_END,
  ].join('\n');

  const groovyLines = modules.map(module => {
    const rel = relativeTo(projectDir, module.android?.projectDir ?? module.root);
    return `  [name: "${androidProjectName(module)}", dir: file("${toPosixPath(rel)}")]`;
  }).join(',\n');

  const groovyBlock = [
    ANDROID_AUTOLINK_START,
    'def sparklingAutolinkProjects = [',
    groovyLines,
    ']',
    'sparklingAutolinkProjects.each { projectDef ->',
    '    include(":${projectDef.name}")',
    '    project(":${projectDef.name}").projectDir = projectDef.dir',
    '}',
    ANDROID_AUTOLINK_END,
  ].join('\n');

  const block = dsl === 'kotlin' ? ktsBlock : groovyBlock;

  fs.writeFileSync(settingsPath, `${content.trimEnd()}\n\n${block}\n`);
}

function findDependenciesBlock(content: string): { block: string; start: number; end: number } | null {
  const depIndex = content.indexOf('dependencies');
  if (depIndex === -1) return null;
  const braceStart = content.indexOf('{', depIndex);
  if (braceStart === -1) return null;
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = braceStart; i < content.length; i += 1) {
    const ch = content[i];
    const next = content[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '/' && next === '/') {
        inLineComment = true;
        i += 1;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i += 1;
        continue;
      }
    }
    if (!inDoubleQuote && ch === '\'' && content[i - 1] !== '\\') {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (!inSingleQuote && ch === '"' && content[i - 1] !== '\\') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) {
      continue;
    }

    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          block: content.slice(depIndex, i + 1),
          start: depIndex,
          end: i,
        };
      }
    }
  }

  return null;
}

function stripAndroidAutolinkBlock(content: string): string {
  const pattern = new RegExp(`\\n?[ \\t]*${ANDROID_AUTOLINK_START}[\\s\\S]*?${ANDROID_AUTOLINK_END}[ \\t]*\\n?`, 'gm');
  const cleaned = content.replace(pattern, '\n');
  return cleaned.replace(/\n{3,}/g, '\n\n');
}

function calculateBraceBalance(content: string): number {
  let balance = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTripleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    const next = content[i + 1];
    const next2 = content[i + 2];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inTripleQuote) {
      if (ch === '"' && next === '"' && next2 === '"') {
        inTripleQuote = false;
        i += 2;
      }
      continue;
    }
    if (inSingleQuote) {
      if (ch === '\'' && content[i - 1] !== '\\') {
        inSingleQuote = false;
      }
      continue;
    }
    if (inDoubleQuote) {
      if (ch === '"' && content[i - 1] !== '\\') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' && next === '"' && next2 === '"') {
      inTripleQuote = true;
      i += 2;
      continue;
    }
    if (ch === '\'' && content[i - 1] !== '\\') {
      inSingleQuote = true;
      continue;
    }
    if (ch === '"' && content[i - 1] !== '\\') {
      inDoubleQuote = true;
      continue;
    }

    if (ch === '{') {
      balance += 1;
    } else if (ch === '}') {
      balance -= 1;
    }
  }

  return balance;
}

function normalizeBraceBalance(content: string): string {
  const balance = calculateBraceBalance(content);
  if (balance === 0) {
    return content;
  }

  if (balance < 0) {
    let adjusted = content;
    let extraClosings = Math.abs(balance);
    while (extraClosings > 0) {
      const lastBrace = adjusted.lastIndexOf('}');
      if (lastBrace === -1) break;
      adjusted = `${adjusted.slice(0, lastBrace)}${adjusted.slice(lastBrace + 1)}`;
      extraClosings -= 1;
    }

    return adjusted;
  }

  // If we are missing closing braces, append them using a best-effort indent
  const lines = content.split('\n');
  let indent = '';
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim()) {
      const match = lines[i].match(/^[ \t]*/);
      indent = match ? match[0] : '';
      break;
    }
  }

  const closings: string[] = [];
  let remaining = balance;
  let currentIndent = indent;
  while (remaining > 0) {
    closings.push(`${currentIndent}}`);
    currentIndent = currentIndent.length >= 4 ? currentIndent.slice(0, currentIndent.length - 4) : '';
    remaining -= 1;
  }

  return `${content.trimEnd()}\n${closings.join('\n')}\n`;
}

function injectAndroidDependencies(appGradlePath: string, modules: MethodModuleConfig[]) {
  if (!fs.existsSync(appGradlePath)) {
    console.warn(ui.warn(`Android app gradle not found at ${appGradlePath}, skipping android dependency autolink`));
    return;
  }

  const dsl = detectGradleDsl(appGradlePath);
  let content = fs.readFileSync(appGradlePath, 'utf8');
  content = stripAndroidAutolinkBlock(content);
  for (const module of modules) {
    const projectName = androidProjectName(module);
    const depPatterns = [
      new RegExp(`\\s*implementation\\s*\\(\\s*project\\(["']:${projectName}["']\\)\\s*\\)\\s*\\n?`, 'g'),
      new RegExp(`\\s*implementation\\s+project\\(["']:${projectName}["']\\)\\s*\\n?`, 'g'),
    ];
    for (const depPattern of depPatterns) {
      content = content.replace(depPattern, '');
    }
  }

  if (!modules.length) {
    fs.writeFileSync(appGradlePath, content);
    return;
  }

  // Determine base indent of the dependencies block for consistent formatting
  const depIndentMatch = content.match(/^([ \t]*)dependencies\s*\{/m);
  const depIndent = depIndentMatch ? depIndentMatch[1] : '';
  const innerIndent = `${depIndent}    `;

  const regularModules = modules.filter(m => !m.devtool);
  const devtoolModules = modules.filter(m => m.devtool);

  const ktsLines: string[] = [];
  if (regularModules.length) {
    const depLinesKts = regularModules.map(m => `${innerIndent}    project(":${androidProjectName(m)}")`).join(',\n');
    ktsLines.push(
      `${innerIndent}listOf(`,
      depLinesKts,
      `${innerIndent}).forEach { dep -> add("implementation", dep) }`,
    );
  }
  for (const m of devtoolModules) {
    ktsLines.push(`${innerIndent}debugImplementation(project(":${androidProjectName(m)}"))`);
  }
  const ktsBlock = [
    `${innerIndent}// BEGIN SPARKLING AUTOLINK`,
    ...ktsLines,
    `${innerIndent}// END SPARKLING AUTOLINK`,
  ].join('\n');

  const groovyLines: string[] = [];
  if (regularModules.length) {
    const depLinesGroovy = regularModules.map(m => `${innerIndent}    project(":${androidProjectName(m)}")`).join(',\n');
    groovyLines.push(
      `${innerIndent}[`,
      depLinesGroovy,
      `${innerIndent}].each { dep -> add("implementation", dep) }`,
    );
  }
  for (const m of devtoolModules) {
    groovyLines.push(`${innerIndent}debugImplementation project(":${androidProjectName(m)}")`);
  }
  const groovyBlock = [
    `${innerIndent}// BEGIN SPARKLING AUTOLINK`,
    ...groovyLines,
    `${innerIndent}// END SPARKLING AUTOLINK`,
  ].join('\n');

  const block = dsl === 'kotlin' ? ktsBlock : groovyBlock;

  const closingIndent = depIndent;
  const dependenciesBlock = findDependenciesBlock(content);
  if (!dependenciesBlock) {
    // Fallback: regex-based insertion before the closing brace of dependencies block
    const re = /(^[ \t]*dependencies\s*\{[\s\S]*?)(\n?[ \t]*\})/m;
    const replaced = content.replace(re, (_m, p1: string, p2: string) => {
      // Strip any stray closing braces accidentally stuck at the end of the block content
      const cleanP1 = String(p1).replace(/[ \t]*\}+[ \t]*$/, '');
      return `${cleanP1}\n\n${block}\n${closingIndent}}`;
    });
    const cleaned = normalizeBraceBalance(replaced);
    fs.writeFileSync(appGradlePath, cleaned);
    return;
  }

  // Determine the indentation of the closing brace line (if present)
  // Close with the same indent as the opening 'dependencies' line

  // Robustly remove the final closing brace, regardless of preceding newline
  const dependenciesWithoutClosing = dependenciesBlock.block.replace(/}\s*$/, '');

  // Compose updated dependencies block with autolink section and a single closing brace
  const cleanedWithoutClosing = dependenciesWithoutClosing.replace(/[ \t]*\}+[ \t]*$/, '').trimEnd();
  const updatedDependencies = `${cleanedWithoutClosing}\n\n${block}\n${closingIndent}}`;
  let updated = `${content.slice(0, dependenciesBlock.start)}${updatedDependencies}${content.slice(dependenciesBlock.end + 1)}`;
  // Safety: if autolink block isn't present due to edge formatting, try regex-based replacement
  if (!updated.includes(ANDROID_AUTOLINK_START)) {
    const re = /(^[ \t]*dependencies\s*\{[\s\S]*?)(\n?[ \t]*\})/m;
    updated = updated.replace(re, (_m, p1: string, p2: string) => {
      const cleanP1 = String(p1).replace(/[ \t]*\}+[ \t]*$/, '');
      return `${cleanP1}\n\n${block}\n${closingIndent}}`;
    });
  }
  // Remove any duplicate trailing braces (historical corruption fix)
  const finalContent = normalizeBraceBalance(updated);
  fs.writeFileSync(appGradlePath, finalContent);
}

function resolvePodName(module: MethodModuleConfig): string {
  // Derive the pod name from the podspec file when available, since the
  // podspec `s.name` is the authoritative CocoaPods identifier.
  if (module.ios?.podspecPath) {
    const podspecFile = resolvePodspecFile(module.ios.podspecPath) ?? module.ios.podspecPath;
    if (fs.existsSync(podspecFile)) {
      try {
        const content = fs.readFileSync(podspecFile, 'utf8');
        const nameMatch = content.match(/\.name\s*=\s*['"]([^'"]+)['"]/);
        if (nameMatch?.[1]) return nameMatch[1];
      } catch {
        // fall through to heuristic
      }
    }
    // Fallback: derive from the podspec filename (e.g. Sparkling-Router.podspec → Sparkling-Router)
    const basename = path.basename(podspecFile, '.podspec');
    if (basename) return basename;
  }
  return module.ios?.moduleName ? `Sparkling-${module.ios.moduleName}` : module.name;
}

function buildPodLine(module: MethodModuleConfig, podfilePath: string): string {
  const resolvedPodspec = module.ios?.podspecPath ? resolvePodspecFile(module.ios.podspecPath) : undefined;
  const podspecDir = resolvedPodspec
    ? path.dirname(resolvedPodspec)
    : module.ios?.podspecPath
      ? module.ios.podspecPath.endsWith('.podspec')
        ? path.dirname(module.ios.podspecPath)
        : module.ios.podspecPath
      : module.root;
  const rel = relativeTo(path.dirname(podfilePath), podspecDir);
  const podName = resolvePodName(module);
  return `  pod '${podName}', :path => '${toPosixPath(rel)}'`;
}

function replaceDefBlock(content: string, defName: string, newBody: string): string {
  const start = content.indexOf(`def ${defName}`);
  if (start === -1) return content;
  const end = content.indexOf('\nend', start);
  if (end === -1) return content;
  const existing = content.slice(start, end + '\nend'.length);
  return content.replace(existing, newBody);
}

function injectPodfile(podfilePath: string, modules: MethodModuleConfig[], projectDir: string) {
  if (!fs.existsSync(podfilePath)) {
    console.warn(ui.warn(`Podfile not found at ${podfilePath}, skipping iOS autolink`));
    return;
  }

  let content = fs.readFileSync(podfilePath, 'utf8');

  const regularModules = modules.filter(m => !m.devtool);
  const devtoolModules = modules.filter(m => m.devtool);

  // --- sparkling_methods_dep (regular method modules) ---
  const hasMethodsDep = content.includes('def sparkling_methods_dep');
  if (!hasMethodsDep) {
    console.warn(ui.warn('Podfile missing def sparkling_methods_dep, skipping iOS autolink'));
    return;
  }

  const podLines = regularModules.map(m => buildPodLine(m, podfilePath)).join('\n');
  const methodsBlock = [
    'def sparkling_methods_dep',
    `  ${IOS_AUTOLINK_START}`,
    podLines || '  # No Sparkling methods found',
    `  ${IOS_AUTOLINK_END}`,
    'end',
  ].join('\n');
  content = replaceDefBlock(content, 'sparkling_methods_dep', methodsBlock);

  // --- sparkling_devtool (devtool modules, debug only) ---
  const devtoolPodLines = devtoolModules.map(m => buildPodLine(m, podfilePath)).join('\n');
  const devtoolBlock = [
    'def sparkling_devtool',
    `  ${IOS_AUTOLINK_START}`,
    devtoolPodLines || '  # No devtool modules',
    `  ${IOS_AUTOLINK_END}`,
    'end',
  ].join('\n');

  if (content.includes('def sparkling_devtool')) {
    content = replaceDefBlock(content, 'sparkling_devtool', devtoolBlock);
  } else {
    // Insert sparkling_devtool block right after sparkling_methods_dep
    const methodsEnd = content.indexOf('def sparkling_methods_dep');
    const methodsBlockEnd = content.indexOf('\nend', methodsEnd);
    if (methodsBlockEnd !== -1) {
      const insertPos = methodsBlockEnd + '\nend'.length;
      content = `${content.slice(0, insertPos)}\n\n${devtoolBlock}${content.slice(insertPos)}`;
    }
  }

  fs.writeFileSync(podfilePath, content);
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function androidRegisterLines(modules: MethodModuleConfig[]): string[] {
  const lines: string[] = [];
  for (const module of modules) {
    for (const element of module.android?.elements ?? []) {
      lines.push(`        SparklingAutolinkRegistry.registerElement(${quoted(element.name)}, ${quoted(element.className)})`);
    }
    for (const nativeModule of module.android?.nativeModules ?? []) {
      const registrar = nativeModule.scope === 'global' ? 'registerGlobalModule' : 'registerViewModule';
      lines.push(`        SparklingAutolinkRegistry.${registrar}(${quoted(nativeModule.name)}, ${quoted(nativeModule.className)})`);
    }
    for (const service of module.android?.services ?? []) {
      lines.push(`        SparklingAutolinkRegistry.registerService(${quoted(service.className)})`);
    }
    for (const method of module.android?.sparklingMethods ?? []) {
      lines.push(`        SparklingAutolinkRegistry.registerSparklingMethod(${quoted(method.className)})`);
    }
  }
  return lines;
}

function writeAndroidRegistry(modules: MethodModuleConfig[], appPackage: string, cwd: string) {
  const javaDir = path.resolve(cwd, 'android/app/src/main/java', ...appPackage.split('.'));
  fs.ensureDirSync(javaDir);
  const filePath = path.join(javaDir, 'SparklingAutolink.kt');
  const entries = modules.map(m => {
    const pkg = m.android?.packageName ?? '';
    const cls = m.android?.className ?? '';
    return `        SparklingAutolinkModule(name = "${m.name}", androidPackage = "${pkg}", className = "${cls}")`;
  }).join(',\n');
  const registerLines = androidRegisterLines(modules);

  const content = [
    `package ${appPackage}`,
    '',
    'import android.app.Application',
    'import com.lynx.tasm.LynxViewBuilder',
    'import com.tiktok.sparkling.hybridkit.lynx.SparklingAutolinkRegistry',
    '',
    'data class SparklingAutolinkModule(val name: String, val androidPackage: String?, val className: String?)',
    '',
    'object SparklingAutolink {',
    '    private var registered = false',
    '',
    '    val modules = listOf(',
    entries,
    '    )',
    '',
    '    @JvmStatic',
    '    fun register(application: Application) {',
    '        if (registered) return',
    '        registered = true',
    '        SparklingAutolinkRegistry.markGeneratedRegistered(application.packageName)',
    ...(registerLines.length ? registerLines : ['        // No native extensions discovered.']),
    '    }',
    '',
    '    @JvmStatic',
    '    fun configure(builder: LynxViewBuilder) {',
    '        SparklingAutolinkRegistry.configure(builder)',
    '    }',
    '}',
    '',
  ].join('\n');

  fs.writeFileSync(filePath, content);
}

function iosAutolinkImportName(module: MethodModuleConfig): string | undefined {
  if (!module.ios) return undefined;
  return module.ios.importName
    ?? (module.ios.moduleName && module.ios.elements?.length ? module.ios.moduleName : undefined)
    ?? swiftModuleNameFromPodName(resolvePodName(module));
}

function hasIosRuntimeEntries(module: MethodModuleConfig): boolean {
  return Boolean(
    module.ios?.elements?.length
    || module.ios?.nativeModules?.length
    || module.ios?.services?.length
    || module.ios?.sparklingMethods?.length,
  );
}

function iosRegisterLinesForModule(module: MethodModuleConfig): string[] {
  const lines: string[] = [];
  for (const element of module.ios?.elements ?? []) {
    lines.push(`        SPKAutolinkRegistry.shared.registerElement(name: ${quoted(element.name)}, type: ${element.className}.self)`);
  }
  for (const nativeModule of module.ios?.nativeModules ?? []) {
    lines.push(`        SPKAutolinkRegistry.shared.registerModule(name: ${quoted(nativeModule.name)}, type: ${nativeModule.className}.self)`);
  }
  for (const service of module.ios?.services ?? []) {
    if (!service.protocolName) continue;
    lines.push(`        SPKAutolinkRegistry.shared.registerService {`);
    lines.push(`            LynxServices.registerService(withProtocol: ${service.className}.self, protocol: ${service.protocolName}.self)`);
    lines.push('        }');
  }
  for (const method of module.ios?.sparklingMethods ?? []) {
    lines.push(`        MethodRegistry.global.register(methodType: ${method.className}.self)`);
  }
  return lines;
}

function writeIosRegistry(modules: MethodModuleConfig[], bundleId: string, cwd: string) {
  const filePath = path.resolve(cwd, 'ios/SparklingGo/SparklingGo/SparklingAutolink.swift');
  fs.ensureDirSync(path.dirname(filePath));
  const entries = modules.map(m => {
    const moduleName = m.ios?.moduleName ?? '';
    const cls = m.ios?.className ?? '';
    return `SparklingAutolinkModule(name: "${m.name}", iosModuleName: "${moduleName}", className: "${cls}")`;
  }).join(',\n    ');
  const runtimeModules = modules.filter(hasIosRuntimeEntries);
  const importLines = runtimeModules
    .map(module => iosAutolinkImportName(module))
    .filter((name): name is string => Boolean(name))
    .filter((name, index, names) => names.indexOf(name) === index)
    .flatMap(name => [`#if canImport(${name})`, `import ${name}`, '#endif']);
  const runtimeRegisterLines = runtimeModules.flatMap(module => {
    const importName = iosAutolinkImportName(module);
    const lines = iosRegisterLinesForModule(module);
    if (!lines.length) return [];
    return importName
      ? [`        #if canImport(${importName})`, ...lines, '        #endif']
      : lines;
  });

  const content = [
    '// Generated by sparkling autolink',
    'import Foundation',
    'import Lynx',
    'import Sparkling',
    'import SparklingMethod',
    ...importLines,
    '',
    'struct SparklingAutolinkModule {',
    '    let name: String',
    '    let iosModuleName: String?',
    '    let className: String?',
    '}',
    '',
    `let sparklingAutolinkBundleId = "${bundleId}"`,
    'let sparklingAutolinkModules: [SparklingAutolinkModule] = [',
    `    ${entries}`,
    ']',
    '',
    'enum SparklingAutolink {',
    '    private static var registered = false',
    '',
    '    static func register() {',
    '        guard !registered else { return }',
    '        registered = true',
    ...(runtimeRegisterLines.length ? runtimeRegisterLines : ['        // No native extensions discovered.']),
    '    }',
    '}',
    '',
  ].join('\n');

  fs.writeFileSync(filePath, content);
}

export async function autolink(options: AutolinkOptions): Promise<MethodModuleConfig[]> {
  const platform = options.platform ?? 'all';
  const doAndroid = platform === 'android' || platform === 'all';
  const doIos = platform === 'ios' || platform === 'all';
  let modules = await discoverModules(options.cwd);
  if (isVerboseEnabled()) {
    const moduleNames = modules.map(m => m.name).join(', ') || '(none)';
    verboseLog(`Autolink platforms -> android: ${doAndroid}, ios: ${doIos}`);
    verboseLog(`Autolink discovered modules: ${moduleNames}`);
  }
  // Prefer user-defined IDs but fall back to defaults to stay compatible even if config can't load.
  const defaultAndroidPackage = 'com.example.sparkling.go';
  const defaultIosBundle = 'com.example.sparkling.go';

  let androidPackage = defaultAndroidPackage;
  let iosBundle = defaultIosBundle;
  let devtoolEnabled = true;
  try {
    const { config } = await loadAppConfig(options.cwd, options.configFile ?? 'app.config.ts');
    if (doAndroid) {
      androidPackage = config.platform?.android?.packageName ?? defaultAndroidPackage;
    }
    if (doIos) {
      iosBundle = config.platform?.ios?.bundleIdentifier ?? defaultIosBundle;
    }
    devtoolEnabled = config.devtool !== false;
    if (isVerboseEnabled()) {
      verboseLog(`Autolink bundle identifiers -> android: ${androidPackage}, ios: ${iosBundle}`);
      verboseLog(`Autolink devtool enabled: ${devtoolEnabled}`);
    }
  } catch (error) {
    console.warn(ui.warn(`Failed to read app config for autolink, using defaults: ${String(error)}`));
  }

  if (!devtoolEnabled) {
    const removed = modules.filter(m => m.devtool);
    if (removed.length && isVerboseEnabled()) {
      verboseLog(`Excluding devtool modules (devtool: false in config): ${removed.map(m => m.name).join(', ')}`);
    }
    modules = modules.filter(m => !m.devtool);
  }

  if (!modules.length) {
    console.log(ui.info('No Sparkling method modules found. Cleaning up stale autolink entries...'));
  }

  if (doAndroid) {
    const androidSettings = resolveAndroidSettingsFile(options.cwd);
    const androidAppGradle = resolveAndroidAppGradle(options.cwd);
    const androidModules = modules.filter(m => m.android);
    if (!androidSettings) {
      console.warn(ui.warn('Android settings.gradle(.kts) not found, skipping android autolink'));
    } else {
      if (isVerboseEnabled()) {
        verboseLog(`Using android settings at ${androidSettings.path} (dsl: ${androidSettings.dsl})`);
      }
      injectAndroidSettings(androidSettings.path, androidModules, path.dirname(androidSettings.path));
    }
    if (!androidAppGradle) {
      console.warn(ui.warn('Android app build.gradle(.kts) not found, skipping android dependency autolink'));
    } else {
      if (isVerboseEnabled()) {
        verboseLog(`Using android app gradle at ${androidAppGradle.path} (dsl: ${androidAppGradle.dsl})`);
      }
      injectAndroidDependencies(androidAppGradle.path, androidModules);
    }
  }

  if (doIos) {
    const podfile = path.resolve(options.cwd, 'ios/Podfile');
    injectPodfile(podfile, modules.filter(m => m.ios), path.dirname(podfile));
  }

  // Registry files only contain regular method modules — devtool modules
  // don't expose bridge methods and should not appear in the registry.
  const registryModules = modules.filter(m => !m.devtool);

  // Always write registry files so stale entries from previously-linked
  // modules are cleaned up when all method modules are removed.
  if (doAndroid) {
    writeAndroidRegistry(registryModules.filter(m => m.android), androidPackage, options.cwd);
  }
  if (doIos) {
    writeIosRegistry(registryModules.filter(m => m.ios), iosBundle, options.cwd);
  }

  const platformLabel = platform === 'all' ? 'Android & iOS' : platform.toUpperCase();
  if (modules.length) {
    console.log(ui.success(`Autolinked ${modules.length} module(s) for ${platformLabel}.`));
  } else {
    console.log(ui.success(`Cleaned autolink entries for ${platformLabel}.`));
  }
  return modules;
}
