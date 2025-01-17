import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import colors from 'picocolors'
import MagicString from 'magic-string'
import type { ExportSpecifier, ImportSpecifier } from 'es-module-lexer'
import { init, parse as parseImports } from 'es-module-lexer'
import { parse as parseJS } from 'acorn'
import type { Node } from 'estree'
import { findStaticImports, parseStaticImport } from 'mlly'
import { makeLegalIdentifier } from '@rollup/pluginutils'
import { getDepOptimizationConfig } from '..'
import type { ViteDevServer } from '..'
import {
  CLIENT_DIR,
  CLIENT_PUBLIC_PATH,
  DEP_VERSION_RE,
  FS_PREFIX
} from '../constants'
import {
  debugHmr,
  handlePrunedModules,
  lexAcceptedHmrDeps,
  lexAcceptedHmrExports
} from '../server/hmr'
import {
  cleanUrl,
  createDebugger,
  fsPathFromUrl,
  generateCodeFrame,
  injectQuery,
  isBuiltin,
  isDataUrl,
  isExternalUrl,
  isJSRequest,
  moduleListContains,
  normalizePath,
  prettifyUrl,
  removeImportQuery,
  stripBomTag,
  timeFrom,
  transformStableResult,
  unwrapId,
  wrapId
} from '../utils'
import type { ResolvedConfig } from '../config'
import type { Plugin } from '../plugin'
import {
  cjsShouldExternalizeForSSR,
  shouldExternalizeForSSR
} from '../ssr/ssrExternal'
import { transformRequest } from '../server/transformRequest'
import {
  getDepsCacheDirPrefix,
  getDepsOptimizer,
  optimizedDepNeedsInterop
} from '../optimizer'
import { checkPublicFile } from './asset'
import {
  ERR_OUTDATED_OPTIMIZED_DEP,
  throwOutdatedRequest
} from './optimizedDeps'
import { isCSSRequest, isDirectCSSRequest } from './css'
import { browserExternalId } from './resolve'

const isDebug = !!process.env.DEBUG
const debug = createDebugger('vite:import-analysis')

const clientDir = normalizePath(CLIENT_DIR)

const skipRE = /\.(map|json)($|\?)/
export const canSkipImportAnalysis = (id: string): boolean =>
  skipRE.test(id) || isDirectCSSRequest(id)

const optimizedDepChunkRE = /\/chunk-[A-Z0-9]{8}\.js/
const optimizedDepDynamicRE = /-[A-Z0-9]{8}\.js/

export function isExplicitImportRequired(url: string): boolean {
  return !isJSRequest(cleanUrl(url)) && !isCSSRequest(url)
}

function markExplicitImport(url: string) {
  if (isExplicitImportRequired(url)) {
    return injectQuery(url, 'import')
  }
  return url
}

function extractImportedBindings(
  id: string,
  source: string,
  importSpec: ImportSpecifier,
  importedBindings: Map<string, Set<string>>
) {
  let bindings = importedBindings.get(id)
  if (!bindings) {
    bindings = new Set<string>()
    importedBindings.set(id, bindings)
  }

  const isDynamic = importSpec.d > -1
  const isMeta = importSpec.d === -2
  if (isDynamic || isMeta) {
    // this basically means the module will be impacted by any change in its dep
    bindings.add('*')
    return
  }

  const exp = source.slice(importSpec.ss, importSpec.se)
  const [match0] = findStaticImports(exp)
  if (!match0) {
    return
  }
  const parsed = parseStaticImport(match0)
  if (!parsed) {
    return
  }
  if (parsed.namespacedImport) {
    bindings.add('*')
  }
  if (parsed.defaultImport) {
    bindings.add('default')
  }
  if (parsed.namedImports) {
    for (const name of Object.keys(parsed.namedImports)) {
      bindings.add(name)
    }
  }
}

