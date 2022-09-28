import fs from 'node:fs'
import path from 'node:path'
import colors from 'picocolors'
import type { PartialResolvedId } from 'rollup'
import { resolve as _resolveExports } from 'resolve.exports'
import { hasESMSyntax } from 'mlly'
import type { Plugin } from '../plugin'
import {
  CLIENT_ENTRY,
  DEFAULT_EXTENSIONS,
  DEFAULT_MAIN_FIELDS,
  DEP_VERSION_RE,
  ENV_ENTRY,
  FS_PREFIX,
  OPTIMIZABLE_ENTRY_RE,
  SPECIAL_QUERY_RE
} from '../constants'
import {
  bareImportRE,
  cleanUrl,
  createDebugger,
  ensureVolumeInPath,
  fsPathFromId,
  getPotentialTsSrcPaths,
  injectQuery,
  isBuiltin,
  isDataUrl,
  isExternalUrl,
  isFileReadable,
  isNonDriveRelativeAbsolutePath,
  isObject,
  isOptimizable,
  isPossibleTsOutput,
  isTsRequest,
  isWindows,
  lookupFile,
  nestedResolveFrom,
  normalizePath,
  resolveFrom,
  slash
} from '../utils'
import { optimizedDepInfoFromFile, optimizedDepInfoFromId } from '../optimizer'
import type { DepsOptimizer } from '../optimizer'
import type { SSROptions } from '..'
import type { PackageCache, PackageData } from '../packages'
import { loadPackageData, resolvePackageData } from '../packages'

const normalizedClientEntry = normalizePath(CLIENT_ENTRY)
const normalizedEnvEntry = normalizePath(ENV_ENTRY)

// special id for paths marked with browser: false
// https://github.com/defunctzombie/package-browser-field-spec#ignore-a-module
export const browserExternalId = '__vite-browser-external'
// special id for packages that are optional peer deps
export const optionalPeerDepId = '__vite-optional-peer-dep'

const nodeModulesInPathRE = /(^|\/)node_modules\//

const isDebug = process.env.DEBUG
const debug = createDebugger('vite:resolve-details', {
  onlyWhenFocused: true
})

export interface ResolveOptions {
  mainFields?: string[]
  /**
   * @deprecated In future, `mainFields` should be used instead.
   * @default true
   */
  browserField?: boolean
  conditions?: string[]
  extensions?: string[]
  dedupe?: string[]
  preserveSymlinks?: boolean
}

export interface InternalResolveOptions extends Required<ResolveOptions> {
  root: string
  isBuild: boolean
  isProduction: boolean
  ssrConfig?: SSROptions
  packageCache?: PackageCache
  /**
   * src code mode also attempts the following:
   * - resolving /xxx as URLs
   * - resolving bare imports from optimized deps
   */
  asSrc?: boolean
  tryIndex?: boolean
  tryPrefix?: string
  skipPackageJson?: boolean
  preferRelative?: boolean
  isRequire?: boolean
  // #3040
  // when the importer is a ts module,
  // if the specifier requests a non-existent `.js/jsx/mjs/cjs` file,
  // should also try import from `.ts/tsx/mts/cts` source file as fallback.
  isFromTsImporter?: boolean
  tryEsmOnly?: boolean
  // True when resolving during the scan phase to discover dependencies
  scan?: boolean
  // Appends ?__vite_skip_optimization to the resolved id if shouldn't be optimized
  ssrOptimizeCheck?: boolean
  // Resolve using esbuild deps optimization
  getDepsOptimizer?: (ssr: boolean) => DepsOptimizer | undefined
  shouldExternalize?: (id: string) => boolean | undefined
}

