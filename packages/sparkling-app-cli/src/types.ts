// Copyright (c) 2025 TikTok Pte. Ltd.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.
// Avoid hard dependency on external type packages in library types; 
// use a minimal alias for Lynx config shape.

export interface PlatformConfig {
  android?: {
    packageName?: string;
  };
  ios?: {
    bundleIdentifier?: string;
    simulator?: string;
  };
}

export type LynxConfig = unknown;

export interface RouterEntry {
  path: string;
}

export interface RouterConfig {
  main?: RouterEntry;
  [name: string]: RouterEntry | undefined;
}

export interface SplashScreenPluginConfig {
  backgroundColor?: string;
  image?: string;
  imageWidth?: number;
  dark?: {
    image?: string;
    backgroundColor?: string;
  };
}

export type PluginConfig =
  | ['splash-screen', SplashScreenPluginConfig]
  | [string, Record<string, unknown>?];

export interface AppConfig {
  lynxConfig: LynxConfig;
  /** Sparkling CLI dev settings. */
  dev?: {
    server?: {
      /** Preferred dev server port for sparkling-app-cli dev/run commands. Defaults to 5969. */
      port?: number;
      /** Preferred dev server host for sparkling-app-cli dev command. */
      host?: string;
    };
  };
  appName?: string;
  platform?: PlatformConfig;
  paths?: {
    androidAssets?: string;
    iosAssets?: string;
  };
  appIcon?: string;
  router?: RouterConfig;
  plugin?: PluginConfig[];
  /** Enable sparkling-debug-tool integration. Defaults to true. Set to false to exclude the debug-tool module from all builds. */
  devtool?: boolean;
}

export interface MethodModuleConfig {
  name: string;
  root: string;
  /** When true, the module is a devtool module: linked with debugImplementation on Android and excluded from release on iOS. */
  devtool?: boolean;
  /** The source manifest used to discover this extension. */
  configPath?: string;
  /** Native extension capability metadata normalized from lynx.ext.json or module.config.json. */
  elements?: SparklingAutolinkElement[];
  nativeModules?: SparklingAutolinkNativeModule[];
  services?: SparklingAutolinkService[];
  sparklingMethods?: SparklingAutolinkMethod[];
  android?: {
    packageName?: string;
    className?: string;
    projectName?: string;
    projectDir?: string;
    buildGradle?: string;
    elements?: SparklingAutolinkElement[];
    nativeModules?: SparklingAutolinkNativeModule[];
    services?: SparklingAutolinkService[];
    sparklingMethods?: SparklingAutolinkMethod[];
  };
  ios?: {
    moduleName?: string;
    importName?: string;
    className?: string;
    podspecPath?: string;
    elements?: SparklingAutolinkElement[];
    nativeModules?: SparklingAutolinkNativeModule[];
    services?: SparklingAutolinkService[];
    sparklingMethods?: SparklingAutolinkMethod[];
  };
}

export type SparklingExtensionConfig = MethodModuleConfig;

export interface SparklingAutolinkElement {
  name: string;
  className: string;
  packageName?: string;
}

export interface SparklingAutolinkNativeModule {
  name: string;
  className: string;
  packageName?: string;
  /** Global modules are registered on LynxEnv; view modules are registered on each LynxViewBuilder. */
  scope?: 'global' | 'view';
}

export interface SparklingAutolinkService {
  className: string;
  packageName?: string;
  /** iOS service protocol, e.g. LynxServiceLogProtocol. */
  protocolName?: string;
}

export interface SparklingAutolinkMethod {
  className: string;
  packageName?: string;
}
