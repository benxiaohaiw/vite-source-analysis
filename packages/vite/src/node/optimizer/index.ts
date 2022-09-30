import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import _debug from 'debug'
import colors from 'picocolors'
import type { BuildOptions as EsbuildBuildOptions } from 'esbuild'
import { build } from 'esbuild'
import { init, parse } from 'es-module-lexer'
import { createFilter } from '@rollup/pluginutils'
import { getDepOptimizationConfig } from '../config'
import type { ResolvedConfig } from '../config'
import {
  arraify,
  createDebugger,
  emptyDir,
  flattenId,
  getHash,
  isOptimizable,
  lookupFile,
  normalizeId,
  normalizePath,
  removeDir,
  renameDir,
  writeFile
} from '../utils'
import { transformWithEsbuild } from '../plugins/esbuild'
import { ESBUILD_MODULES_TARGET } from '../constants'
import { esbuildCjsExternalPlugin, esbuildDepPlugin } from './esbuildDepPlugin'
import { scanImports } from './scan'
export {
  initDepsOptimizer,
  initDevSsrDepsOptimizer,
  getDepsOptimizer
} from './optimizer'

export const debuggerViteDeps = createDebugger('vite:deps')
const debug = debuggerViteDeps
const isDebugEnabled = _debug('vite:deps').enabled

const jsExtensionRE = /\.js$/i
const jsMapExtensionRE = /\.js\.map$/i

export type ExportsData = {
  hasImports: boolean
  // exported names (for `export { a as b }`, `b` is exported name)
  exports: readonly string[]
  facade: boolean
  // es-module-lexer has a facade detection but isn't always accurate for our
  // use case when the module has default export
  hasReExports?: boolean
  // hint if the dep requires loading as jsx
  jsxLoader?: boolean
}

export interface DepsOptimizer {
  metadata: DepOptimizationMetadata
  scanProcessing?: Promise<void>
  registerMissingImport: (id: string, resolved: string) => OptimizedDepInfo
  run: () => void

  isOptimizedDepFile: (id: string) => boolean
  isOptimizedDepUrl: (url: string) => boolean
  getOptimizedDepId: (depInfo: OptimizedDepInfo) => string
  delayDepsOptimizerUntil: (id: string, done: () => Promise<any>) => void
  registerWorkersSource: (id: string) => void
  resetRegisteredIds: () => void
  ensureFirstRun: () => void

  close: () => Promise<void>

  options: DepOptimizationOptions
}

export interface DepOptimizationConfig {
  /**
   * Force optimize listed dependencies (must be resolvable import paths,
   * cannot be globs).
   */
  include?: string[]
  /**
   * Do not optimize these dependencies (must be resolvable import paths,
   * cannot be globs).
   */
  exclude?: string[]
  /**
   * Force ESM interop when importing for these dependencies. Some legacy
   * packages advertise themselves as ESM but use `require` internally
   * @experimental
   */
  needsInterop?: string[]
  /**
   * Options to pass to esbuild during the dep scanning and optimization
   *
   * Certain options are omitted since changing them would not be compatible
   * with Vite's dep optimization.
   *
   * - `external` is also omitted, use Vite's `optimizeDeps.exclude` option
   * - `plugins` are merged with Vite's dep plugin
   *
   * https://esbuild.github.io/api
   */
  esbuildOptions?: Omit<
    EsbuildBuildOptions,
    | 'bundle'
    | 'entryPoints'
    | 'external'
    | 'write'
    | 'watch'
    | 'outdir'
    | 'outfile'
    | 'outbase'
    | 'outExtension'
    | 'metafile'
  >
  /**
   * List of file extensions that can be optimized. A corresponding esbuild
   * plugin must exist to handle the specific extension.
   *
   * By default, Vite can optimize `.mjs`, `.js`, `.ts`, and `.mts` files. This option
   * allows specifying additional extensions.
   *
   * @experimental
   */
  extensions?: string[]
  /**
   * Disables dependencies optimizations, true disables the optimizer during
   * build and dev. Pass 'build' or 'dev' to only disable the optimizer in
   * one of the modes. Deps optimization is enabled by default in dev only.
   * @default 'build'
   * @experimental
   */
  disabled?: boolean | 'build' | 'dev'
}

export type DepOptimizationOptions = DepOptimizationConfig & {
  /**
   * By default, Vite will crawl your `index.html` to detect dependencies that
   * need to be pre-bundled. If `build.rollupOptions.input` is specified, Vite
   * will crawl those entry points instead.
   *
   * If neither of these fit your needs, you can specify custom entries using
   * this option - the value should be a fast-glob pattern or array of patterns
   * (https://github.com/mrmlnc/fast-glob#basic-syntax) that are relative from
   * vite project root. This will overwrite default entries inference.
   */
  entries?: string | string[]
  /**
   * Force dep pre-optimization regardless of whether deps have changed.
   * @experimental
   */
  force?: boolean
}

export interface DepOptimizationResult {
  metadata: DepOptimizationMetadata
  /**
   * When doing a re-run, if there are newly discovered dependencies
   * the page reload will be delayed until the next rerun so we need
   * to be able to discard the result
   */
  commit: () => Promise<void>
  cancel: () => void
}