export function resolvePlugin(resolveOptions: InternalResolveOptions): Plugin {
  const {
    root,
    isProduction,
    asSrc,
    ssrConfig,
    preferRelative = false
  } = resolveOptions

  const { target: ssrTarget, noExternal: ssrNoExternal } = ssrConfig ?? {}

  return {
    name: 'vite:resolve',

    // 主要就是先尝试fs解析 -> 尝试优化解析 -> 尝试node解析
    async resolveId(id, importer, resolveOpts) {
      const ssr = resolveOpts?.ssr === true

      // 我们需要将depsOptimizer延迟到这里，而不是将其作为选项传递
      // resolvePlugin因为优化器是在dev期间在服务器listen上创建的
      // We need to delay depsOptimizer until here instead of passing it as an option
      // the resolvePlugin because the optimizer is created on server listen during dev
      const depsOptimizer = resolveOptions.getDepsOptimizer?.(ssr)

      // id是否以__vite-browser-external开头的
      if (id.startsWith(browserExternalId)) {
        return id
      }

      const targetWeb = !ssr || ssrTarget === 'webworker'

      // this is passed by @rollup/plugin-commonjs
      const isRequire: boolean =
        resolveOpts?.custom?.['node-resolve']?.isRequire ?? false

      const options: InternalResolveOptions = {
        isRequire,
        ...resolveOptions,
        scan: resolveOpts?.scan ?? resolveOptions.scan
      }

      if (importer) {
        if (
          isTsRequest(importer) ||
          resolveOpts.custom?.depScan?.loader?.startsWith('ts')
        ) {
          options.isFromTsImporter = true
        } else {
          const moduleLang = this.getModuleInfo(importer)?.meta?.vite?.lang
          options.isFromTsImporter = moduleLang && isTsRequest(`.${moduleLang}`)
        }
      }

      let res: string | PartialResolvedId | undefined

      // 解决预构建deps请求，这些可以通过tryFileResolve或/fs/解决，但这些文件可能还没有
      // 如果我们处于deps重新处理的中间，则存在
      // resolve pre-bundled deps requests, these could be resolved by
      // tryFileResolve or /fs/ resolution but these files may not yet
      // exists if we are in the middle of a deps re-processing
      if (asSrc && depsOptimizer?.isOptimizedDepUrl(id)) { // 检查当前id是否为优化依赖url
        const optimizedPath = id.startsWith(FS_PREFIX) // 是的话是否以/fs/开始的
          ? fsPathFromId(id)
          : normalizePath(ensureVolumeInPath(path.resolve(root, id.slice(1))))
        return optimizedPath
      }

      // 确保版本query
      const ensureVersionQuery = (resolved: string): string => {
        if (
          !options.isBuild &&
          depsOptimizer &&
          !(
            resolved === normalizedClientEntry ||
            resolved === normalizedEnvEntry
          )
        ) {
          // 确保node_modules的直接导入具有相同的版本query
          // 就好像它们是通过裸导入导入的一样
          // 使用原始id进行检查，因为解析后的id可能是真实的符号链接解析后的文件路径
          // Ensure that direct imports of node_modules have the same version query
          // as if they would have been imported through a bare import
          // Use the original id to do the check as the resolved id may be the real
          // file path after symlinks resolution
          const isNodeModule =
            // /(^|\/)node_modules\//
            nodeModulesInPathRE.test(normalizePath(id)) ||
            nodeModulesInPathRE.test(normalizePath(resolved))

          if (isNodeModule && !resolved.match(DEP_VERSION_RE)) {
            const versionHash = depsOptimizer.metadata.browserHash
            if (versionHash && isOptimizable(resolved, depsOptimizer.options)) {
              resolved = injectQuery(resolved, `v=${versionHash}`) // 会给解析后的url注入版本hash的query
            }
          }
        }
        return resolved
      }

      // ***
      // 以 /@fs/* 开头的显式 fs 路径
      // 直接尝试fs进行解析
      // ***
      // explicit fs paths that starts with /@fs/*
      if (asSrc && id.startsWith(FS_PREFIX)) {
        const fsPath = fsPathFromId(id)
        res = tryFsResolve(fsPath, options)
        isDebug && debug(`[@fs] ${colors.cyan(id)} -> ${colors.dim(res)}`)
        // 即使 res 不存在也总是返回这里，因为 /@fs/ 是显式的
        // 如果文件不存在，它应该是 404
        // always return here even if res doesn't exist since /@fs/ is explicit
        // if the file doesn't exist it should be a 404
        return ensureVersionQuery(res || fsPath)
      }

      // ***
      // url以/开头的，也是作为尝试fs进行解析
      // ***
      // URL
      // /foo -> /fs-root/foo
      if (asSrc && id.startsWith('/')) {
        const fsPath = path.resolve(root, id.slice(1))
        if ((res = tryFsResolve(fsPath, options))) {
          isDebug && debug(`[url] ${colors.cyan(id)} -> ${colors.dim(res)}`)
          return ensureVersionQuery(res)
        }
      }

      // ***
      // 相对
      // 是否为优化依赖文件是则对路径进行序列化之后返回
      // 之后尝试fs解析
      // ***
      // relative
      if (
        id.startsWith('.') ||
        ((preferRelative || importer?.endsWith('.html')) && /^\w/.test(id))
      ) {
        const basedir = importer ? path.dirname(importer) : process.cwd()
        const fsPath = path.resolve(basedir, id)
        // 处理相对导入的浏览器字段映射
        // handle browser field mapping for relative imports

        const normalizedFsPath = normalizePath(fsPath)

        // 是否为优化依赖文件
        if (depsOptimizer?.isOptimizedDepFile(normalizedFsPath)) {
          // 磁盘中尚不存在优化文件，请解析为完整路径 
          // 如果路径没有，则注入当前 browserHash 版本
          // Optimized files could not yet exist in disk, resolve to the full path
          // Inject the current browserHash version if the path doesn't have one
          if (!normalizedFsPath.match(DEP_VERSION_RE)) {
            const browserHash = optimizedDepInfoFromFile(
              depsOptimizer.metadata,
              normalizedFsPath
            )?.browserHash
            if (browserHash) {
              return injectQuery(normalizedFsPath, `v=${browserHash}`)
            }
          }
          return normalizedFsPath
        }

        if (
          targetWeb &&
          options.browserField &&
          (res = tryResolveBrowserMapping(fsPath, importer, options, true))
        ) {
          return res
        }

        // 尝试fs解析
        if ((res = tryFsResolve(fsPath, options))) {
          res = ensureVersionQuery(res) // 确保版本query
          isDebug &&
            debug(`[relative] ${colors.cyan(id)} -> ${colors.dim(res)}`)
          const pkg = importer != null && idToPkgMap.get(importer)
          if (pkg) {
            idToPkgMap.set(res, pkg)
            return {
              id: res,
              moduleSideEffects: pkg.hasSideEffects(res)
            }
          }
          return res
        }
      }

      // ***
      // windows平台下以/开始也是尝试fs解析
      // ***
      // 驱动相对 fs 路径（仅限 Windows）
      // drive relative fs paths (only windows)
      if (isWindows && id.startsWith('/')) {
        const basedir = importer ? path.dirname(importer) : process.cwd()
        const fsPath = path.resolve(basedir, id)
        if ((res = tryFsResolve(fsPath, options))) {
          isDebug &&
            debug(`[drive-relative] ${colors.cyan(id)} -> ${colors.dim(res)}`)
          return ensureVersionQuery(res)
        }
      }

      // ***
      // 绝对 fs 路径
      // 尝试fs解析
      // ***
      // absolute fs paths
      if (
        isNonDriveRelativeAbsolutePath(id) &&
        (res = tryFsResolve(id, options))
      ) {
        isDebug && debug(`[fs] ${colors.cyan(id)} -> ${colors.dim(res)}`)
        return ensureVersionQuery(res)
      }

      // ***
      // 外部的
      // 直接返回并标记为外部的
      // ***
      // external
      if (isExternalUrl(id)) {
        return {
          id,
          external: true
        }
      }

      // 数据url：此插件不处理（这仅在构建期间发生，并且将是由专用插件处理）
      // data uri: pass through (this only happens during build and will be
      // handled by dedicated plugin)
      if (isDataUrl(id)) {
        return null
      }

      // ***
      // 裸包导入，准备node解析
      // 先尝试优化解析
      //   主要是通过优化依赖缓存数据获取到优化后依赖的文件路径也就是node_modules下的.vite/deps/下的打包后的bundle文件的路径
      //   import * as echarts from 'echarts' -> import * as echarts from '/node_modules/.vite/deps/echarts.js?v=3acf7852'
      // 再尝试node解析
      //   主要是通过resolve库进行查找包的package.json文件，之后找到包的入口文件路径返回
      // ***
      // bare package imports, perform node resolve
      if (bareImportRE.test(id)) {
        // 此包是否应该外部化
        const external = options.shouldExternalize?.(id)
        if (
          !external &&
          asSrc &&
          depsOptimizer &&
          !options.scan &&
          (res = await tryOptimizedResolve(depsOptimizer, id, importer)) // 先尝试优化解析
        ) {
          return res
        }

        if (
          targetWeb &&
          options.browserField &&
          (res = tryResolveBrowserMapping(
            id,
            importer,
            options,
            false,
            external
          ))
        ) {
          return res
        }

        if (
          (res = tryNodeResolve( // *** 尝试node解析 ***
            id,
            importer,
            options,
            targetWeb,
            depsOptimizer,
            ssr,
            external
          ))
        ) {
          return res
        }

        // node的内置模块
        // 如果为 SSR 构建，则外部化，否则重定向到空模块
        // node built-ins.
        // externalize if building for SSR, otherwise redirect to empty module
        if (isBuiltin(id)) {
          if (ssr) {
            if (ssrNoExternal === true) {
              let message = `Cannot bundle Node.js built-in "${id}"`
              if (importer) {
                message += ` imported from "${path.relative(
                  process.cwd(),
                  importer
                )}"`
              }
              message += `. Consider disabling ssr.noExternal or remove the built-in dependency.`
              this.error(message)
            }

            return {
              id,
              external: true
            }
          } else {
            if (!asSrc) {
              debug(
                `externalized node built-in "${id}" to empty module. ` +
                  `(imported by: ${colors.white(colors.dim(importer))})`
              )
            }
            return isProduction
              ? browserExternalId
              : `${browserExternalId}:${id}` // `__vite-browser-external:${id}`
          }
        }
      }

      isDebug && debug(`[fallthrough] ${colors.dim(id)}`)
    },

    load(id) {
      // 以__vite-browser-external开头的开发中返回一个代理对象，参考如下
      if (id.startsWith(browserExternalId)) {
        if (isProduction) {
          return `export default {}`
        } else {
          id = id.slice(browserExternalId.length + 1)
          return `\
export default new Proxy({}, {
  get(_, key) {
    throw new Error(\`Module "${id}" has been externalized for browser compatibility. Cannot access "${id}.\${key}" in client code.\`)
  }
})`
        }
      }
      if (id.startsWith(optionalPeerDepId)) {
        if (isProduction) {
          return `export default {}`
        } else {
          const [, peerDep, parentDep] = id.split(':')
          return `throw new Error(\`Could not resolve "${peerDep}" imported by "${parentDep}". Is it installed?\`)`
        }
      }
    }
  }
}

