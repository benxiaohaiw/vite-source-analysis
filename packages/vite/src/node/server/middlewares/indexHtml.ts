import fs from 'node:fs'
import path from 'node:path'
import MagicString from 'magic-string'
import type { SourceMapInput } from 'rollup'
import type { Connect } from 'dep-types/connect'
import type { DefaultTreeAdapterMap, Token } from 'parse5'
import type { IndexHtmlTransformHook } from '../../plugins/html'
import {
  addToHTMLProxyCache,
  applyHtmlTransforms,
  assetAttrsConfig,
  getScriptInfo,
  nodeIsElement,
  overwriteAttrValue,
  postImportMapHook,
  preImportMapHook,
  resolveHtmlTransforms,
  traverseHtml
} from '../../plugins/html'
import type { ResolvedConfig, ViteDevServer } from '../..'
import { send } from '../send'
import { CLIENT_PUBLIC_PATH, FS_PREFIX } from '../../constants'
import {
  cleanUrl,
  ensureWatchedFile,
  fsPathFromId,
  injectQuery,
  normalizePath,
  processSrcSetSync,
  wrapId
} from '../../utils'
import type { ModuleGraph } from '../moduleGraph'

interface AssetNode {
  start: number
  end: number
  code: string
}

export function createDevHtmlTransformFn(
  server: ViteDevServer
): (url: string, html: string, originalUrl: string) => Promise<string> {
  const [preHooks, postHooks] = resolveHtmlTransforms(server.config.plugins)
  return (url: string, html: string, originalUrl: string): Promise<string> => { // 返回的该函数就是server下的transformIndexHtml函数
    return applyHtmlTransforms(
      html, // html内容字符串
      [
        preImportMapHook(server.config),
        ...preHooks,
        devHtmlHook, // 内置的开发html钩子
        ...postHooks,
        postImportMapHook()
      ],
      {
        path: url,
        filename: getHtmlFilename(url, server),
        server,
        originalUrl
      }
    )
  }
}

function getHtmlFilename(url: string, server: ViteDevServer) {
  if (url.startsWith(FS_PREFIX)) {
    return decodeURIComponent(fsPathFromId(url))
  } else {
    return decodeURIComponent(
      normalizePath(path.join(server.config.root, url.slice(1)))
    )
  }
}