export interface DepOptimizationProcessing {
  promise: Promise<void>
  resolve: () => void
}

export interface OptimizedDepInfo {
  id: string
  file: string
  src?: string
  needsInterop?: boolean
  browserHash?: string
  fileHash?: string
  /**
   * During optimization, ids can still be resolved to their final location
   * but the bundles may not yet be saved to disk
   */
  processing?: Promise<void>
  /**
   * ExportData cache, discovered deps will parse the src entry to get exports
   * data used both to define if interop is needed and when pre-bundling
   */
  exportsData?: Promise<ExportsData>
}

export interface DepOptimizationMetadata {
  /**
   * The main hash is determined by user config and dependency lockfiles.
   * This is checked on server startup to avoid unnecessary re-bundles.
   */
  hash: string
  /**
   * The browser hash is determined by the main hash plus additional dependencies
   * discovered at runtime. This is used to invalidate browser requests to
   * optimized deps.
   */
  browserHash: string
  /**
   * Metadata for each already optimized dependency
   */
  optimized: Record<string, OptimizedDepInfo>
  /**
   * Metadata for non-entry optimized chunks and dynamic imports
   */
  chunks: Record<string, OptimizedDepInfo>
  /**
   * Metadata for each newly discovered dependency after processing
   */
  discovered: Record<string, OptimizedDepInfo>
  /**
   * OptimizedDepInfo list
   */
  depInfoList: OptimizedDepInfo[]
}

/**
 * 扫描且优化工程中的依赖项
 * Scan and optimize dependencies within a project.
 * Used by Vite CLI when running `vite optimize`.
 */
export async function optimizeDeps(
  config: ResolvedConfig,
  force = config.optimizeDeps.force,
  asCommand = false
): Promise<DepOptimizationMetadata> {
  const log = asCommand ? config.logger.info : debug

  const ssr = config.command === 'build' && !!config.build.ssr

  const cachedMetadata = loadCachedDepOptimizationMetadata(
    config,
    ssr,
    force,
    asCommand
  )
  if (cachedMetadata) {
    return cachedMetadata
  }

  // 探索工程依赖项 -> 开始扫描导入
  const deps = await discoverProjectDependencies(config)

  const depsString = depsLogString(Object.keys(deps))
  log(colors.green(`Optimizing dependencies:\n  ${depsString}`))

  // 增加手动
  await addManuallyIncludedOptimizeDeps(deps, config, ssr)

  // 对依赖项信息进行整合，合法化信息数据
  const depsInfo = toDiscoveredDependencies(config, deps, ssr)

  const result = await runOptimizeDeps(config, depsInfo) // 开始运行优化依赖

  await result.commit()

  return result.metadata // 把新的元数据交出去
}

export async function optimizeServerSsrDeps(
  config: ResolvedConfig
): Promise<DepOptimizationMetadata> {
  const ssr = true
  const cachedMetadata = loadCachedDepOptimizationMetadata(
    config,
    ssr,
    config.optimizeDeps.force,
    false
  )
  if (cachedMetadata) {
    return cachedMetadata
  }

  let alsoInclude: string[] | undefined
  let noExternalFilter: ((id: unknown) => boolean) | undefined

  const { exclude } = getDepOptimizationConfig(config, ssr)

  const noExternal = config.ssr?.noExternal
  if (noExternal) {
    alsoInclude = arraify(noExternal).filter(
      (ne) => typeof ne === 'string'
    ) as string[]
    noExternalFilter =
      noExternal === true
        ? (dep: unknown) => true
        : createFilter(undefined, exclude, {
            resolve: false
          })
  }

  const deps: Record<string, string> = {}

  await addManuallyIncludedOptimizeDeps(
    deps,
    config,
    ssr,
    alsoInclude,
    noExternalFilter
  )

  const depsInfo = toDiscoveredDependencies(config, deps, true)

  const result = await runOptimizeDeps(config, depsInfo, true)

  await result.commit()

  return result.metadata
}

export function initDepsOptimizerMetadata(
  config: ResolvedConfig,
  ssr: boolean,
  timestamp?: string
): DepOptimizationMetadata {
  const hash = getDepHash(config, ssr)
  return {
    hash,
    browserHash: getOptimizedBrowserHash(hash, {}, timestamp),
    optimized: {},
    chunks: {},
    discovered: {},
    depInfoList: []
  }
}

// 一个map存取，一个数组存取
export function addOptimizedDepInfo(
  metadata: DepOptimizationMetadata,
  type: 'optimized' | 'discovered' | 'chunks',
  depInfo: OptimizedDepInfo
): OptimizedDepInfo {
  metadata[type][depInfo.id] = depInfo
  metadata.depInfoList.push(depInfo)
  return depInfo
}

/**
 * Creates the initial dep optimization metadata, loading it from the deps cache
 * if it exists and pre-bundling isn't forced
 */