function splitFileAndPostfix(path: string) {
  let file = path
  let postfix = ''

  let postfixIndex = path.indexOf('?')
  if (postfixIndex < 0) {
    postfixIndex = path.indexOf('#')
  }
  if (postfixIndex > 0) {
    file = path.slice(0, postfixIndex)
    postfix = path.slice(postfixIndex)
  }
  return { file, postfix }
}

// 尝试fs解析
function tryFsResolve(
  fsPath: string,
  options: InternalResolveOptions,
  tryIndex = true,
  targetWeb = true
): string | undefined {
  const { file, postfix } = splitFileAndPostfix(fsPath)

  let res: string | undefined

  // if there is a postfix, try resolving it as a complete path first (#4703)
  if (
    postfix &&
    (res = tryResolveFile(
      fsPath,
      '',
      options,
      false,
      targetWeb,
      options.tryPrefix,
      options.skipPackageJson
    ))
  ) {
    return res
  }

  if (
    (res = tryResolveFile(
      file,
      postfix,
      options,
      false,
      targetWeb,
      options.tryPrefix,
      options.skipPackageJson
    ))
  ) {
    return res
  }

  for (const ext of options.extensions) {
    if (
      postfix &&
      (res = tryResolveFile(
        fsPath + ext,
        '',
        options,
        false,
        targetWeb,
        options.tryPrefix,
        options.skipPackageJson
      ))
    ) {
      return res
    }

    if (
      (res = tryResolveFile(
        file + ext,
        postfix,
        options,
        false,
        targetWeb,
        options.tryPrefix,
        options.skipPackageJson
      ))
    ) {
      return res
    }
  }

  if (
    postfix &&
    (res = tryResolveFile(
      fsPath,
      '',
      options,
      tryIndex,
      targetWeb,
      options.tryPrefix,
      options.skipPackageJson
    ))
  ) {
    return res
  }

  if (
    (res = tryResolveFile(
      file,
      postfix,
      options,
      tryIndex,
      targetWeb,
      options.tryPrefix,
      options.skipPackageJson
    ))
  ) {
    return res
  }
}

