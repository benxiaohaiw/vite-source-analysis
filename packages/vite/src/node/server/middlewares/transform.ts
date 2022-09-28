import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Connect } from 'dep-types/connect'
import colors from 'picocolors'
import type { ViteDevServer } from '..'
import {
  cleanUrl,
  createDebugger,
  ensureVolumeInPath,
  fsPathFromId,
  injectQuery,
  isImportRequest,
  isJSRequest,
  normalizePath,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
  unwrapId
} from '../../utils'
import { send } from '../send'
import { transformRequest } from '../transformRequest'
import { isHTMLProxy } from '../../plugins/html'
import {
  DEP_VERSION_RE,
  FS_PREFIX,
  NULL_BYTE_PLACEHOLDER
} from '../../constants'
import {
  isCSSRequest,
  isDirectCSSRequest,
  isDirectRequest
} from '../../plugins/css'
import {
  ERR_OPTIMIZE_DEPS_PROCESSING_ERROR,
  ERR_OUTDATED_OPTIMIZED_DEP
} from '../../plugins/optimizedDeps'
import { getDepsOptimizer } from '../../optimizer'

const debugCache = createDebugger('vite:cache')
const isDebug = !!process.env.DEBUG

const knownIgnoreList = new Set(['/', '/favicon.ico'])