export function loadCachedDepOptimizationMetadata(
  config: ResolvedConfig,
  ssr: boolean,
  force = config.optimizeDeps.force,
  asCommand = false
): DepOptimizationMetadata | undefined {
  const log = asCommand ? config.logger.info : debug

  // Before Vite 2.9, dependencies were cached in the root of the cacheDir
  // For compat, we remove the cache if we find the old structure
  if (fs.existsSync(path.join(config.cacheDir, '_metadata.json'))) {
    emptyDir(config.cacheDir)
  }

  // 获取依赖缓存目录
  const depsCacheDir = getDepsCacheDir(config, ssr)

  // 不是强制性的
  if (!force) {
    let cachedMetadata: DepOptimizationMetadata | undefined
    try {
      const cachedMetadataPath = path.join(depsCacheDir, '_metadata.json')
      cachedMetadata = parseDepsOptimizerMetadata(
        fs.readFileSync(cachedMetadataPath, 'utf-8'),
        depsCacheDir
      )
    } catch (e) {}
    // hash is consistent, no need to re-bundle
    if (cachedMetadata && cachedMetadata.hash === getDepHash(config, ssr)) { // ***获取依赖的hash（工程的lock文件内容如package-lock.json + vite中一些配置 -> 做一个hash值）***
      log('Hash is consistent. Skipping. Use --force to override.')
      // Nothing to commit or cancel as we are using the cache, we only
      // need to resolve the processing promise so requests can move on
      return cachedMetadata // 没有变化就直接返回缓存元数据
    }
  } else {
    config.logger.info('Forced re-optimization of dependencies')
  }

  // ***
  // ***是强制性的 或者 hash不一样了都需要进行一个新鲜的缓存返回undefined***
  // ***

  // Start with a fresh cache
  fs.rmSync(depsCacheDir, { recursive: true, force: true })
}

/**
 * 探索工程依赖项
 * Initial optimizeDeps at server start. Perform a fast scan using esbuild to
 * find deps to pre-bundle and include user hard-coded dependencies
 */
export async function discoverProjectDependencies(
  config: ResolvedConfig
): Promise<Record<string, string>> {
  const { deps, missing } = await scanImports(config) // ***扫描导入的依赖项***
  // ***
  // 这里能够探索到所有的文件中所导入的依赖包（而依赖包是外部化的，所以esbuild不会对其进行分析）
  // 那么也就是说除了依赖包之外的其它的文件，esbuild都会对其进行分析，以至于我们能够在这里得到所有文件中所依赖的包包 ~
  // ***

  // ***
  // 对没有解析到依赖包路径的项目进行提示：可能这些包未安装？原因是由于解析这些包时，没有解析到它们的路径，所以做出的推测就是可能未安装它们？
  // ***
  const missingIds = Object.keys(missing)
  if (missingIds.length) {
    throw new Error(
      `The following dependencies are imported but could not be resolved:\n\n  ${missingIds
        .map(
          (id) =>
            `${colors.cyan(id)} ${colors.white(
              colors.dim(`(imported by ${missing[id]})`)
            )}`
        )
        .join(`\n  `)}\n\nAre they installed?`
    )
  }

  return deps
}

// 对依赖项信息进行整合，合法化信息数据
export function toDiscoveredDependencies(
  config: ResolvedConfig,
  deps: Record<string, string>,
  ssr: boolean,
  timestamp?: string
): Record<string, OptimizedDepInfo> {
  const browserHash = getOptimizedBrowserHash(
    getDepHash(config, ssr),
    deps,
    timestamp
  )
  const discovered: Record<string, OptimizedDepInfo> = {}
  for (const id in deps) {
    const src = deps[id]
    discovered[id] = {
      id,
      file: getOptimizedDepPath(id, config, ssr),
      src,
      browserHash: browserHash,
      exportsData: extractExportsData(src, config, ssr)
    }
  }
  return discovered
}

export function depsLogString(qualifiedIds: string[]): string {
  if (isDebugEnabled) {
    return colors.yellow(qualifiedIds.join(`, `))
  } else {
    const total = qualifiedIds.length
    const maxListed = 5
    const listed = Math.min(total, maxListed)
    const extra = Math.max(0, total - maxListed)
    return colors.yellow(
      qualifiedIds.slice(0, listed).join(`, `) +
        (extra > 0 ? `, ...and ${extra} more` : ``)
    )
  }
}

/**
 * 运行优化依赖
 * Internally, Vite uses this function to prepare a optimizeDeps run. When Vite starts, we can get
 * the metadata and start the server without waiting for the optimizeDeps processing to be completed
 */