// 尝试解析文件
function tryResolveFile(
  file: string,
  postfix: string,
  options: InternalResolveOptions,
  tryIndex: boolean,
  targetWeb: boolean,
  tryPrefix?: string,
  skipPackageJson?: boolean
): string | undefined {
  // #2051 if we don't have read permission on a directory, existsSync() still
  // works and will result in massively slow subsequent checks (which are
  // unnecessary in the first place)
  if (isFileReadable(file)) {
    if (!fs.statSync(file).isDirectory()) {
      return getRealPath(file, options.preserveSymlinks) + postfix
    } else if (tryIndex) {
      if (!skipPackageJson) {
        const pkgPath = file + '/package.json'
        try {
          // path points to a node package
          const pkg = loadPackageData(pkgPath, options.preserveSymlinks)
          const resolved = resolvePackageEntry(file, pkg, targetWeb, options)
          return resolved
        } catch (e) {
          if (e.code !== 'ENOENT') {
            throw e
          }
        }
      }
      const index = tryFsResolve(file + '/index', options)
      if (index) return index + postfix
    }
  }

  const tryTsExtension = options.isFromTsImporter && isPossibleTsOutput(file)
  if (tryTsExtension) {
    const tsSrcPaths = getPotentialTsSrcPaths(file)
    for (const srcPath of tsSrcPaths) {
      const res = tryResolveFile(
        srcPath,
        postfix,
        options,
        tryIndex,
        targetWeb,
        tryPrefix,
        skipPackageJson
      )
      if (res) return res
    }
    return
  }

  if (tryPrefix) {
    const prefixed = `${path.dirname(file)}/${tryPrefix}${path.basename(file)}`
    return tryResolveFile(prefixed, postfix, options, tryIndex, targetWeb)
  }
}

export const idToPkgMap = new Map<string, PackageData>()