/**
 * Server-only plugin that lexes, resolves, rewrites and analyzes url imports.
 *
 * - Imports are resolved to ensure they exist on disk
 *
 * - Lexes HMR accept calls and updates import relationships in the module graph
 *
 * - Bare module imports are resolved (by @rollup-plugin/node-resolve) to
 * absolute file paths, e.g.
 *
 *     ```js
 *     import 'foo'
 *     ```
 *     is rewritten to
 *     ```js
 *     import '/@fs//project/node_modules/foo/dist/foo.js'
 *     ```
 *
 * - CSS imports are appended with `.js` since both the js module and the actual
 * css (referenced via `<link>`) may go through the transform pipeline:
 *
 *     ```js
 *     import './style.css'
 *     ```
 *     is rewritten to
 *     ```js
 *     import './style.css.js'
 *     ```
 */
export function importAnalysisPlugin(config: ResolvedConfig): Plugin {
  const { root, base } = config
  const clientPublicPath = path.posix.join(base, CLIENT_PUBLIC_PATH)
  const enablePartialAccept = config.experimental?.hmrPartialAccept
  let server: ViteDevServer

  return {
    name: 'vite:import-analysis',

    configureServer(_server) {
      server = _server
    },

    async transform(source, importer, options) {
      // In a real app `server` is always defined, but it is undefined when
      // running src/node/server/__tests__/pluginContainer.spec.ts
      if (!server) {
        return null
      }

      const ssr = options?.ssr === true
      const prettyImporter = prettifyUrl(importer, root)

      if (canSkipImportAnalysis(importer)) {
        isDebug && debug(colors.dim(`[skipped] ${prettyImporter}`))
        return null
      }

      const start = performance.now()
      await init
      let imports!: readonly ImportSpecifier[]
      let exports!: readonly ExportSpecifier[]
      source = stripBomTag(source)
      try {
        ;[imports, exports] = parseImports(source) // es-module-lexer库进行解析code
      } catch (e: any) {
        const isVue = importer.endsWith('.vue')
        const maybeJSX = !isVue && isJSRequest(importer)

        const msg = isVue
          ? `Install @vitejs/plugin-vue to handle .vue files.`
          : maybeJSX
          ? `If you are using JSX, make sure to name the file with the .jsx or .tsx extension.`
          : `You may need to install appropriate plugins to handle the ${path.extname(
              importer
            )} file format, or if it's an asset, add "**/*${path.extname(
              importer
            )}" to \`assetsInclude\` in your configuration.`

        this.error(
          `Failed to parse source for import analysis because the content ` +
            `contains invalid JS syntax. ` +
            msg,
          e.idx
        )
      }

      const depsOptimizer = getDepsOptimizer(config, ssr) // 获取依赖优化器

      const { moduleGraph } = server
      // since we are already in the transform phase of the importer, it must
      // have been loaded so its entry is guaranteed in the module graph.
      const importerModule = moduleGraph.getModuleById(importer)! // 获取模块图中的导入者模块
      if (!importerModule && depsOptimizer?.isOptimizedDepFile(importer)) {
        // Ids of optimized deps could be invalidated and removed from the graph
        // Return without transforming, this request is no longer valid, a full reload
        // is going to request this id again. Throwing an outdated error so we
        // properly finish the request with a 504 sent to the browser.
        throwOutdatedRequest(importer)
      }

      // 当前源码中没有使用import语句
      if (!imports.length) {
        importerModule.isSelfAccepting = false // 给导入者模块设置自身accept为false
        isDebug &&
          debug(
            `${timeFrom(start)} ${colors.dim(`[no imports] ${prettyImporter}`)}`
          )
        return source // 直接返回源代码
      }

      let hasHMR = false
      let isSelfAccepting = false
      let hasEnv = false
      let needQueryInjectHelper = false
      let s: MagicString | undefined
      const str = () => s || (s = new MagicString(source)) // 使用MagicString
      const importedUrls = new Set<string>()
      const staticImportedUrls = new Set<{ url: string; id: string }>()
      const acceptedUrls = new Set<{
        url: string
        start: number
        end: number
      }>()
      let isPartiallySelfAccepting = false
      const acceptedExports = new Set<string>()
      const importedBindings = enablePartialAccept
        ? new Map<string, Set<string>>()
        : null
      const toAbsoluteUrl = (url: string) =>
        path.posix.resolve(path.posix.dirname(importerModule.url), url)

      // ***
      // 序列化url
      // 主要内部逻辑就是再一次执行插件容器的resolveId钩子函数
      // ***
      const normalizeUrl = async (
        url: string,
        pos: number
      ): Promise<[string, string]> => {
        if (base !== '/' && url.startsWith(base)) {
          url = url.replace(base, '/')
        }

        let importerFile = importer

        const optimizeDeps = getDepOptimizationConfig(config, ssr)
        if (moduleListContains(optimizeDeps?.exclude, url)) {
          if (depsOptimizer) {
            await depsOptimizer.scanProcessing

            // if the dependency encountered in the optimized file was excluded from the optimization
            // the dependency needs to be resolved starting from the original source location of the optimized file
            // because starting from node_modules/.vite will not find the dependency if it was not hoisted
            // (that is, if it is under node_modules directory in the package source of the optimized file)
            for (const optimizedModule of depsOptimizer.metadata.depInfoList) {
              if (!optimizedModule.src) continue // Ignore chunks
              if (optimizedModule.file === importerModule.file) {
                importerFile = optimizedModule.src
              }
            }
          }
        }

        // ***
        // 执行插件容器的resolveId钩子函数
        // ***
        const resolved = await this.resolve(url, importerFile)

        if (!resolved) {
          // in ssr, we should let node handle the missing modules
          if (ssr) {
            return [url, url]
          }
          return this.error(
            `Failed to resolve import "${url}" from "${path.relative(
              process.cwd(),
              importerFile
            )}". Does the file exist?`,
            pos
          )
        }

        const isRelative = url.startsWith('.')
        const isSelfImport = !isRelative && cleanUrl(url) === cleanUrl(importer)

        // normalize all imports into resolved URLs
        // e.g. `import 'foo'` -> `import '/@fs/.../node_modules/foo/index.js'`
        if (resolved.id.startsWith(root + '/')) {
          // in root: infer short absolute path from root
          url = resolved.id.slice(root.length)
        } else if (
          resolved.id.startsWith(getDepsCacheDirPrefix(config)) ||
          fs.existsSync(cleanUrl(resolved.id))
        ) {
          // an optimized deps may not yet exists in the filesystem, or
          // a regular file exists but is out of root: rewrite to absolute /@fs/ paths
          // 文件系统中可能尚不存在优化的 deps，或常规文件存在但不在根目录：重写到绝对 /@fs/ 路径
          url = path.posix.join(FS_PREFIX + resolved.id)
        } else {
          url = resolved.id
        }

        if (isExternalUrl(url)) {
          return [url, url]
        }

        // if the resolved id is not a valid browser import specifier,
        // prefix it to make it valid. We will strip this before feeding it
        // back into the transform pipeline
        if (!url.startsWith('.') && !url.startsWith('/')) {
          url = wrapId(resolved.id)
        }

        // 如果不是SSR，则使URL浏览器有效
        // make the URL browser-valid if not SSR
        if (!ssr) {

          // ***
          // ***
          // 用 `?import` 标记非 js/css 导入，例如import xxx from './javascript.svg' -> import xxx from '/javascript.svg?import'
          // ***
          // ***
          
          // mark non-js/css imports with `?import`
          url = markExplicitImport(url)

          // If the url isn't a request for a pre-bundled common chunk,
          // for relative js/css imports, or self-module virtual imports
          // (e.g. vue blocks), inherit importer's version query
          // do not do this for unknown type imports, otherwise the appended
          // query can break 3rd party plugin's extension checks.
          if (
            (isRelative || isSelfImport) &&
            !/[\?&]import=?\b/.test(url) &&
            !url.match(DEP_VERSION_RE)
          ) {
            const versionMatch = importer.match(DEP_VERSION_RE)
            if (versionMatch) {
              url = injectQuery(url, versionMatch[1]) // 注入版本query
            }
          }

          // check if the dep has been hmr updated. If yes, we need to attach
          // its last updated timestamp to force the browser to fetch the most
          // up-to-date version of this module.
          try {
            // ****
            // ****
            // delay setting `isSelfAccepting` until the file is actually used (#7870)
            const depModule = await moduleGraph.ensureEntryFromUrl( // **确保创建此模块节点**
              unwrapId(url),
              ssr,
              canSkipImportAnalysis(url)
            )
            if (depModule.lastHMRTimestamp > 0) {
              url = injectQuery(url, `t=${depModule.lastHMRTimestamp}`) // 注入?t=
            }
          } catch (e: any) {
            // it's possible that the dep fails to resolve (non-existent import)
            // attach location to the missing import
            e.pos = pos
            throw e
          }

          // prepend base (dev base is guaranteed to have ending slash)
          url = base + url.replace(/^\//, '')
        }

        return [url, resolved.id]
      }

      // 遍历每个导入语句
      for (let index = 0; index < imports.length; index++) {
        const {
          s: start,
          e: end,
          ss: expStart,
          se: expEnd,
          d: dynamicIndex,
          // #2083 User may use escape path,
          // so use imports[index].n to get the unescaped string
          n: specifier,
          a: assertIndex
        } = imports[index]

        const rawUrl = source.slice(start, end)

        // 检查import.meta的用法
        // check import.meta usage
        if (rawUrl === 'import.meta') {
          const prop = source.slice(end, end + 4)
          if (prop === '.hot') {
            hasHMR = true
            if (source.slice(end + 4, end + 11) === '.accept') {
              // further analyze accepted modules // 进一步分析接受的模块
              if (source.slice(end + 4, end + 18) === '.acceptExports') {
                lexAcceptedHmrExports(
                  source,
                  source.indexOf('(', end + 18) + 1,
                  acceptedExports
                )
                isPartiallySelfAccepting = true
              } else if (
                lexAcceptedHmrDeps(
                  source,
                  source.indexOf('(', end + 11) + 1,
                  acceptedUrls // 这里面保存的是需要接受的模块的字符串分词中的内容
                )
                /**
                 * 
                 * 对import.meta.hot.accept()的词法分析，分析结果为是否自身被accept
                 * 
                 * import.meta.hot.accept()
                 * import.meta.hot.accept(() => {})
                 * 以上表示当前模块为自接受模块
                 * 
                 * import.meta.hot.accept('', () => {})
                 * import.meta.hot.accept(['', ''], () => {})
                 * 以上就表示当前模块不是自接受模块
                 * 
                 */
              ) {
                isSelfAccepting = true
              }
            }
          } else if (prop === '.env') {
            hasEnv = true
          }
          continue
        }

        // 是否有动态导入
        const isDynamicImport = dynamicIndex > -1

        // strip import assertions as we can process them ourselves
        if (!isDynamicImport && assertIndex > -1) {
          str().remove(end + 1, expEnd)
        }

        // 静态导入或动态导入中的有效字符串，如果可以解决，让我们解决它
        // static import or valid string in dynamic import
        // If resolvable, let's resolve it
        if (specifier) {
          // skip external / data uri
          if (isExternalUrl(specifier) || isDataUrl(specifier)) {
            continue
          }
          // skip ssr external
          if (ssr) {
            if (config.legacy?.buildSsrCjsExternalHeuristics) {
              if (cjsShouldExternalizeForSSR(specifier, server._ssrExternals)) {
                continue
              }
            } else if (shouldExternalizeForSSR(specifier, config)) {
              continue
            }
            if (isBuiltin(specifier)) {
              continue
            }
          }
          // skip client
          if (specifier === clientPublicPath) {
            continue
          }

          // 警告非静态的/public文件的导入
          // warn imports to non-asset /public files
          if (
            specifier.startsWith('/') &&
            !config.assetsInclude(cleanUrl(specifier)) &&
            !specifier.endsWith('.json') &&
            checkPublicFile(specifier, config)
          ) {
            throw new Error(
              `Cannot import non-asset file ${specifier} which is inside /public.` +
                `JS/CSS files inside /public are copied as-is on build and ` +
                `can only be referenced via <script src> or <link href> in html.`
            )
          }

          // ***
          // 序列化url
          // normalize
          // ***
          const [url, resolvedId] = await normalizeUrl(specifier, start)

          // 记录为安全模块
          // record as safe modules
          server?.moduleGraph.safeModulesPath.add(fsPathFromUrl(url))

          if (url !== specifier) {
            let rewriteDone = false // 是否重写完毕
            // 是否是优化依赖文件
            if (
              depsOptimizer?.isOptimizedDepFile(resolvedId) &&
              !resolvedId.match(optimizedDepChunkRE)
            ) {
              // 对于已优化的cjs依赖，通过将命名导入重写为const赋值来支持命名导入。
              // for optimized cjs deps, support named imports by rewriting named imports to const assignments.
              // internal optimized chunks don't need es interop and are excluded

              // The browserHash in resolvedId could be stale in which case there will be a full
              // page reload. We could return a 404 in that case but it is safe to return the request
              const file = cleanUrl(resolvedId) // Remove ?v={hash}

              // 已优化的依赖需要进行互操作
              const needsInterop = await optimizedDepNeedsInterop(
                depsOptimizer.metadata,
                file,
                config,
                ssr
              )

              if (needsInterop === undefined) {
                // Non-entry dynamic imports from dependencies will reach here as there isn't
                // optimize info for them, but they don't need es interop. If the request isn't
                // a dynamic import, then it is an internal Vite error
                if (!file.match(optimizedDepDynamicRE)) {
                  config.logger.error(
                    colors.red(
                      `Vite Error, ${url} optimized info should be defined`
                    )
                  )
                }
              } else if (needsInterop) {
                debug(`${url} needs interop`)
                interopNamedImports(str(), imports[index], url, index) // ***对于已优化的cjs依赖，通过将命名导入重写为const赋值来支持命名导入。***

                // ***
                // 互操作的原因可以看optimizer/index.ts的最后详细解释
                // ***
                
                rewriteDone = true
              }
            }
            // If source code imports builtin modules via named imports, the stub proxy export
            // would fail as it's `export default` only. Apply interop for builtin modules to
            // correctly throw the error message.
            else if (
              url.includes(browserExternalId) &&
              source.slice(expStart, start).includes('{')
            ) {
              interopNamedImports(str(), imports[index], url, index)
              rewriteDone = true
            }
            if (!rewriteDone) { // 如果没有重写过，那么就把序列化后的url给重写回去
              let rewrittenUrl = JSON.stringify(url)
              if (!isDynamicImport) rewrittenUrl = rewrittenUrl.slice(1, -1)
              str().overwrite(start, end, rewrittenUrl, {
                contentOnly: true
              })
            }
          }

          // record for HMR import chain analysis
          // make sure to unwrap and normalize away base
          const hmrUrl = unwrapId(url.replace(base, '/'))
          importedUrls.add(hmrUrl)

          // 开启部分接受 且 importedBindings这个Map是有的
          if (enablePartialAccept && importedBindings) {
            extractImportedBindings(
              resolvedId,
              source,
              imports[index],
              importedBindings // 提取所导入的名字添加到importedBindings这个map中
              // import * as echarts from 'echarts' -> 'echarts'=>['*']
              // import Vue from 'vue' -> 'vue'=>['Vue']
              // import { Button } from 'element-ui' -> 'element-ui'=>['Button']
            )
          }

          // 当前导入语句不是动态导入
          if (!isDynamicImport) {
            // ***
            // 用于预转换
            // ***
            // for pre-transforming
            staticImportedUrls.add({ url: hmrUrl, id: resolvedId })
          }
        } else if (!importer.startsWith(clientDir)) {
          if (!importer.includes('node_modules')) {
            // check @vite-ignore which suppresses dynamic import warning
            const hasViteIgnore = /\/\*\s*@vite-ignore\s*\*\//.test(
              // complete expression inside parens
              source.slice(dynamicIndex + 1, end)
            )
            if (!hasViteIgnore) {
              this.warn(
                `\n` +
                  colors.cyan(importerModule.file) +
                  `\n` +
                  generateCodeFrame(source, start) +
                  `\nThe above dynamic import cannot be analyzed by Vite.\n` +
                  `See ${colors.blue(
                    `https://github.com/rollup/plugins/tree/master/packages/dynamic-import-vars#limitations`
                  )} ` +
                  `for supported dynamic import formats. ` +
                  `If this is intended to be left as-is, you can use the ` +
                  `/* @vite-ignore */ comment inside the import() call to suppress this warning.\n`
              )
            }
          }

          if (!ssr) {
            const url = rawUrl
              .replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '')
              .trim()
            if (
              !/^('.*'|".*"|`.*`)$/.test(url) ||
              isExplicitImportRequired(url.slice(1, -1))
            ) {
              needQueryInjectHelper = true
              str().overwrite(
                start,
                end,
                `__vite__injectQuery(${url}, 'import')`,
                { contentOnly: true }
              )
            }
          }
        }
      }

      // 有env
      if (hasEnv) {
        // inject import.meta.env
        let env = `import.meta.env = ${JSON.stringify({
          ...config.env,
          SSR: !!ssr
        })};`
        // 用户的env定义
        // account for user env defines
        for (const key in config.define) {
          if (key.startsWith(`import.meta.env.`)) {
            const val = config.define[key]
            env += `${key} = ${
              typeof val === 'string' ? val : JSON.stringify(val)
            };`
          }
        }
        str().prepend(env)
      }

      // 有hmr
      if (hasHMR && !ssr) {
        debugHmr(
          `${
            isSelfAccepting
              ? `[self-accepts]`
              : isPartiallySelfAccepting
              ? `[accepts-exports]`
              : acceptedUrls.size
              ? `[accepts-deps]`
              : `[detected api usage]`
          } ${prettyImporter}`
        )
        // 注入hot上下文
        // inject hot context
        str().prepend(
          `import { createHotContext as __vite__createHotContext } from "${clientPublicPath}";` +
            `import.meta.hot = __vite__createHotContext(${JSON.stringify(
              importerModule.url // 当前需要被转换内容结果模块的url
            )});` // 注入这个创建hotContext代码交给import.meta.hot
        )
      }

      // 需要注入帮助者
      if (needQueryInjectHelper) {
        str().prepend(
          `import { injectQuery as __vite__injectQuery } from "${clientPublicPath}";`
        )
      }

      // ****
      // 序列化并且重写accepted的urls
      // normalize and rewrite accepted urls
      const normalizedAcceptedUrls = new Set<string>()
      for (const { url, start, end } of acceptedUrls) {
        const [normalized] = await moduleGraph.resolveUrl( // 它里面也是调用的是插件系统的resolveId钩子函数
          toAbsoluteUrl(markExplicitImport(url)),
          ssr
        )
        // ****
        normalizedAcceptedUrls.add(normalized) // 序列化后的accepted url
        str().overwrite(start, end, JSON.stringify(normalized), { // 重写
          contentOnly: true
        })
      }

      // ****
      // 更新HMR分析的模块图。节点CSS导入在css插件中进行自己的图更新，所以我们这里只处理js图更新。
      // update the module graph for HMR analysis.
      // node CSS imports does its own graph update in the css plugin so we
      // only handle js graph updates here.
      if (!isCSSRequest(importer)) {
        // 由pluginContainer.addWatchFile附加
        // attached by pluginContainer.addWatchFile
        // ****
        // 当前上下文context中保存的_addedImports，由插件容器addWatchFile附加
        // ****
        const pluginImports = (this as any)._addedImports as
          | Set<string>
          | undefined
        if (pluginImports) {
          ;(
            await Promise.all(
              [...pluginImports].map((id) => normalizeUrl(id, 0))
            )
          ).forEach(([url]) => importedUrls.add(url)) // ***importedUrls是一个Set集合，它可以进行实现去重***
        }
        // HMR transforms are no-ops in SSR, so an `accept` call will
        // never be injected. Avoid updating the `isSelfAccepting`
        // property for our module node in that case.
        if (ssr && importerModule.isSelfAccepting) {
          isSelfAccepting = true
        }
        // 在实践中，接受其所有导出的部分接受模块的行为与自接受模块类似
        // a partially accepted module that accepts all its exports
        // behaves like a self-accepted module in practice
        if (
          !isSelfAccepting &&
          isPartiallySelfAccepting &&
          acceptedExports.size >= exports.length &&
          exports.every((e) => acceptedExports.has(e.n))
        ) {
          isSelfAccepting = true
        }

        // ***
        // bar.js
        // foo.js
        //   import './bar'
        // main.js
        //   import './foo'

        // 针对foo mod来讲，它的incoming mod -> main mod
        // 它的outgoing mod -> bar mod
        // ***
        
        
        // ***
        // 更新模块图中的模块信息
        // 返回需要删除的导入模块
        // ***返回的是不再被导入的模块（备注：是incoming mods一个也没有的这些模块）***
        // ***
        const prunedImports = await moduleGraph.updateModuleInfo(
          importerModule, // 当前模块
          importedUrls, // 所有导入语句的urls
          importedBindings,
          normalizedAcceptedUrls, // 已序列化后的被接受的urls
          isPartiallySelfAccepting ? acceptedExports : null,
          isSelfAccepting, // 是否自身接受
          ssr
        ) // ****
        if (hasHMR && prunedImports) { // 有hmr 且 有需要删除的导入（备注：是incoming mods一个也没有的这些模块）
          // ****
          // 处理删除模块
          // ***需要删除incoming mods一个也没有的这些模块***
          // ****
          handlePrunedModules(prunedImports, server) // **重要**
        }
      }

      isDebug &&
        debug(
          `${timeFrom(start)} ${colors.dim(
            `[${importedUrls.size} imports rewritten] ${prettyImporter}`
          )}`
        )

      // 预（提前）转换在此文件内容中所知道的直接导入

      // pre-transform known direct imports
      // These requests will also be registered in transformRequest to be awaited
      // by the deps optimizer
      if (config.server.preTransformRequests && staticImportedUrls.size) {
        staticImportedUrls.forEach(({ url, id }) => {
          url = removeImportQuery(url)
          // 主直接执行transformRequest函数，那么在其内部也是直接在当前执行期间向_pendingRequest中缓存入对应的请求
          transformRequest(url, server, { ssr }).catch((e) => {
            if (e?.code === ERR_OUTDATED_OPTIMIZED_DEP) {
              // This are expected errors
              return
            }
            // Unexpected error, log the issue but avoid an unhandled exception
            config.logger.error(e.message)
          })
        })
      }

      // 上面的预转换和下面的返回都是在同一执行期间执行的中间没有间隔，那所以可以肯定的说上面的transformRequest函数中所执行的
      // 缓存请求的逻辑一定是在把内容响应给客户端之前就一定把它缓存在了server._pendingRequest中了
      // 这一点是非常可以肯定的 ~

      // 那么有了这一点关系证明后，那么之后客户端拿到代码内容再次发送请求当执行到transformRequest中时
      // 有可能server._pendingRequest还有（说明还未处理完成，因为一旦处理好了之后就会清除）
      // 也有可能没有，因为这个处理操作中间是要进行经典三部曲解析 -> 加载 -> 转换
      // 可以实验一下我们在某个阶段写个异步钩子需要3s后才能成功
      // 那么此时文件内容早已返回给了客户端，而客户端就会继续发送请求，此时执行到transformRequest这里发现还是有对应的待处理请求的
      // 那么就会重用这个待处理请求

      // 那如果客户端耽搁了3s，此时服务端的预转换早已执行完毕，客户端再发送请求，因为已经转换过了，直接使用转换过的结果就可（逻辑在transformRequest.ts中）

      // 然后再去返回字符串内容进行响应的
      if (s) {
        return transformStableResult(s, importer, config)
      } else {
        return source // 在async中return也是需要去执行ecma262中Await算法的 ~
      }
    }
  }
}

// 下面这两个函数所做的事情
// 对于已优化的cjs依赖，通过将命名导入重写为const赋值来支持命名导入。

// 互操作命名导入
export function interopNamedImports(
  str: MagicString,
  importSpecifier: ImportSpecifier,
  rewrittenUrl: string,
  importIndex: number
): void {
  const source = str.original
  const {
    s: start,
    e: end,
    ss: expStart,
    se: expEnd,
    d: dynamicIndex
  } = importSpecifier
  if (dynamicIndex > -1) {
    // rewrite `import('package')` to expose the default directly
    str.overwrite(
      expStart,
      expEnd,
      `import('${rewrittenUrl}').then(m => m.default && m.default.__esModule ? m.default : ({ ...m.default, default: m.default }))`,
      { contentOnly: true }
    )
  } else {
    const exp = source.slice(expStart, expEnd)
    const rawUrl = source.slice(start, end)
    const rewritten = transformCjsImport(exp, rewrittenUrl, rawUrl, importIndex) // 转换cjs导入
    if (rewritten) {
      str.overwrite(expStart, expEnd, rewritten, { contentOnly: true }) // 把原先的导入语句进行重写
    } else {
      // #1439 export * from '...'
      str.overwrite(start, end, rewrittenUrl, { contentOnly: true })
    }
  }
}

type ImportNameSpecifier = { importedName: string; localName: string }

/**
 * Detect import statements to a known optimized CJS dependency and provide
 * ES named imports interop. We do this by rewriting named imports to a variable
 * assignment to the corresponding property on the `module.exports` of the cjs
 * module. Note this doesn't support dynamic re-assignments from within the cjs
 * module.
 *
 * Note that es-module-lexer treats `export * from '...'` as an import as well,
 * so, we may encounter ExportAllDeclaration here, in which case `undefined`
 * will be returned.
 *
 * Credits \@csr632 via #837
 */
export function transformCjsImport(
  importExp: string,
  url: string,
  rawUrl: string,
  importIndex: number
): string | undefined {
  const node = (
    parseJS(importExp, {
      ecmaVersion: 'latest',
      sourceType: 'module'
    }) as any
  ).body[0] as Node

  if (
    node.type === 'ImportDeclaration' ||
    node.type === 'ExportNamedDeclaration'
  ) {
    if (!node.specifiers.length) {
      return `import "${url}"`
    }

    const importNames: ImportNameSpecifier[] = []
    const exportNames: string[] = []
    let defaultExports: string = ''
    for (const spec of node.specifiers) {
      if (
        spec.type === 'ImportSpecifier' &&
        spec.imported.type === 'Identifier'
      ) {
        const importedName = spec.imported.name
        const localName = spec.local.name
        importNames.push({ importedName, localName }) // 推入进来
      } else if (spec.type === 'ImportDefaultSpecifier') {
        importNames.push({
          importedName: 'default',
          localName: spec.local.name
        })
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        importNames.push({ importedName: '*', localName: spec.local.name })
      } else if (
        spec.type === 'ExportSpecifier' &&
        spec.exported.type === 'Identifier'
      ) {
        // for ExportSpecifier, local name is same as imported name
        // prefix the variable name to avoid clashing with other local variables
        const importedName = spec.local.name
        // we want to specify exported name as variable and re-export it
        const exportedName = spec.exported.name
        if (exportedName === 'default') {
          defaultExports = makeLegalIdentifier(
            `__vite__cjsExportDefault_${importIndex}`
          )
          importNames.push({ importedName, localName: defaultExports })
        } else {
          const localName = makeLegalIdentifier(
            `__vite__cjsExport_${exportedName}`
          )
          importNames.push({ importedName, localName })
          exportNames.push(`${localName} as ${exportedName}`)
        }
      }
    }

    // If there is multiple import for same id in one file,
    // importIndex will prevent the cjsModuleName to be duplicate
    const cjsModuleName = makeLegalIdentifier(
      `__vite__cjsImport${importIndex}_${rawUrl}`
    ) // 制作一个cjs模块名
    const lines: string[] = [`import ${cjsModuleName} from "${url}"`] // 使用默认导入
    importNames.forEach(({ importedName, localName }) => {
      if (importedName === '*') {
        lines.push(`const ${localName} = ${cjsModuleName}`)
      } else if (importedName === 'default') {
        lines.push(
          `const ${localName} = ${cjsModuleName}.__esModule ? ${cjsModuleName}.default : ${cjsModuleName}`
        )
      } else {
        lines.push(`const ${localName} = ${cjsModuleName}["${importedName}"]`) // 从默认导入中一一进行解构赋值
      }
    })
    if (defaultExports) {
      lines.push(`export default ${defaultExports}`)
    }
    if (exportNames.length) {
      lines.push(`export { ${exportNames.join(', ')} }`)
    }

    return lines.join('; ') // 形成代码字符串返回就可以啦 ~
  }
}