export async function runOptimizeDeps(
  resolvedConfig: ResolvedConfig,
  depsInfo: Record<string, OptimizedDepInfo>, // 所知道的依赖项
  ssr: boolean = resolvedConfig.command === 'build' &&
    !!resolvedConfig.build.ssr
): Promise<DepOptimizationResult> {
  const isBuild = resolvedConfig.command === 'build'
  const config: ResolvedConfig = {
    ...resolvedConfig,
    command: 'build'
  }

  const depsCacheDir = getDepsCacheDir(resolvedConfig, ssr)
  const processingCacheDir = getProcessingDepsCacheDir(resolvedConfig, ssr)

  // Create a temporal directory so we don't need to delete optimized deps
  // until they have been processed. This also avoids leaving the deps cache
  // directory in a corrupted state if there is an error
  if (fs.existsSync(processingCacheDir)) {
    emptyDir(processingCacheDir)
  } else {
    fs.mkdirSync(processingCacheDir, { recursive: true })
  }

  // a hint for Node.js
  // all files in the cache directory should be recognized as ES modules
  writeFile(
    path.resolve(processingCacheDir, 'package.json'),
    JSON.stringify({ type: 'module' })
  ) // 写package.json文件

  // ***
  // ***
  const metadata = initDepsOptimizerMetadata(config, ssr)

  metadata.browserHash = getOptimizedBrowserHash(
    metadata.hash,
    depsFromOptimizedDepInfo(depsInfo)
  )

  // We prebundle dependencies with esbuild and cache them, but there is no need
  // to wait here. Code that needs to access the cached deps needs to await
  // the optimizedDepInfo.processing promise for each dep

  // 把所知道的依赖项的keys取出命名为合格的ids
  const qualifiedIds = Object.keys(depsInfo)

  const processingResult: DepOptimizationResult = {
    metadata, // 元数据
    // 提交操作主要就是删除依赖缓存目录，之后把当前正在处理的缓存目录重命名为依赖缓存目录
    async commit() {
      // Write metadata file, delete `deps` folder and rename the `processing` folder to `deps`
      // Processing is done, we can now replace the depsCacheDir with processingCacheDir
      // Rewire the file paths from the temporal processing dir to the final deps cache dir
      await removeDir(depsCacheDir)
      await renameDir(processingCacheDir, depsCacheDir)
    },
    // 取消操作就是删除当前正在处理的依赖缓存目录
    cancel() {
      fs.rmSync(processingCacheDir, { recursive: true, force: true })
    }
  }

  // 如果没有所知道的依赖项直接返回
  if (!qualifiedIds.length) {
    return processingResult
  }

  // esbuild generates nested directory output with lowest common ancestor base
  // this is unpredictable and makes it difficult to analyze entry / output
  // mapping. So what we do here is:
  // 1. flatten all ids to eliminate slash
  // 2. in the plugin, read the entry ourselves as virtual files to retain the
  //    path.
  const flatIdDeps: Record<string, string> = {}
  const idToExports: Record<string, ExportsData> = {}
  const flatIdToExports: Record<string, ExportsData> = {}

  const optimizeDeps = getDepOptimizationConfig(config, ssr)

  const { plugins: pluginsFromConfig = [], ...esbuildOptions } =
    optimizeDeps?.esbuildOptions ?? {}

  // 按照所知道的依赖项进行遍历
  for (const id in depsInfo) {
    const src = depsInfo[id].src!

    // ***
    // 这里做了一个提取向外暴露导出数据的操作
    // ***
    const exportsData = await (depsInfo[id].exportsData ??
      extractExportsData(src, config, ssr))
    if (exportsData.jsxLoader) {
      // Ensure that optimization won't fail by defaulting '.js' to the JSX parser.
      // This is useful for packages such as Gatsby.
      // 告诉接下里的esbuild
      esbuildOptions.loader = {
        '.js': 'jsx',
        ...esbuildOptions.loader
      }
    }
    const flatId = flattenId(id) // 展平后的id
    flatIdDeps[flatId] = src
    idToExports[id] = exportsData
    flatIdToExports[flatId] = exportsData
  }

  // esbuild automatically replaces process.env.NODE_ENV for platform 'browser'
  // In lib mode, we need to keep process.env.NODE_ENV untouched, so to at build
  // time we replace it by __vite_process_env_NODE_ENV. This placeholder will be
  // later replaced by the define plugin
  const define = {
    'process.env.NODE_ENV': isBuild
      ? '__vite_process_env_NODE_ENV'
      : JSON.stringify(process.env.NODE_ENV || config.mode)
  }

  const platform =
    ssr && config.ssr?.target !== 'webworker' ? 'node' : 'browser'

  // 外部化
  const external = [...(optimizeDeps?.exclude ?? [])]

  if (isBuild) {
    let rollupOptionsExternal = config?.build?.rollupOptions?.external
    if (rollupOptionsExternal) {
      if (typeof rollupOptionsExternal === 'string') {
        rollupOptionsExternal = [rollupOptionsExternal]
      }
      // TODO: decide whether to support RegExp and function options
      // They're not supported yet because `optimizeDeps.exclude` currently only accepts strings
      if (
        !Array.isArray(rollupOptionsExternal) ||
        rollupOptionsExternal.some((ext) => typeof ext !== 'string')
      ) {
        throw new Error(
          `[vite] 'build.rollupOptions.external' can only be an array of strings or a string when using esbuild optimization at build time.`
        )
      }
      external.push(...(rollupOptionsExternal as string[]))
    }
  }

  const plugins = [...pluginsFromConfig] // 配置中的插件
  if (external.length) {
    plugins.push(esbuildCjsExternalPlugin(external)) // 
  }
  plugins.push(
    // **这个插件很重要的**
    esbuildDepPlugin(flatIdDeps, flatIdToExports, external, config, ssr) // ***使用这个插件的目的
    // 一方面就是在解析时使用vite自己的解析逻辑，另一方面其造了一个代理模块来去保留入口的原始id而不是文件路径
    // 当然还做了一个重新导出操作以将虚拟代理模块从实际模块中分离出来，因为实际模块可能通过相对导入得到引用 - 如果我们不分离代理和实际模块，esbuild将创建相同模块的重复副本！
    // 还有一些浏览器端无法执行的比如node的内置模块需要做一个兼容处理
  )

  const start = performance.now()

  const result = await build({
    absWorkingDir: process.cwd(),
    // ***依赖包名作为入口点***
    entryPoints: Object.keys(flatIdDeps), // 入口点就是以这些所知道依赖项为多入口进行最终统一后的构建打包
    bundle: true,
    // We can't use platform 'neutral', as esbuild has custom handling
    // when the platform is 'node' or 'browser' that can't be emulated
    // by using mainFields and conditions
    platform,
    define,
    format: 'esm',
    // See https://github.com/evanw/esbuild/issues/1921#issuecomment-1152991694
    banner:
      platform === 'node'
        ? {
            js: `import { createRequire } from 'module';const require = createRequire(import.meta.url);`
          }
        : undefined,
    target: isBuild ? config.build.target || undefined : ESBUILD_MODULES_TARGET,
    external,
    logLevel: 'error',
    splitting: true,
    sourcemap: true,
    outdir: processingCacheDir, // 输出目录是处理中的缓存目录（也就是以_temp结尾的）
    ignoreAnnotations: !isBuild,
    metafile: true,
    plugins, // 本次构建的插件
    ...esbuildOptions,
    supported: {
      'dynamic-import': true,
      'import-meta': true,
      ...esbuildOptions.supported
    }
  })

  const meta = result.metafile!

  // the paths in `meta.outputs` are relative to `process.cwd()`
  const processingCacheDirOutputPath = path.relative(
    process.cwd(),
    processingCacheDir
  )

  // 按照所知道的依赖项进行遍历
  for (const id in depsInfo) {
    const output = esbuildOutputFromId(meta.outputs, id, processingCacheDir)

    const { exportsData, ...info } = depsInfo[id]
    // 增加到已优化选项中
    addOptimizedDepInfo(metadata, 'optimized', {

      ...info, // 注意processing代表的promise

      // We only need to hash the output.imports in to check for stability, but adding the hash
      // and file path gives us a unique hash that may be useful for other things in the future
      fileHash: getHash(
        metadata.hash + depsInfo[id].file + JSON.stringify(output.imports)
      ),
      browserHash: metadata.browserHash,
      // After bundling we have more information and can warn the user about legacy packages
      // that require manual configuration
      needsInterop: needsInterop(config, ssr, id, idToExports[id], output) // ***重点***
    })
  }

  for (const o of Object.keys(meta.outputs)) {
    if (!o.match(jsMapExtensionRE)) {
      const id = path
        .relative(processingCacheDirOutputPath, o)
        .replace(jsExtensionRE, '')
      const file = getOptimizedDepPath(id, resolvedConfig, ssr)
      if (
        // ***
        // 在元数据中已优化选项中查找当前产生输出的file，没有的那么就是归为chunks一类别的
        // 原因在于依赖与依赖之间会使用相同的依赖项，那么这些相同的依赖项在被esbuild处理产生对应的提取出来的chunks
        // ***
        !findOptimizedDepInfoInRecord( // 在记录中查找优化依赖信息
          metadata.optimized,
          (depInfo) => depInfo.file === file
        )
      ) {
        // 增加到chunks选项类别中
        addOptimizedDepInfo(metadata, 'chunks', {
          id,
          file,
          needsInterop: false,
          browserHash: metadata.browserHash
        })
      }
    }
  }

  const dataPath = path.join(processingCacheDir, '_metadata.json')
  writeFile(dataPath, stringifyDepsOptimizerMetadata(metadata, depsCacheDir)) // 写_metadata.json文件

  debug(`deps bundled in ${(performance.now() - start).toFixed(2)}ms`)

  return processingResult
}