// 尝试node解析
export function tryNodeResolve(
  id: string,
  importer: string | null | undefined,
  options: InternalResolveOptions,
  targetWeb: boolean,
  depsOptimizer?: DepsOptimizer,
  ssr?: boolean,
  externalize?: boolean,
  allowLinkedExternal: boolean = true
): PartialResolvedId | undefined {
  const { root, dedupe, isBuild, preserveSymlinks, packageCache } = options

  ssr ??= false

  // split id by last '>' for nested selected packages, for example:
  // 'foo > bar > baz' => 'foo > bar' & 'baz'
  // 'foo'             => ''          & 'foo'
  const lastArrowIndex = id.lastIndexOf('>')
  const nestedRoot = id.substring(0, lastArrowIndex).trim()
  const nestedPath = id.substring(lastArrowIndex + 1).trim()

  const possiblePkgIds: string[] = []
  for (let prevSlashIndex = -1; ; ) {
    let slashIndex = nestedPath.indexOf('/', prevSlashIndex + 1)
    if (slashIndex < 0) {
      slashIndex = nestedPath.length
    }

    const part = nestedPath.slice(
      prevSlashIndex + 1,
      (prevSlashIndex = slashIndex)
    )
    if (!part) {
      break
    }

    // Assume path parts with an extension are not package roots, except for the
    // first path part (since periods are sadly allowed in package names).
    // At the same time, skip the first path part if it begins with "@"
    // (since "@foo/bar" should be treated as the top-level path).
    if (possiblePkgIds.length ? path.extname(part) : part[0] === '@') {
      continue
    }

    const possiblePkgId = nestedPath.slice(0, slashIndex)
    possiblePkgIds.push(possiblePkgId)
  }

  let basedir: string
  if (dedupe?.some((id) => possiblePkgIds.includes(id))) {
    basedir = root
  } else if (
    importer &&
    path.isAbsolute(importer) &&
    fs.existsSync(cleanUrl(importer))
  ) {
    basedir = path.dirname(importer)
  } else {
    basedir = root
  }

  // nested node module, step-by-step resolve to the basedir of the nestedPath
  if (nestedRoot) {
    basedir = nestedResolveFrom(nestedRoot, basedir, preserveSymlinks)
  }

  let pkg: PackageData | undefined // 包数据
  const pkgId = possiblePkgIds.reverse().find((pkgId) => {
    // ***
    // 解析包数据
    // 使用到了resolve库进行解析查找包的package.json文件，并把json转为对象返回
    // ***
    pkg = resolvePackageData(pkgId, basedir, preserveSymlinks, packageCache)!
    return pkg
  })!

  if (!pkg) {
    // if import can't be found, check if it's an optional peer dep.
    // if so, we can resolve to a special id that errors only when imported.
    if (
      basedir !== root && // root has no peer dep
      !isBuiltin(id) &&
      !id.includes('\0') &&
      bareImportRE.test(id)
    ) {
      // find package.json with `name` as main
      const mainPackageJson = lookupFile(basedir, ['package.json'], {
        predicate: (content) => !!JSON.parse(content).name
      })
      if (mainPackageJson) {
        const mainPkg = JSON.parse(mainPackageJson)
        if (
          mainPkg.peerDependencies?.[id] &&
          mainPkg.peerDependenciesMeta?.[id]?.optional
        ) {
          return {
            id: `${optionalPeerDepId}:${id}:${mainPkg.name}`
          }
        }
      }
    }
    return
  }

  // 解析包入口函数
  let resolveId = resolvePackageEntry
  let unresolvedId = pkgId
  const isDeepImport = unresolvedId !== nestedPath
  if (isDeepImport) {
    resolveId = resolveDeepImport // 是否为深度导入 -> 解析深度导入
    unresolvedId = '.' + nestedPath.slice(pkgId.length)
  }

  let resolved: string | undefined
  try {
    // ***
    // 通过包数据（package.json -> 对象pkg）解析包的入口文件路径是什么
    // ***
    resolved = resolveId(unresolvedId, pkg, targetWeb, options)
  } catch (err) {
    if (!options.tryEsmOnly) {
      throw err
    }
  }
  if (!resolved && options.tryEsmOnly) {
    resolved = resolveId(unresolvedId, pkg, targetWeb, {
      ...options,
      isRequire: false,
      mainFields: DEFAULT_MAIN_FIELDS,
      extensions: DEFAULT_EXTENSIONS
    })
  }
  if (!resolved) { // 没有解析直接返回undefined
    return
  }

  const processResult = (resolved: PartialResolvedId) => {
    if (!externalize) {
      return resolved
    }
    // don't external symlink packages
    if (!allowLinkedExternal && !resolved.id.includes('node_modules')) {
      return resolved
    }
    const resolvedExt = path.extname(resolved.id)
    // don't external non-js imports
    if (
      resolvedExt &&
      resolvedExt !== '.js' &&
      resolvedExt !== '.mjs' &&
      resolvedExt !== '.cjs'
    ) {
      return resolved
    }
    let resolvedId = id
    if (isDeepImport) {
      if (!pkg?.data.exports && path.extname(id) !== resolvedExt) {
        resolvedId = resolved.id.slice(resolved.id.indexOf(id))
        isDebug &&
          debug(
            `[processResult] ${colors.cyan(id)} -> ${colors.dim(resolvedId)}`
          )
      }
    }
    return { ...resolved, id: resolvedId, external: true }
  }

  // link id to pkg for browser field mapping check
  idToPkgMap.set(resolved, pkg)
  if ((isBuild && !depsOptimizer) || externalize) {
    // Resolve package side effects for build so that rollup can better
    // perform tree-shaking
    return processResult({
      id: resolved,
      moduleSideEffects: pkg.hasSideEffects(resolved)
    })
  }

  const ext = path.extname(resolved)
  const isCJS = ext === '.cjs' || (ext === '.js' && pkg.data.type !== 'module')

  if (
    !options.ssrOptimizeCheck &&
    (!resolved.includes('node_modules') || // linked
      !depsOptimizer || // resolving before listening to the server
      options.scan) // initial esbuild scan phase
  ) {
    return { id: resolved }
  }

  // if we reach here, it's a valid dep import that hasn't been optimized.
  const isJsType = depsOptimizer
    ? isOptimizable(resolved, depsOptimizer.options)
    : OPTIMIZABLE_ENTRY_RE.test(resolved)

  let exclude = depsOptimizer?.options.exclude
  let include = depsOptimizer?.options.exclude
  if (options.ssrOptimizeCheck) {
    // we don't have the depsOptimizer
    exclude = options.ssrConfig?.optimizeDeps?.exclude
    include = options.ssrConfig?.optimizeDeps?.exclude
  }

  const skipOptimization =
    !isJsType ||
    importer?.includes('node_modules') ||
    exclude?.includes(pkgId) ||
    exclude?.includes(nestedPath) ||
    SPECIAL_QUERY_RE.test(resolved) ||
    (!isBuild && ssr) ||
    // Only optimize non-external CJS deps during SSR by default
    (ssr &&
      !isCJS &&
      !(include?.includes(pkgId) || include?.includes(nestedPath)))

  if (options.ssrOptimizeCheck) {
    return {
      id: skipOptimization
        ? injectQuery(resolved, `__vite_skip_optimization`)
        : resolved
    }
  }

  if (skipOptimization) {
    // excluded from optimization
    // Inject a version query to npm deps so that the browser
    // can cache it without re-validation, but only do so for known js types.
    // otherwise we may introduce duplicated modules for externalized files
    // from pre-bundled deps.
    if (!isBuild) {
      const versionHash = depsOptimizer!.metadata.browserHash
      if (versionHash && isJsType) {
        resolved = injectQuery(resolved, `v=${versionHash}`)
      }
    }
  } else {
    // this is a missing import, queue optimize-deps re-run and
    // get a resolved its optimized info
    const optimizedInfo = depsOptimizer!.registerMissingImport(id, resolved)
    resolved = depsOptimizer!.getOptimizedDepId(optimizedInfo)
  }

  if (isBuild) {
    // ***
    // 构建时解析包的副作用，以便rollup可以更好执行tree-shaking
    // ***
    // Resolve package side effects for build so that rollup can better
    // perform tree-shaking
    return {
      id: resolved,
      moduleSideEffects: pkg.hasSideEffects(resolved)
    }
  } else {
    return { id: resolved! } // 直接返回解析后包的入口文件的路径
  }
}