const startsWithSingleSlashRE = /^\/(?!\/)/
const processNodeUrl = (
  attr: Token.Attribute,
  sourceCodeLocation: Token.Location,
  s: MagicString,
  config: ResolvedConfig,
  htmlPath: string,
  originalUrl?: string,
  moduleGraph?: ModuleGraph
) => {
  let url = attr.value || ''

  if (moduleGraph) {
    const mod = moduleGraph.urlToModuleMap.get(url)
    if (mod && mod.lastHMRTimestamp > 0) {
      url = injectQuery(url, `t=${mod.lastHMRTimestamp}`)
    }
  }
  const devBase = config.base
  if (startsWithSingleSlashRE.test(url)) {
    // prefix with base (dev only, base is never relative)
    overwriteAttrValue(s, sourceCodeLocation, devBase + url.slice(1))
  } else if (
    url.startsWith('.') &&
    originalUrl &&
    originalUrl !== '/' &&
    htmlPath === '/index.html'
  ) {
    const replacer = (url: string) =>
      path.posix.join(
        devBase,
        path.posix.relative(originalUrl, devBase),
        url.slice(1)
      )

    // #3230 if some request url (localhost:3000/a/b) return to fallback html, the relative assets
    // path will add `/a/` prefix, it will caused 404.
    // rewrite before `./index.js` -> `localhost:5173/a/index.js`.
    // rewrite after `../index.js` -> `localhost:5173/index.js`.

    const processedUrl =
      attr.name === 'srcset'
        ? processSrcSetSync(url, ({ url }) => replacer(url))
        : replacer(url)
    overwriteAttrValue(s, sourceCodeLocation, processedUrl)
  }
}
const devHtmlHook: IndexHtmlTransformHook = async (
  html,
  { path: htmlPath, filename, server, originalUrl }
) => {
  const { config, moduleGraph, watcher } = server!
  const base = config.base || '/'

  let proxyModulePath: string
  let proxyModuleUrl: string

  const trailingSlash = htmlPath.endsWith('/')
  if (!trailingSlash && fs.existsSync(filename)) {
    proxyModulePath = htmlPath
    proxyModuleUrl = base + htmlPath.slice(1)
  } else {
    // There are users of vite.transformIndexHtml calling it with url '/'
    // for SSR integrations #7993, filename is root for this case
    // A user may also use a valid name for a virtual html file
    // Mark the path as virtual in both cases so sourcemaps aren't processed
    // and ids are properly handled
    const validPath = `${htmlPath}${trailingSlash ? 'index.html' : ''}`
    proxyModulePath = `\0${validPath}`
    proxyModuleUrl = wrapId(proxyModulePath)
  }

  const s = new MagicString(html)
  let inlineModuleIndex = -1
  const proxyCacheUrl = cleanUrl(proxyModulePath).replace(
    normalizePath(config.root),
    ''
  )
  const styleUrl: AssetNode[] = []

  const addInlineModule = (
    node: DefaultTreeAdapterMap['element'],
    ext: 'js'
  ) => {
    inlineModuleIndex++

    const contentNode = node.childNodes[0] as DefaultTreeAdapterMap['textNode']

    const code = contentNode.value

    let map: SourceMapInput | undefined
    if (!proxyModulePath.startsWith('\0')) {
      map = new MagicString(html)
        .snip(
          contentNode.sourceCodeLocation!.startOffset,
          contentNode.sourceCodeLocation!.endOffset
        )
        .generateMap({ hires: true })
      map.sources = [filename]
      map.file = filename
    }

    // add HTML Proxy to Map
    addToHTMLProxyCache(config, proxyCacheUrl, inlineModuleIndex, { code, map })

    // inline js module. convert to src="proxy" (dev only, base is never relative)
    const modulePath = `${proxyModuleUrl}?html-proxy&index=${inlineModuleIndex}.${ext}`

    // invalidate the module so the newly cached contents will be served
    const module = server?.moduleGraph.getModuleById(modulePath)
    if (module) {
      server?.moduleGraph.invalidateModule(module)
    }
    s.overwrite(
      node.sourceCodeLocation!.startOffset,
      node.sourceCodeLocation!.endOffset,
      `<script type="module" src="${modulePath}"></script>`, // 重写成外部资源引入的方式
      { contentOnly: true }
    )
  }

  // 迭代html
  await traverseHtml(html, htmlPath, (node) => {
    if (!nodeIsElement(node)) {
      return
    }

    // script元素
    // script tags
    if (node.nodeName === 'script') {
      const { src, sourceCodeLocation, isModule } = getScriptInfo(node)

      // 如果有src那说明是外部引入，直接处理节点的url就行啦
      if (src) {
        processNodeUrl(
          src,
          sourceCodeLocation!,
          s,
          config,
          htmlPath,
          originalUrl,
          moduleGraph
        )
      } else if (isModule && node.childNodes.length) { // 如果是type是module且是内联（没有src，在标签内部写了esm代码）
        addInlineModule(node, 'js') // 增加内联模块
        // 把内联模块转为外部脚本形式，其中的内联代码会被取出存入一个Map中
      }
    }

    // style元素且元素标签中有内容
    if (node.nodeName === 'style' && node.childNodes.length) {
      const children = node.childNodes[0] as DefaultTreeAdapterMap['textNode']
      styleUrl.push({
        start: children.sourceCodeLocation!.startOffset,
        end: children.sourceCodeLocation!.endOffset,
        code: children.value // style标签的内容
      })
    }

    // 像link标签...
    // 带有href/src属性的元素
    // elements with [href/src] attrs
    const assetAttrs = assetAttrsConfig[node.nodeName]
    if (assetAttrs) {
      for (const p of node.attrs) {
        if (p.value && assetAttrs.includes(p.name)) {
          processNodeUrl( // 处理节点带有url值的属性，也就是只重写url
            p,
            node.sourceCodeLocation!.attrs![p.name],
            s,
            config,
            htmlPath,
            originalUrl
          )
        }
      }
    }
  })

  await Promise.all(
    styleUrl.map(async ({ start, end, code }, index) => {
      const url = `${proxyModulePath}?html-proxy&direct&index=${index}.css`

      // ensure module in graph after successful load
      const mod = await moduleGraph.ensureEntryFromUrl(url, false) // 确保模块图中有该url对应的mod
      ensureWatchedFile(watcher, mod.file, config.root) // 确保观察此文件，实际上可以认为就是当前的index.html文件

      const result = await server!.pluginContainer.transform(code, mod.id!) // 使用插件容器直接对内联样式代码做了一个转换处理
      s.overwrite(start, end, result?.code || '') // 然后也是直接把处理后的代码给重写回去
      // 对于样式内联代码并没有取出做缓存
    })
  )

  html = s.toString()

  return {
    html, // 转换后的html字符串
    tags: [ // 添加一个<script type="module" src="/@vite/client"></script>标签到head-prepend这个位置
      {
        tag: 'script',
        attrs: {
          type: 'module',
          src: path.posix.join(base, CLIENT_PUBLIC_PATH)
        },
        injectTo: 'head-prepend'
      }
    ]
  }
}

export function indexHtmlMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteIndexHtmlMiddleware(req, res, next) {
    if (res.writableEnded) {
      return next()
    }

    const url = req.url && cleanUrl(req.url)
    // spa-fallback always redirects to /index.html // spa回退中间件总是重定向到/index.html
    if (url?.endsWith('.html') && req.headers['sec-fetch-dest'] !== 'script') { // 是.html结尾且sec-fetch-dest请求头不是script
      const filename = getHtmlFilename(url, server)
      if (fs.existsSync(filename)) { // 若此文件存在
        try {
          let html = fs.readFileSync(filename, 'utf-8') // 读取文件内容
          html = await server.transformIndexHtml(url, html, req.originalUrl) // 调用server下的transformIndexHtml函数
          return send(req, res, html, 'html', { // 发送回去
            headers: server.config.server.headers
          })
        } catch (e) {
          return next(e)
        }
      }
    }
    next()
  }
}