export async function findKnownImports(
  config: ResolvedConfig,
  ssr: boolean
): Promise<string[]> {
  const deps = (await scanImports(config)).deps
  await addManuallyIncludedOptimizeDeps(deps, config, ssr)
  return Object.keys(deps)
}

// 主要就是找到手动包含的依赖项的入口文件路径作为键值对存入当前的deps中来
export async function addManuallyIncludedOptimizeDeps(
  deps: Record<string, string>,
  config: ResolvedConfig,
  ssr: boolean,
  extra: string[] = [],
  filter?: (id: string) => boolean
): Promise<void> {
  const { logger } = config
  const optimizeDeps = getDepOptimizationConfig(config, ssr)
  const optimizeDepsInclude = optimizeDeps?.include ?? []
  if (optimizeDepsInclude.length || extra.length) {
    const unableToOptimize = (id: string, msg: string) => {
      if (optimizeDepsInclude.includes(id)) {
        logger.warn(
          `${msg}: ${colors.cyan(id)}, present in '${
            ssr ? 'ssr.' : ''
          }optimizeDeps.include'`
        )
      }
    }
    // ***
    // 创建一个仅有alias、resolve内置插件的插件容器之后进行container.resolveId的解析者函数供使用
    // ***
    const resolve = config.createResolver({
      asSrc: false,
      scan: true,
      ssrOptimizeCheck: ssr
    })
    for (const id of [...optimizeDepsInclude, ...extra]) {
      // normalize 'foo   >bar` as 'foo > bar' to prevent same id being added
      // and for pretty printing
      const normalizedId = normalizeId(id)
      if (!deps[normalizedId] && filter?.(normalizedId) !== false) {
        const entry = await resolve(id, undefined, undefined, ssr) // 依赖的入口文件路径
        if (entry) {
          if (isOptimizable(entry, optimizeDeps)) {
            if (!entry.endsWith('?__vite_skip_optimization')) {
              deps[normalizedId] = entry // 把入口文件路径存入deps中
            }
          } else {
            unableToOptimize(entry, 'Cannot optimize dependency')
          }
        } else {
          unableToOptimize(id, 'Failed to resolve dependency')
        }
      }
    }
  }
}