// 尝试优化解析
export async function tryOptimizedResolve(
  depsOptimizer: DepsOptimizer,
  id: string,
  importer?: string
): Promise<string | undefined> {
  // TODO: we need to wait until scanning is done here as this function
  // is used in the preAliasPlugin to decide if an aliased dep is optimized,
  // and avoid replacing the bare import with the resolved path.
  // We should be able to remove this in the future
  await depsOptimizer.scanProcessing // 等待依赖优化器扫描处理完毕

  const metadata = depsOptimizer.metadata // 依赖优化器元数据

  // 从id拿到优化依赖信息
  const depInfo = optimizedDepInfoFromId(metadata, id)
  if (depInfo) {
    return depsOptimizer.getOptimizedDepId(depInfo) // 获取优化依赖id
  }

  if (!importer) return

  // further check if id is imported by nested dependency
  let resolvedSrc: string | undefined

  for (const optimizedData of metadata.depInfoList) {
    if (!optimizedData.src) continue // Ignore chunks

    const pkgPath = optimizedData.id
    // check for scenarios, e.g.
    //   pkgPath  => "my-lib > foo"
    //   id       => "foo"
    // this narrows the need to do a full resolve
    if (!pkgPath.endsWith(id)) continue

    // lazily initialize resolvedSrc
    if (resolvedSrc == null) {
      try {
        // this may throw errors if unable to resolve, e.g. aliased id
        resolvedSrc = normalizePath(resolveFrom(id, path.dirname(importer)))
      } catch {
        // this is best-effort only so swallow errors
        break
      }
    }

    // 通过 src 匹配以正确识别 id 是否属于嵌套依赖项
    // match by src to correctly identify if id belongs to nested dependency
    if (optimizedData.src === resolvedSrc) {
      return depsOptimizer.getOptimizedDepId(optimizedData)
    }
  }
}