export function transformMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  const {
    config: { root, logger },
    moduleGraph
  } = server

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteTransformMiddleware(req, res, next) {
    if (req.method !== 'GET' || knownIgnoreList.has(req.url!)) {
      return next()
    }

    let url: string
    try {
      url = decodeURI(removeTimestampQuery(req.url!)).replace(
        NULL_BYTE_PLACEHOLDER,
        '\0'
      )
    } catch (e) {
      return next(e)
    }

    const withoutQuery = cleanUrl(url)

    try {
      const isSourceMap = withoutQuery.endsWith('.map')
      // since we generate source map references, handle those requests here
      if (isSourceMap) {
        const depsOptimizer = getDepsOptimizer(server.config, false) // non-ssr
        if (depsOptimizer?.isOptimizedDepUrl(url)) {
          // If the browser is requesting a source map for an optimized dep, it
          // means that the dependency has already been pre-bundled and loaded
          const mapFile = url.startsWith(FS_PREFIX)
            ? fsPathFromId(url)
            : normalizePath(
                ensureVolumeInPath(path.resolve(root, url.slice(1)))
              )
          try {
            const map = await fs.readFile(mapFile, 'utf-8')
            return send(req, res, map, 'json', {
              headers: server.config.server.headers
            })
          } catch (e) {
            // Outdated source map request for optimized deps, this isn't an error
            // but part of the normal flow when re-optimizing after missing deps
            // Send back an empty source map so the browser doesn't issue warnings
            const dummySourceMap = {
              version: 3,
              file: mapFile.replace(/\.map$/, ''),
              sources: [],
              sourcesContent: [],
              names: [],
              mappings: ';;;;;;;;;'
            }
            return send(req, res, JSON.stringify(dummySourceMap), 'json', {
              cacheControl: 'no-cache',
              headers: server.config.server.headers
            })
          }
        } else {
          const originalUrl = url.replace(/\.map($|\?)/, '$1')
          const map = (await moduleGraph.getModuleByUrl(originalUrl, false))
            ?.transformResult?.map
          if (map) {
            return send(req, res, JSON.stringify(map), 'json', {
              headers: server.config.server.headers
            })
          } else {
            return next()
          }
        }
      }

      // check if public dir is inside root dir
      const publicDir = normalizePath(server.config.publicDir)
      const rootDir = normalizePath(server.config.root)
      if (publicDir.startsWith(rootDir)) {
        const publicPath = `${publicDir.slice(rootDir.length)}/`
        // warn explicit public paths
        if (url.startsWith(publicPath)) {
          let warning: string

          if (isImportRequest(url)) {
            const rawUrl = removeImportQuery(url)

            warning =
              'Assets in public cannot be imported from JavaScript.\n' +
              `Instead of ${colors.cyan(
                rawUrl
              )}, put the file in the src directory, and use ${colors.cyan(
                rawUrl.replace(publicPath, '/src/')
              )} instead.`
          } else {
            warning =
              `files in the public directory are served at the root path.\n` +
              `Instead of ${colors.cyan(url)}, use ${colors.cyan(
                url.replace(publicPath, '/')
              )}.`
          }

          logger.warn(colors.yellow(warning))
        }
      }

      if (
        isJSRequest(url) ||
        isImportRequest(url) ||
        isCSSRequest(url) ||
        isHTMLProxy(url)
      ) {
        // strip ?import
        url = removeImportQuery(url)
        // Strip valid id prefix. This is prepended to resolved Ids that are
        // not valid browser import specifiers by the importAnalysis plugin.
        url = unwrapId(url)

        // ***
        // importAnalysisPlugin中的transform函数所做的提前处理 ------
        // vite v3.1.3的测试数据
        // main.js
        //   import './style.css' -> import '/style.css'
        //   import javascriptLogo from './javascript.svg' -> import javascriptLogo from '/javascript.svg?import' -> /javascript.svg?import -> export default '/javascript.svg'
        //   import { setupCounter } from './counter.js' -> import { setupCounter } from '/counter.js'
        //   import * as echarts from 'echarts' -> import * as echarts from '/node_modules/.vite/deps/echarts.js?v=3acf7852'
        // style.css
        // ***

        // 对于css来讲需要去区分正常css请求和导入css请求
        // vitejs.dev
        // /index.html
        //   <link rel="stylesheet" href="/assets/style.89d7223d.css"> -> vitejs.dev/assets/style.89d7223d.css -> 请求头中是会带有accept: text/css,*/*;q=0.1
        // 而对于上述的import './style.css'来讲 -> import '/style.css' -> 请求头中是没有accept: text/css,*/*;q=0.1的，所以靠这个请求头参数就可以
        // 来进行区分是正常的link css请求还是import css请求啦 ~

        // for CSS, we need to differentiate between normal CSS requests and
        // imports
        if (
          isCSSRequest(url) &&
          !isDirectRequest(url) &&
          req.headers.accept?.includes('text/css') // import css请求是没有该请求头的，所以false
        ) {
          url = injectQuery(url, 'direct') // 对于link标签的css请求（正常css请求）需要注入direct
        }

        // 检测是否可以较早的返回304
        // check if we can return 304 early
        const ifNoneMatch = req.headers['if-none-match'] // 第一次请求没有这个请求头，之后的请求就会有这个请求头，且它的值是第一次请求响应时的etag响应头的值
        if (
          ifNoneMatch &&
          (await moduleGraph.getModuleByUrl(url, false))?.transformResult
            ?.etag === ifNoneMatch // 在这里的值其实是hash，对比一下客户端带过来的hash值和服务端这里这个模块的hash是否变化了，若没有变化-
            // 则直接返回304告诉浏览器服务器资源没有变化，然后使用上次请求响应的结果缓存就可以啦 ~
        ) {
          // https://www.cnblogs.com/andong2015/p/13437586.html
          isDebug && debugCache(`[304] ${prettifyUrl(url, root)}`)
          res.statusCode = 304
          return res.end()
        }

        // 使用插件容器进行经典三部曲：解析 -> 加载 -> 转换
        // 产生最终的结果
        // resolve, load and transform using the plugin container
        const result = await transformRequest(url, server, {
          html: req.headers.accept?.includes('text/html')
        })
        if (result) {
          // 获取依赖优化器
          const depsOptimizer = getDepsOptimizer(server.config, false) // non-ssr
          const type = isDirectCSSRequest(url) ? 'css' : 'js' // 类型 -> 响应类型
          const isDep =
            DEP_VERSION_RE.test(url) || depsOptimizer?.isOptimizedDepUrl(url) // 对url做判断是否为依赖请求的url
          return send(req, res, result.code, type, {
            etag: result.etag, // 结果的etag，其实就是文件内容的hash
            // allow browser to cache npm deps!
            cacheControl: isDep ? 'max-age=31536000,immutable' : 'no-cache', // 允许浏览器去缓存npm依赖，若不是依赖则不缓存
            headers: server.config.server.headers,
            map: result.map
          })
        }
      }
    } catch (e) {
      if (e?.code === ERR_OPTIMIZE_DEPS_PROCESSING_ERROR) {
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504 // status code request timeout
          res.end()
        }
        // This timeout is unexpected
        logger.error(e.message)
        return
      }
      if (e?.code === ERR_OUTDATED_OPTIMIZED_DEP) {
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504 // status code request timeout
          res.end()
        }
        // We don't need to log an error in this case, the request
        // is outdated because new dependencies were discovered and
        // the new pre-bundle dependencies have changed.
        // A full-page reload has been issued, and these old requests
        // can't be properly fulfilled. This isn't an unexpected
        // error but a normal part of the missing deps discovery flow
        return
      }
      return next(e)
    }

    next()
  }
}