// 其实就是返回一个新创建的promise和它的内部的resolve函数
export function newDepOptimizationProcessing(): DepOptimizationProcessing {
  let resolve: () => void
  const promise = new Promise((_resolve) => {
    resolve = _resolve
  }) as Promise<void>
  return { promise, resolve: resolve! }
}

// Convert to { id: src }
export function depsFromOptimizedDepInfo(
  depsInfo: Record<string, OptimizedDepInfo>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(depsInfo).map((d) => [d[0], d[1].src!])
  )
}

// ***
// 获取优化依赖路径
// 例如dev期间的vue -> /node_modules/.vite/deps/vue.js
// ***这样就能够说明esbuild能够保证多入口打包之后形成的bundle都是和入口点一一进行对应的。***
// https://www.yuque.com/lanbitouw/lsud0i/eb30fx
// ***
export function getOptimizedDepPath(
  id: string,
  config: ResolvedConfig,
  ssr: boolean
): string {
  return normalizePath(
    path.resolve(getDepsCacheDir(config, ssr), flattenId(id) + '.js')
  )
}

function getDepsCacheSuffix(config: ResolvedConfig, ssr: boolean): string {
  let suffix = ''
  if (config.command === 'build') {
    // Differentiate build caches depending on outDir to allow parallel builds
    const { outDir } = config.build
    const buildId =
      outDir.length > 8 || outDir.includes('/') ? getHash(outDir) : outDir
    suffix += `_build-${buildId}`
  }
  if (ssr) {
    suffix += '_ssr'
  }
  return suffix
}

export function getDepsCacheDir(config: ResolvedConfig, ssr: boolean): string {
  return getDepsCacheDirPrefix(config) + getDepsCacheSuffix(config, ssr)
}

function getProcessingDepsCacheDir(config: ResolvedConfig, ssr: boolean) {
  return (
    getDepsCacheDirPrefix(config) + getDepsCacheSuffix(config, ssr) + '_temp'
  )
}

export function getDepsCacheDirPrefix(config: ResolvedConfig): string {
  return normalizePath(path.resolve(config.cacheDir, 'deps'))
}

// 是否以依赖缓存目录为前缀例如/node_modules/.vite/deps的
export function isOptimizedDepFile(
  id: string,
  config: ResolvedConfig
): boolean {
  return id.startsWith(getDepsCacheDirPrefix(config))
}

// 例如url是否以/node_modules/.vite/deps开头的
export function createIsOptimizedDepUrl(
  config: ResolvedConfig
): (url: string) => boolean {
  const { root } = config
  const depsCacheDir = getDepsCacheDirPrefix(config)

  // determine the url prefix of files inside cache directory
  const depsCacheDirRelative = normalizePath(path.relative(root, depsCacheDir))
  const depsCacheDirPrefix = depsCacheDirRelative.startsWith('../')
    ? // if the cache directory is outside root, the url prefix would be something
      // like '/@fs/absolute/path/to/node_modules/.vite'
      `/@fs/${normalizePath(depsCacheDir).replace(/^\//, '')}`
    : // if the cache directory is inside root, the url prefix would be something
      // like '/node_modules/.vite'
      `/${depsCacheDirRelative}`

  return function isOptimizedDepUrl(url: string): boolean {
    return url.startsWith(depsCacheDirPrefix)
  }
}

function parseDepsOptimizerMetadata(
  jsonMetadata: string,
  depsCacheDir: string
): DepOptimizationMetadata | undefined {
  const { hash, browserHash, optimized, chunks } = JSON.parse(
    jsonMetadata,
    (key: string, value: string) => {
      // Paths can be absolute or relative to the deps cache dir where
      // the _metadata.json is located
      if (key === 'file' || key === 'src') {
        return normalizePath(path.resolve(depsCacheDir, value))
      }
      return value
    }
  )
  if (
    !chunks ||
    Object.values(optimized).some((depInfo: any) => !depInfo.fileHash)
  ) {
    // outdated _metadata.json version, ignore
    return
  }
  const metadata = {
    hash,
    browserHash,
    optimized: {},
    discovered: {},
    chunks: {},
    depInfoList: []
  }
  for (const id of Object.keys(optimized)) {
    addOptimizedDepInfo(metadata, 'optimized', {
      ...optimized[id],
      id,
      browserHash
    })
  }
  for (const id of Object.keys(chunks)) {
    addOptimizedDepInfo(metadata, 'chunks', {
      ...chunks[id],
      id,
      browserHash,
      needsInterop: false
    })
  }
  return metadata
}