// 解析包的入口
export function resolvePackageEntry(
  id: string,
  { dir, data, setResolvedCache, getResolvedCache }: PackageData,
  targetWeb: boolean,
  options: InternalResolveOptions
): string | undefined {
  const cached = getResolvedCache('.', targetWeb)
  if (cached) {
    return cached
  }
  try {
    let entryPoint: string | undefined | void

    // resolve exports field with highest priority
    // using https://github.com/lukeed/resolve.exports
    if (data.exports) {
      entryPoint = resolveExports(data, '.', options, targetWeb)
    }

    // if exports resolved to .mjs, still resolve other fields.
    // This is because .mjs files can technically import .cjs files which would
    // make them invalid for pure ESM environments - so if other module/browser
    // fields are present, prioritize those instead.
    if (
      targetWeb &&
      options.browserField &&
      (!entryPoint || entryPoint.endsWith('.mjs'))
    ) {
      // check browser field
      // https://github.com/defunctzombie/package-browser-field-spec
      const browserEntry =
        typeof data.browser === 'string'
          ? data.browser
          : isObject(data.browser) && data.browser['.']
      if (browserEntry) {
        // check if the package also has a "module" field.
        if (
          !options.isRequire &&
          options.mainFields.includes('module') &&
          typeof data.module === 'string' &&
          data.module !== browserEntry
        ) {
          // if both are present, we may have a problem: some package points both
          // to ESM, with "module" targeting Node.js, while some packages points
          // "module" to browser ESM and "browser" to UMD/IIFE.
          // the heuristics here is to actually read the browser entry when
          // possible and check for hints of ESM. If it is not ESM, prefer "module"
          // instead; Otherwise, assume it's ESM and use it.
          const resolvedBrowserEntry = tryFsResolve(
            path.join(dir, browserEntry),
            options
          )
          if (resolvedBrowserEntry) {
            const content = fs.readFileSync(resolvedBrowserEntry, 'utf-8')
            if (hasESMSyntax(content)) {
              // likely ESM, prefer browser
              entryPoint = browserEntry
            } else {
              // non-ESM, UMD or IIFE or CJS(!!! e.g. firebase 7.x), prefer module
              entryPoint = data.module
            }
          }
        } else {
          entryPoint = browserEntry
        }
      }
    }

    if (!entryPoint || entryPoint.endsWith('.mjs')) {
      for (const field of options.mainFields) {
        if (field === 'browser') continue // already checked above
        if (typeof data[field] === 'string') {
          entryPoint = data[field]
          break
        }
      }
    }
    entryPoint ||= data.main

    // try default entry when entry is not define
    // https://nodejs.org/api/modules.html#all-together
    const entryPoints = entryPoint
      ? [entryPoint]
      : ['index.js', 'index.json', 'index.node']

    for (let entry of entryPoints) {
      // make sure we don't get scripts when looking for sass
      if (
        options.mainFields[0] === 'sass' &&
        !options.extensions.includes(path.extname(entry))
      ) {
        entry = ''
        options.skipPackageJson = true
      }

      // resolve object browser field in package.json
      const { browser: browserField } = data
      if (targetWeb && options.browserField && isObject(browserField)) {
        entry = mapWithBrowserField(entry, browserField) || entry
      }

      const entryPointPath = path.join(dir, entry)
      const resolvedEntryPoint = tryFsResolve(entryPointPath, options)
      if (resolvedEntryPoint) {
        isDebug &&
          debug(
            `[package entry] ${colors.cyan(id)} -> ${colors.dim(
              resolvedEntryPoint
            )}`
          )
        setResolvedCache('.', resolvedEntryPoint, targetWeb)
        return resolvedEntryPoint // 返回已解析的入口点
      }
    }
  } catch (e) {
    packageEntryFailure(id, e.message)
  }
  packageEntryFailure(id)
}

function packageEntryFailure(id: string, details?: string) {
  throw new Error(
    `Failed to resolve entry for package "${id}". ` +
      `The package may have incorrect main/module/exports specified in its package.json` +
      (details ? ': ' + details : '.')
  )
}

