import path from 'node:path'
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { Options } from 'sirv'
import sirv from 'sirv'
import type { Connect } from 'dep-types/connect'
import type { ViteDevServer } from '../..'
import { FS_PREFIX } from '../../constants'
import {
  cleanUrl,
  fsPathFromId,
  fsPathFromUrl,
  isFileReadable,
  isImportRequest,
  isInternalRequest,
  isParentDirectory,
  isWindows,
  slash
} from '../../utils'

const sirvOptions = (headers?: OutgoingHttpHeaders): Options => {
  return {
    dev: true,
    etag: true,
    extensions: [],
    setHeaders(res, pathname) {
      // Matches js, jsx, ts, tsx.
      // The reason this is done, is that the .ts file extension is reserved
      // for the MIME type video/mp2t. In almost all cases, we can expect
      // these files to be TypeScript files, and for Vite to serve them with
      // this Content-Type.
      if (/\.[tj]sx?$/.test(pathname)) {
        res.setHeader('Content-Type', 'application/javascript')
      }
      if (headers) {
        for (const name in headers) {
          res.setHeader(name, headers[name]!)
        }
      }
    }
  }
}

// ***
// 服务public中间件
// 这个中间件是在transformMiddleware中间的前面
// ***
export function servePublicMiddleware(
  dir: string,
  headers?: OutgoingHttpHeaders
): Connect.NextHandleFunction {
  const serve = sirv(dir, sirvOptions(headers))

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteServePublicMiddleware(req, res, next) {

    // ***
    // 跳过带有?import的请求或者是内部请求，那么这些都是需要进行跳过的
    // ***

    // ***
    // utils.ts
    // const importQueryRE = /(\?|&)import=?(?:&|$)/
    // const internalPrefixes = [
    //   FS_PREFIX,
    //   VALID_ID_PREFIX,
    //   CLIENT_PUBLIC_PATH,
    //   ENV_PUBLIC_PATH
    // ]
    // export const isImportRequest = (url: string): boolean => importQueryRE.test(url)
    // export const isInternalRequest = (url: string): boolean =>
    //   InternalPrefixRE.test(url)
    // ***

    // skip import request and internal requests `/@fs/ /@vite-client` etc...
    if (isImportRequest(req.url!) || isInternalRequest(req.url!)) {
      return next()
    }
    serve(req, res, next) // ***
    // ***
    // 在这个函数的逻辑就是如果该请求最终在public目录下找到了资源，那么就直接返回啦，不会向下面的中间件继续进行相应的逻辑了
    // 那么如果不存在该资源 - 则直接交给下面的中间件进行处理（这里的逻辑和上面的是import query请求或是内部请求是一样的逻辑，也是直接进行next函数的执行）
    // 所以就来到下面的transformMiddleware中间件里面进行相应的处理
    // ***
  }
}

// 服务静态中间件
export function serveStaticMiddleware(
  dir: string,
  server: ViteDevServer
): Connect.NextHandleFunction {
  const serve = sirv(dir, sirvOptions(server.config.server.headers))

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteServeStaticMiddleware(req, res, next) {
    // only serve the file if it's not an html request or ends with `/`
    // so that html requests can fallthrough to our html middleware for
    // special processing
    // also skip internal requests `/@fs/ /@vite-client` etc...
    const cleanedUrl = cleanUrl(req.url!)
    if (
      cleanedUrl.endsWith('/') ||
      path.extname(cleanedUrl) === '.html' ||
      isInternalRequest(req.url!)
    ) {
      return next()
    }

    const url = new URL(req.url!, 'http://example.com')
    const pathname = decodeURIComponent(url.pathname)

    // apply aliases to static requests as well
    let redirectedPathname: string | undefined
    for (const { find, replacement } of server.config.resolve.alias) {
      const matches =
        typeof find === 'string'
          ? pathname.startsWith(find)
          : find.test(pathname)
      if (matches) {
        redirectedPathname = pathname.replace(find, replacement)
        break
      }
    }
    if (redirectedPathname) {
      // dir is pre-normalized to posix style
      if (redirectedPathname.startsWith(dir)) {
        redirectedPathname = redirectedPathname.slice(dir.length)
      }
    }

    const resolvedPathname = redirectedPathname || pathname
    let fileUrl = path.resolve(dir, resolvedPathname.replace(/^\//, ''))
    if (resolvedPathname.endsWith('/') && !fileUrl.endsWith('/')) {
      fileUrl = fileUrl + '/'
    }
    if (!ensureServingAccess(fileUrl, server, res, next)) {
      return
    }

    if (redirectedPathname) {
      url.pathname = encodeURIComponent(redirectedPathname)
      req.url = url.href.slice(url.origin.length)
    }

    serve(req, res, next)
  }
}

// 服务原fs中间件
// 主要是针对于/@fs/开头的请求
export function serveRawFsMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  const serveFromRoot = sirv('/', sirvOptions(server.config.server.headers))

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteServeRawFsMiddleware(req, res, next) {
    const url = new URL(req.url!, 'http://example.com')
    // In some cases (e.g. linked monorepos) files outside of root will
    // reference assets that are also out of served root. In such cases
    // the paths are rewritten to `/@fs/` prefixed paths and must be served by
    // searching based from fs root.
    if (url.pathname.startsWith(FS_PREFIX)) {
      const pathname = decodeURIComponent(url.pathname)
      // restrict files outside of `fs.allow`
      if (
        !ensureServingAccess(
          slash(path.resolve(fsPathFromId(pathname))),
          server,
          res,
          next
        )
      ) {
        return
      }

      let newPathname = pathname.slice(FS_PREFIX.length)
      if (isWindows) newPathname = newPathname.replace(/^[A-Z]:/i, '')

      url.pathname = encodeURIComponent(newPathname)
      req.url = url.href.slice(url.origin.length)
      serveFromRoot(req, res, next)
    } else {
      next()
    }
  }
}

export function isFileServingAllowed(
  url: string,
  server: ViteDevServer
): boolean {
  if (!server.config.server.fs.strict) return true

  const file = fsPathFromUrl(url)

  if (server._fsDenyGlob(file)) return false

  if (server.moduleGraph.safeModulesPath.has(file)) return true

  if (server.config.server.fs.allow.some((dir) => isParentDirectory(dir, file)))
    return true

  return false
}

function ensureServingAccess(
  url: string,
  server: ViteDevServer,
  res: ServerResponse,
  next: Connect.NextFunction
): boolean {
  if (isFileServingAllowed(url, server)) {
    return true
  }
  if (isFileReadable(cleanUrl(url))) {
    const urlMessage = `The request url "${url}" is outside of Vite serving allow list.`
    const hintMessage = `
${server.config.server.fs.allow.map((i) => `- ${i}`).join('\n')}

Refer to docs https://vitejs.dev/config/server-options.html#server-fs-allow for configurations and more details.`

    server.config.logger.error(urlMessage)
    server.config.logger.warnOnce(hintMessage + '\n')
    res.statusCode = 403
    res.write(renderRestrictedErrorHTML(urlMessage + '\n' + hintMessage))
    res.end()
  } else {
    // if the file doesn't exist, we shouldn't restrict this path as it can
    // be an API call. Middlewares would issue a 404 if the file isn't handled
    next()
  }
  return false
}

function renderRestrictedErrorHTML(msg: string): string {
  // to have syntax highlighting and autocompletion in IDE
  const html = String.raw
  return html`
    <body>
      <h1>403 Restricted</h1>
      <p>${msg.replace(/\n/g, '<br/>')}</p>
      <style>
        body {
          padding: 1em 2em;
        }
      </style>
    </body>
  `
}