/**
 * Stringify metadata for deps cache. Remove processing promises
 * and individual dep info browserHash. Once the cache is reload
 * the next time the server start we need to use the global
 * browserHash to allow long term caching
 */
function stringifyDepsOptimizerMetadata(
  metadata: DepOptimizationMetadata,
  depsCacheDir: string
) {
  const { hash, browserHash, optimized, chunks } = metadata
  return JSON.stringify(
    {
      hash,
      browserHash,
      optimized: Object.fromEntries(
        Object.values(optimized).map(
          ({ id, src, file, fileHash, needsInterop }) => [
            id,
            {
              src,
              file,
              fileHash,
              needsInterop
            }
          ]
        )
      ),
      chunks: Object.fromEntries(
        Object.values(chunks).map(({ id, file }) => [id, { file }])
      )
    },
    (key: string, value: string) => {
      // Paths can be absolute or relative to the deps cache dir where
      // the _metadata.json is located
      if (key === 'file' || key === 'src') {
        return normalizePath(path.relative(depsCacheDir, value))
      }
      return value
    },
    2
  )
}

function esbuildOutputFromId(
  outputs: Record<string, any>,
  id: string,
  cacheDirOutputPath: string
): any {
  const cwd = process.cwd()
  const flatId = flattenId(id) + '.js'
  const normalizedOutputPath = normalizePath(
    path.relative(cwd, path.join(cacheDirOutputPath, flatId))
  )
  const output = outputs[normalizedOutputPath]
  if (output) {
    return output
  }
  // If the root dir was symlinked, esbuild could return output keys as `../cwd/`
  // Normalize keys to support this case too
  for (const [key, value] of Object.entries(outputs)) {
    if (normalizePath(path.relative(cwd, key)) === normalizedOutputPath) {
      return value
    }
  }
}

export async function extractExportsData(
  filePath: string,
  config: ResolvedConfig,
  ssr: boolean
): Promise<ExportsData> {
  await init

  const optimizeDeps = getDepOptimizationConfig(config, ssr)

  const esbuildOptions = optimizeDeps?.esbuildOptions ?? {}
  if (optimizeDeps.extensions?.some((ext) => filePath.endsWith(ext))) {
    // For custom supported extensions, build the entry file to transform it into JS,
    // and then parse with es-module-lexer. Note that the `bundle` option is not `true`,
    // so only the entry file is being transformed.
    const result = await build({
      ...esbuildOptions,
      entryPoints: [filePath],
      write: false,
      format: 'esm'
    })
    const [imports, exports, facade] = parse(result.outputFiles[0].text)
    return {
      hasImports: imports.length > 0,
      exports: exports.map((e) => e.n),
      facade
    }
  }

  let parseResult: ReturnType<typeof parse>
  let usedJsxLoader = false

  const entryContent = fs.readFileSync(filePath, 'utf-8')
  try {
    parseResult = parse(entryContent)
  } catch {
    const loader = esbuildOptions.loader?.[path.extname(filePath)] || 'jsx'
    debug(
      `Unable to parse: ${filePath}.\n Trying again with a ${loader} transform.`
    )
    const transformed = await transformWithEsbuild(entryContent, filePath, {
      loader
    })
    // Ensure that optimization won't fail by defaulting '.js' to the JSX parser.
    // This is useful for packages such as Gatsby.
    esbuildOptions.loader = {
      '.js': 'jsx',
      ...esbuildOptions.loader
    }
    parseResult = parse(transformed.code)
    usedJsxLoader = true
  }

  const [imports, exports, facade] = parseResult
  const exportsData: ExportsData = {
    hasImports: imports.length > 0,
    exports: exports.map((e) => e.n),
    facade,
    hasReExports: imports.some(({ ss, se }) => {
      const exp = entryContent.slice(ss, se)
      return /export\s+\*\s+from/.test(exp)
    }),
    jsxLoader: usedJsxLoader
  }
  return exportsData
}

// https://github.com/vitejs/vite/issues/1724#issuecomment-767619642
// a list of modules that pretends to be ESM but still uses `require`.
// this causes esbuild to wrap them as CJS even when its entry appears to be ESM.
const KNOWN_INTEROP_IDS = new Set(['moment'])
// ***
// 伪装成 ESM 但仍使用 `require` 的一个模块列表。
// 这会导致 esbuild 将它们包装为 CJS，即使它的入口似乎是 ESM。
// ***