function resolveExports(
  pkg: PackageData['data'],
  key: string,
  options: InternalResolveOptions,
  targetWeb: boolean
) {
  const conditions = [options.isProduction ? 'production' : 'development']
  if (!options.isRequire) {
    conditions.push('module')
  }
  if (options.conditions.length > 0) {
    conditions.push(...options.conditions)
  }

  return _resolveExports(pkg, key, {
    browser: targetWeb && !conditions.includes('node'),
    require: options.isRequire && !conditions.includes('import'),
    conditions
  })
}

function resolveDeepImport(
  id: string,
  {
    webResolvedImports,
    setResolvedCache,
    getResolvedCache,
    dir,
    data
  }: PackageData,
  targetWeb: boolean,
  options: InternalResolveOptions
): string | undefined {
  const cache = getResolvedCache(id, targetWeb)
  if (cache) {
    return cache
  }

  let relativeId: string | undefined | void = id
  const { exports: exportsField, browser: browserField } = data

  // map relative based on exports data
  if (exportsField) {
    if (isObject(exportsField) && !Array.isArray(exportsField)) {
      // resolve without postfix (see #7098)
      const { file, postfix } = splitFileAndPostfix(relativeId)
      const exportsId = resolveExports(data, file, options, targetWeb)
      if (exportsId !== undefined) {
        relativeId = exportsId + postfix
      } else {
        relativeId = undefined
      }
    } else {
      // not exposed
      relativeId = undefined
    }
    if (!relativeId) {
      throw new Error(
        `Package subpath '${relativeId}' is not defined by "exports" in ` +
          `${path.join(dir, 'package.json')}.`
      )
    }
  } else if (targetWeb && options.browserField && isObject(browserField)) {
    // resolve without postfix (see #7098)
    const { file, postfix } = splitFileAndPostfix(relativeId)
    const mapped = mapWithBrowserField(file, browserField)
    if (mapped) {
      relativeId = mapped + postfix
    } else if (mapped === false) {
      return (webResolvedImports[id] = browserExternalId)
    }
  }

  if (relativeId) {
    const resolved = tryFsResolve(
      path.join(dir, relativeId),
      options,
      !exportsField, // try index only if no exports field
      targetWeb
    )
    if (resolved) {
      isDebug &&
        debug(
          `[node/deep-import] ${colors.cyan(id)} -> ${colors.dim(resolved)}`
        )
      setResolvedCache(id, resolved, targetWeb)
      return resolved
    }
  }
}

// 尝试解析浏览器映射
function tryResolveBrowserMapping(
  id: string,
  importer: string | undefined,
  options: InternalResolveOptions,
  isFilePath: boolean,
  externalize?: boolean
) {
  let res: string | undefined
  const pkg = importer && idToPkgMap.get(importer)
  if (pkg && isObject(pkg.data.browser)) {
    const mapId = isFilePath ? './' + slash(path.relative(pkg.dir, id)) : id
    const browserMappedPath = mapWithBrowserField(mapId, pkg.data.browser)
    if (browserMappedPath) {
      const fsPath = path.join(pkg.dir, browserMappedPath)
      if ((res = tryFsResolve(fsPath, options))) {
        isDebug &&
          debug(`[browser mapped] ${colors.cyan(id)} -> ${colors.dim(res)}`)
        idToPkgMap.set(res, pkg)
        const result = {
          id: res,
          moduleSideEffects: pkg.hasSideEffects(res)
        }
        return externalize ? { ...result, external: true } : result
      }
    } else if (browserMappedPath === false) {
      return browserExternalId
    }
  }
}

/**
 * given a relative path in pkg dir,
 * return a relative path in pkg dir,
 * mapped with the "map" object
 *
 * - Returning `undefined` means there is no browser mapping for this id
 * - Returning `false` means this id is explicitly externalized for browser
 */
function mapWithBrowserField(
  relativePathInPkgDir: string,
  map: Record<string, string | false>
): string | false | undefined {
  const normalizedPath = path.posix.normalize(relativePathInPkgDir)

  for (const key in map) {
    const normalizedKey = path.posix.normalize(key)
    if (
      normalizedPath === normalizedKey ||
      equalWithoutSuffix(normalizedPath, normalizedKey, '.js') ||
      equalWithoutSuffix(normalizedPath, normalizedKey, '/index.js')
    ) {
      return map[key]
    }
  }
}

function equalWithoutSuffix(path: string, key: string, suffix: string) {
  return key.endsWith(suffix) && key.slice(0, -suffix.length) === path
}

function getRealPath(resolved: string, preserveSymlinks?: boolean): string {
  resolved = ensureVolumeInPath(resolved)
  if (!preserveSymlinks && browserExternalId !== resolved) {
    resolved = fs.realpathSync(resolved)
  }
  return normalizePath(resolved)
}