/**
 * esbuild打包后的结果
 * 对于依赖间形成的chunk是不需要进行互操作的，原因是它们共打包后结果之间相互引用
 * 那么对于当前依赖是否需要互操作的意思就是对于依赖是cjs或umd，那么esbuild会把它们包装为cjs形态，但是它们的入口是esm的
 * 大多情况下会形成一个默认导出，所以当某个文件依赖了此依赖，此时如果不是使用默认导入的话就会报错了
 * 所以这就需要转换一下，那么vite就把这个称为互操作，也就是vite会改为默认导入，之后使用默认导入进行const解构赋值达到分别导入的效果
 * 
 * 这里是描述依赖是否需要互操作的逻辑
 * 
 * 而对于转换的逻辑是出现在***importAnalysis插件transform钩子***中进行互操作的（实际上就是检查文件中的导入语句是否为导入的依赖
 * 之后看这个依赖是否需要进行互操作，再然后就是修改代码啦）
 * 
 * 图文参考链接🔗：https://www.yuque.com/lanbitouw/lsud0i/pnb6nx
 * 
 */

// 需要互操作
function needsInterop(
  config: ResolvedConfig,
  ssr: boolean,
  id: string,
  exportsData: ExportsData, // 原包入口文件的导出数据
  output?: { exports: string[] } // esbuild构建后的导出
): boolean {
  if (
    getDepOptimizationConfig(config, ssr)?.needsInterop?.includes(id) ||
    KNOWN_INTEROP_IDS.has(id)
  ) {
    return true
  }
  // 在原包的入口文件中没有esm语法（包的入口文件不是esbuild打包后的入口文件）
  const { hasImports, exports } = exportsData
  // 入口没有esm语法 - 像cjs或者umd
  // entry has no ESM syntax - likely CJS or UMD
  if (!exports.length && !hasImports) {
    return true
  }

  if (output) {
    // if a peer dependency used require() on an ESM dependency, esbuild turns the
    // ESM dependency's entry chunk into a single default export... detect
    // such cases by checking exports mismatch, and force interop.
    const generatedExports: string[] = output.exports

    if (
      !generatedExports || // 打包后的入口文件没有生成导出数据或者
      (isSingleDefaultExport(generatedExports) &&
        !isSingleDefaultExport(exports)) // 打包后的入口文件是单个默认导出且原包的入口文件不是单个默认导出
    ) {
      return true
    }
  }
  return false
}

function isSingleDefaultExport(exports: readonly string[]) {
  return exports.length === 1 && exports[0] === 'default'
}

const lockfileFormats = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']

// 获取依赖的hash（工程的lock文件内容如package-lock.json + vite中一些配置 -> 做一个hash值）
export function getDepHash(config: ResolvedConfig, ssr: boolean): string {
  let content = lookupFile(config.root, lockfileFormats) || ''
  // also take config into account
  // only a subset of config options that can affect dep optimization
  const optimizeDeps = getDepOptimizationConfig(config, ssr)
  content += JSON.stringify(
    {
      mode: process.env.NODE_ENV || config.mode,
      root: config.root,
      resolve: config.resolve,
      buildTarget: config.build.target,
      assetsInclude: config.assetsInclude,
      plugins: config.plugins.map((p) => p.name),
      optimizeDeps: {
        include: optimizeDeps?.include,
        exclude: optimizeDeps?.exclude,
        esbuildOptions: {
          ...optimizeDeps?.esbuildOptions,
          plugins: optimizeDeps?.esbuildOptions?.plugins?.map((p) => p.name)
        }
      }
    },
    (_, value) => {
      if (typeof value === 'function' || value instanceof RegExp) {
        return value.toString()
      }
      return value
    }
  )
  return getHash(content)
}

function getOptimizedBrowserHash(
  hash: string,
  deps: Record<string, string>,
  timestamp = ''
) {
  return getHash(hash + JSON.stringify(deps) + timestamp)
}

export function optimizedDepInfoFromId(
  metadata: DepOptimizationMetadata,
  id: string
): OptimizedDepInfo | undefined {
  return (
    metadata.optimized[id] || metadata.discovered[id] || metadata.chunks[id]
  )
}

export function optimizedDepInfoFromFile(
  metadata: DepOptimizationMetadata,
  file: string
): OptimizedDepInfo | undefined {
  return metadata.depInfoList.find((depInfo) => depInfo.file === file)
}

function findOptimizedDepInfoInRecord(
  dependenciesInfo: Record<string, OptimizedDepInfo>,
  callbackFn: (depInfo: OptimizedDepInfo, id: string) => any
): OptimizedDepInfo | undefined {
  for (const o of Object.keys(dependenciesInfo)) {
    const info = dependenciesInfo[o]
    if (callbackFn(info, o)) {
      return info
    }
  }
}

export async function optimizedDepNeedsInterop(
  metadata: DepOptimizationMetadata,
  file: string,
  config: ResolvedConfig,
  ssr: boolean
): Promise<boolean | undefined> {
  const depInfo = optimizedDepInfoFromFile(metadata, file)
  if (depInfo?.src && depInfo.needsInterop === undefined) {
    depInfo.exportsData ??= extractExportsData(depInfo.src, config, ssr)
    depInfo.needsInterop = needsInterop(
      config,
      ssr,
      depInfo.id,
      await depInfo.exportsData
    )
  }
  return depInfo?.needsInterop
}
