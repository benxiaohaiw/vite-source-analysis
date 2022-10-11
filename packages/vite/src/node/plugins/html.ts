import path from 'node:path'
import type {
  OutputAsset,
  OutputBundle,
  OutputChunk,
  RollupError,
  SourceMapInput
} from 'rollup'
import MagicString from 'magic-string'
import colors from 'picocolors'
import type { DefaultTreeAdapterMap, ParserError, Token } from 'parse5'
import { stripLiteral } from 'strip-literal'
import type { Plugin } from '../plugin'
import type { ViteDevServer } from '../server'
import {
  cleanUrl,
  generateCodeFrame,
  getHash,
  isDataUrl,
  isExternalUrl,
  normalizePath,
  processSrcSet
} from '../utils'
import type { ResolvedConfig } from '../config'
import { toOutputFilePathInHtml } from '../build'
import {
  assetUrlRE,
  checkPublicFile,
  getAssetFilename,
  getPublicAssetFilename,
  publicAssetUrlRE,
  urlToBuiltUrl
} from './asset'
import { isCSSRequest } from './css'
import { modulePreloadPolyfillId } from './modulePreloadPolyfill'

interface ScriptAssetsUrl {
  start: number
  end: number
  url: string
}

const htmlProxyRE = /\?html-proxy=?(?:&inline-css)?&index=(\d+)\.(js|css)$/
const inlineCSSRE = /__VITE_INLINE_CSS__([a-z\d]{8}_\d+)__/g
// Do not allow preceding '.', but do allow preceding '...' for spread operations
const inlineImportRE =
  /(?<!(?<!\.\.)\.)\bimport\s*\(("([^"]|(?<=\\)")*"|'([^']|(?<=\\)')*')\)/g
const htmlLangRE = /\.(html|htm)$/

const importMapRE =
  /[ \t]*<script[^>]*type\s*=\s*["']?importmap["']?[^>]*>.*?<\/script>/is
const moduleScriptRE = /[ \t]*<script[^>]*type\s*=\s*["']?module["']?[^>]*>/is

export const isHTMLProxy = (id: string): boolean => htmlProxyRE.test(id)

export const isHTMLRequest = (request: string): boolean =>
  htmlLangRE.test(request)

// HTML Proxy Caches are stored by config -> filePath -> index
export const htmlProxyMap = new WeakMap<
  ResolvedConfig,
  Map<string, Array<{ code: string; map?: SourceMapInput }>>
>()

// HTML Proxy Transform result are stored by config
// `${hash(importer)}_${query.index}` -> transformed css code
// PS: key like `hash(/vite/playground/assets/index.html)_1`)
export const htmlProxyResult = new Map<string, string>()

export function htmlInlineProxyPlugin(config: ResolvedConfig): Plugin {
  // Should do this when `constructor` rather than when `buildStart`,
  // `buildStart` will be triggered multiple times then the cached result will be emptied.
  // https://github.com/vitejs/vite/issues/6372
  htmlProxyMap.set(config, new Map())
  return {
    name: 'vite:html-inline-proxy',

    resolveId(id) {
      // 是否是代理（vite自己做的）
      if (htmlProxyRE.test(id)) {
        return id
      }
    },

    // 这里主要是处理下面这些情况的
    // html字符串中出现<div style="background-image: url(...)">这种形式的
    // 和<style>...</style>这种的

    load(id) {
      const proxyMatch = id.match(htmlProxyRE)
      if (proxyMatch) {
        const index = Number(proxyMatch[1])
        const file = cleanUrl(id)
        const url = file.replace(normalizePath(config.root), '')
        const result = htmlProxyMap.get(config)!.get(url)![index] // 直接到map中获取结果
        if (result) {
          return result // 返回结果
        } else {
          throw new Error(`No matching HTML proxy module found from ${id}`)
        }
      }
    }
  }
}

export function addToHTMLProxyCache(
  config: ResolvedConfig,
  filePath: string,
  index: number,
  result: { code: string; map?: SourceMapInput }
): void {
  if (!htmlProxyMap.get(config)) {
    htmlProxyMap.set(config, new Map())
  }
  if (!htmlProxyMap.get(config)!.get(filePath)) {
    htmlProxyMap.get(config)!.set(filePath, [])
  }
  htmlProxyMap.get(config)!.get(filePath)![index] = result
}

export function addToHTMLProxyTransformResult(
  hash: string,
  code: string
): void {
  htmlProxyResult.set(hash, code)
}

// this extends the config in @vue/compiler-sfc with <link href>
export const assetAttrsConfig: Record<string, string[]> = {
  link: ['href'],
  video: ['src', 'poster'],
  source: ['src', 'srcset'],
  img: ['src', 'srcset'],
  image: ['xlink:href', 'href'],
  use: ['xlink:href', 'href']
}

export const isAsyncScriptMap = new WeakMap<
  ResolvedConfig,
  Map<string, boolean>
>()

export function nodeIsElement(
  node: DefaultTreeAdapterMap['node']
): node is DefaultTreeAdapterMap['element'] {
  return node.nodeName[0] !== '#'
}

function traverseNodes(
  node: DefaultTreeAdapterMap['node'],
  visitor: (node: DefaultTreeAdapterMap['node']) => void
) {
  visitor(node)
  if (
    nodeIsElement(node) ||
    node.nodeName === '#document' ||
    node.nodeName === '#document-fragment'
  ) {
    node.childNodes.forEach((childNode) => traverseNodes(childNode, visitor))
  }
}

export async function traverseHtml(
  html: string,
  filePath: string,
  visitor: (node: DefaultTreeAdapterMap['node']) => void
): Promise<void> {
  // lazy load compiler
  const { parse } = await import('parse5')
  const ast = parse(html, {
    sourceCodeLocationInfo: true,
    onParseError: (e: ParserError) => {
      handleParseError(e, html, filePath)
    }
  })
  traverseNodes(ast, visitor)
}

export function getScriptInfo(node: DefaultTreeAdapterMap['element']): {
  src: Token.Attribute | undefined
  sourceCodeLocation: Token.Location | undefined
  isModule: boolean
  isAsync: boolean
} {
  let src: Token.Attribute | undefined
  let sourceCodeLocation: Token.Location | undefined
  let isModule = false
  let isAsync = false
  for (const p of node.attrs) {
    if (p.name === 'src') {
      if (!src) {
        src = p
        sourceCodeLocation = node.sourceCodeLocation?.attrs!['src']
      }
    } else if (p.name === 'type' && p.value && p.value === 'module') {
      isModule = true
    } else if (p.name === 'async') {
      isAsync = true
    }
  }
  return { src, sourceCodeLocation, isModule, isAsync }
}

const attrValueStartRE = /=[\s\t\n\r]*(.)/

export function overwriteAttrValue(
  s: MagicString,
  sourceCodeLocation: Token.Location,
  newValue: string
): MagicString {
  const srcString = s.slice(
    sourceCodeLocation.startOffset,
    sourceCodeLocation.endOffset
  )
  const valueStart = srcString.match(attrValueStartRE)
  if (!valueStart) {
    // overwrite attr value can only be called for a well-defined value
    throw new Error(
      `[vite:html] internal error, failed to overwrite attribute value`
    )
  }
  const wrapOffset = valueStart[1] === '"' || valueStart[1] === "'" ? 1 : 0
  const valueOffset = valueStart.index! + valueStart[0].length - 1
  s.overwrite(
    sourceCodeLocation.startOffset + valueOffset + wrapOffset,
    sourceCodeLocation.endOffset - wrapOffset,
    newValue,
    { contentOnly: true }
  )
  return s
}

/**
 * Format parse5 @type {ParserError} to @type {RollupError}
 */
function formatParseError(
  parserError: ParserError,
  id: string,
  html: string
): RollupError {
  const formattedError: RollupError = {
    code: parserError.code,
    message: `parse5 error code ${parserError.code}`
  }
  formattedError.frame = generateCodeFrame(html, parserError.startOffset)
  formattedError.loc = {
    file: id,
    line: parserError.startLine,
    column: parserError.startCol
  }
  return formattedError
}

function handleParseError(
  parserError: ParserError,
  html: string,
  filePath: string
) {
  switch (parserError.code) {
    case 'missing-doctype':
      // ignore missing DOCTYPE
      return
    case 'abandoned-head-element-child':
      // Accept elements without closing tag in <head>
      return
    case 'duplicate-attribute':
      // Accept duplicate attributes #9566
      // The first attribute is used, browsers silently ignore duplicates
      return
  }
  const parseError = {
    loc: filePath,
    frame: '',
    ...formatParseError(parserError, filePath, html)
  }
  throw new Error(
    `Unable to parse HTML; ${parseError.message}\n at ${JSON.stringify(
      parseError.loc
    )}\n${parseError.frame}`
  )
}

// ***
// 将index.html编译为一个入口js模块
// ***
/**
 * Compiles index.html into an entry js module
 */
export function buildHtmlPlugin(config: ResolvedConfig): Plugin {
  const [preHooks, postHooks] = resolveHtmlTransforms(config.plugins)
  preHooks.unshift(preImportMapHook(config))
  postHooks.push(postImportMapHook())
  const processedHtml = new Map<string, string>()
  const isExcludedUrl = (url: string) =>
    url.startsWith('#') ||
    isExternalUrl(url) ||
    isDataUrl(url) ||
    checkPublicFile(url, config)
  // Same reason with `htmlInlineProxyPlugin`
  isAsyncScriptMap.set(config, new Map())

  return {
    name: 'vite:build-html',

    // 构建时的transform钩子函数
    async transform(html, id) {
      if (id.endsWith('.html')) {
        // 相对路径
        // index.html
        const relativeUrlPath = path.posix.relative(
          config.root,
          normalizePath(id)
        )
        const publicPath = `/${relativeUrlPath}` // /index.html
        const publicBase = getBaseInHTML(relativeUrlPath, config) // 获取配置中在html中的公共基础url

        const publicToRelative = (filename: string, importer: string) =>
          publicBase + filename
        const toOutputPublicFilePath = (url: string) =>
          toOutputFilePathInHtml(
            url.slice(1),
            'public',
            relativeUrlPath,
            'html',
            config,
            publicToRelative
          )

        // 应用对html的预转换钩子函数，得到最终的html字符串
        // pre-transform
        html = await applyHtmlTransforms(html, preHooks, {
          path: publicPath,
          filename: id
        })

        // 准备拼接js字符串
        let js = ''
        const s = new MagicString(html)
        // 资源url数组
        const assetUrls: {
          attr: Token.Attribute
          sourceCodeLocation: Token.Location
        }[] = []
        // 脚本url数组
        const scriptUrls: ScriptAssetsUrl[] = []
        // 样式url数组
        const styleUrls: ScriptAssetsUrl[] = []
        let inlineModuleIndex = -1 // 内联模块下标

        // 每个script标签都是异步的 - 默认
        let everyScriptIsAsync = true
        let someScriptsAreAsync = false // 一些脚本是异步的
        let someScriptsAreDefer = false // 一些脚本标签是defer的

        // 直接迭代遍历html字符串
        await traverseHtml(html, id, (node) => { // 对每个节点处理的回调函数
          if (!nodeIsElement(node)) { // 节点不是元素节点直接返回
            return
          }

          let shouldRemove = false // 是否应该删除

          // script tags
          if (node.nodeName === 'script') { // 对于script标签元素的处理
            const { src, sourceCodeLocation, isModule, isAsync } =
              getScriptInfo(node) // 获取script标签元素的信息

            const url = src && src.value
            const isPublicFile = !!(url && checkPublicFile(url, config)) // src的值是否为public目录下的文件
            if (isPublicFile) { // 是的话，直接重写带有基础url的
              // referencing public dir url, prefix with base
              overwriteAttrValue(
                s,
                sourceCodeLocation!,
                toOutputPublicFilePath(url)
              )
            }

            // 该script标签的type是否为module
            if (isModule) {
              inlineModuleIndex++ // 内联模块下标加加
              if (url && !isExcludedUrl(url)) {
                // <script type="module" src="..."/>
                // add it as an import // 作为一个导入添加它
                js += `\nimport ${JSON.stringify(url)}` // js字符串拼接import导入
                shouldRemove = true // 标记为应该删除
              } else if (node.childNodes.length) { // 是<script type="module">...</script>
                const scriptNode =
                  node.childNodes.pop() as DefaultTreeAdapterMap['textNode']
                const contents = scriptNode.value // 元素节点的内容值
                // <script type="module">...</script>
                const filePath = id.replace(normalizePath(config.root), '')
                addToHTMLProxyCache(config, filePath, inlineModuleIndex, { // 添加到html代理缓存中
                  code: contents
                })
                js += `\nimport "${id}?html-proxy&index=${inlineModuleIndex}.js"` // js字符串拼接import导入（带有query的）
                shouldRemove = true // 标记为应该删除
              }

              // 运算
              everyScriptIsAsync &&= isAsync
              someScriptsAreAsync ||= isAsync
              someScriptsAreDefer ||= !isAsync
            } else if (url && !isPublicFile) { // type不是module且src有url且url值不是publc下的文件
              if (!isExcludedUrl(url)) { // url不是已排除的，则直接进行警告
                config.logger.warn(
                  `<script src="${url}"> in "${publicPath}" can't be bundled without type="module" attribute`
                )
              }
            } else if (node.childNodes.length) { // type不是module且src没有值，而script中有内容的
              const scriptNode =
                node.childNodes.pop() as DefaultTreeAdapterMap['textNode']
              const cleanCode = stripLiteral(scriptNode.value)

              let match: RegExpExecArray | null
              while ((match = inlineImportRE.exec(cleanCode))) { // 直接拿import正则进行匹配导入语句
                const { 1: url, index } = match
                const startUrl = cleanCode.indexOf(url, index)
                const start = startUrl + 1
                const end = start + url.length - 2
                const startOffset = scriptNode.sourceCodeLocation!.startOffset
                scriptUrls.push({ // 匹配到的url整合结果推入到script url数组中来
                  start: start + startOffset,
                  end: end + startOffset,
                  url: scriptNode.value.slice(start, end)
                })
              }
            }
          }


          /**
           *  // this extends the config in @vue/compiler-sfc with <link href>
              export const assetAttrsConfig: Record<string, string[]> = {
                link: ['href'],
                video: ['src', 'poster'],
                source: ['src', 'srcset'],
                img: ['src', 'srcset'],
                image: ['xlink:href', 'href'],
                use: ['xlink:href', 'href']
              }
           */

          // 对于不是script标签元素，查看是否是资源属性配置中的 - link etc

          // For asset references in index.html, also generate an import
          // statement for each - this will be handled by the asset plugin
          const assetAttrs = assetAttrsConfig[node.nodeName]
          if (assetAttrs) { // 如果是
            for (const p of node.attrs) { // 直接遍历节点标签的属性
              if (p.value && assetAttrs.includes(p.name)) {
                const attrSourceCodeLocation =
                  node.sourceCodeLocation!.attrs![p.name]
                // assetsUrl may be encodeURI
                const url = decodeURI(p.value)
                if (!isExcludedUrl(url)) {
                  if (
                    node.nodeName === 'link' &&
                    isCSSRequest(url) &&
                    // should not be converted if following attributes are present (#6748)
                    !node.attrs.some(
                      (p) => p.name === 'media' || p.name === 'disabled'
                    )
                  ) {
                    // CSS references, convert to import
                    const importExpression = `\nimport ${JSON.stringify(url)}`
                    // 收集style url
                    styleUrls.push({
                      url,
                      start: node.sourceCodeLocation!.startOffset,
                      end: node.sourceCodeLocation!.endOffset
                    })
                    js += importExpression // link节点的url直接转为import语句拼接在js中
                  } else {
                    // 资源url中收集结果
                    assetUrls.push({
                      attr: p,
                      sourceCodeLocation: attrSourceCodeLocation
                    })
                  }
                } else if (checkPublicFile(url, config)) { // 同样检查是否是public下的文件，是则直接重写输出后的路径
                  overwriteAttrValue(
                    s,
                    attrSourceCodeLocation,
                    toOutputPublicFilePath(url)
                  )
                }
              }
            }
          }

          // <div style="background-image: url(...)">这种形式的

          // 节点标签的属性是style且值中有url()值的这种的

          // 提取内联样式作为虚拟CSS，并为标签添加类属性进行选择
          // <tag style="... url(...) ..."></tag>
          // extract inline styles as virtual css and add class attribute to tag for selecting
          const inlineStyle = node.attrs.find(
            (prop) => prop.name === 'style' && prop.value.includes('url(') // only url(...) in css need to emit file
          )
          if (inlineStyle) {
            inlineModuleIndex++ // 内联模块下标加加
            // replace `inline style` to class
            // and import css in js code
            const code = inlineStyle.value
            const filePath = id.replace(normalizePath(config.root), '')
            addToHTMLProxyCache(config, filePath, inlineModuleIndex, { code }) // 直接style属性的值增加到html代理缓存中
            // will transform with css plugin and cache result with css-post plugin
            js += `\nimport "${id}?html-proxy&inline-css&index=${inlineModuleIndex}.css"` // js拼接
            const hash = getHash(cleanUrl(id))
            // will transform in `applyHtmlTransforms`
            const sourceCodeLocation = node.sourceCodeLocation!.attrs!['style']
            overwriteAttrValue(
              s,
              sourceCodeLocation,
              `__VITE_INLINE_CSS__${hash}_${inlineModuleIndex}__` // 进行重写
            )
          }

          // style标签这种的，且标签内容有值的

          // <style>...</style>
          if (node.nodeName === 'style' && node.childNodes.length) {
            const styleNode =
              node.childNodes.pop() as DefaultTreeAdapterMap['textNode']
            const filePath = id.replace(normalizePath(config.root), '')
            inlineModuleIndex++
            addToHTMLProxyCache(config, filePath, inlineModuleIndex, { // 添加到html代理缓存中
              code: styleNode.value // 直接存入style标签中的内容
            })
            // 在css.ts中的插件中会去处理的
            js += `\nimport "${id}?html-proxy&inline-css&index=${inlineModuleIndex}.css"` // 拼接js导入
            const hash = getHash(cleanUrl(id))
            // will transform in `applyHtmlTransforms`
            // 将要在applyHtmlTransforms里面进行转换
            s.overwrite(
              styleNode.sourceCodeLocation!.startOffset,
              styleNode.sourceCodeLocation!.endOffset,
              `__VITE_INLINE_CSS__${hash}_${inlineModuleIndex}__`,
              { contentOnly: true }
            ) // 还是重写
          }

          // ***
          // 当前节点标签是否应该被移除
          // ***
          // 移除
          // ***
          if (shouldRemove) { // ***此标签是否应该被删除***
            // remove the script tag from the html. we are going to inject new
            // ones in the end.
            s.remove(
              node.sourceCodeLocation!.startOffset,
              node.sourceCodeLocation!.endOffset
            )
          }
        })

        // xxx=>false
        isAsyncScriptMap.get(config)!.set(id, everyScriptIsAsync) // 每个脚本是否都是异步的

        // 警告提示
        if (someScriptsAreAsync && someScriptsAreDefer) {
          config.logger.warn(
            `\nMixed async and defer script modules in ${id}, output script will fallback to defer. Every script, including inline ones, need to be marked as async for your output script to be async.`
          )
        }

        // for each encountered asset url, rewrite original html so that it
        // references the post-build location, ignoring empty attributes and
        // attributes that directly reference named output.
        const namedOutput = Object.keys(
          config?.build?.rollupOptions?.input || {}
        )

        // 遍历收集到的资源url数组
        for (const { attr, sourceCodeLocation } of assetUrls) {
          // assetsUrl may be encodeURI
          const content = decodeURI(attr.value) // 解码
          if (
            content !== '' && // Empty attribute
            !namedOutput.includes(content) && // Direct reference to named output
            !namedOutput.includes(content.replace(/^\//, '')) // Allow for absolute references as named output can't be an absolute path
          ) {
            try {
              const url =
                attr.name === 'srcset'
                  ? await processSrcSet(content, ({ url }) =>
                      urlToBuiltUrl(url, id, config, this)
                    )
                  : await urlToBuiltUrl(content, id, config, this)

              overwriteAttrValue(s, sourceCodeLocation, url)
            } catch (e) {
              if (e.code !== 'ENOENT') {
                throw e
              }
            }
          }
        }
        // 遍历收集到的script url数组
        // emit <script>import("./aaa")</script> asset
        for (const { start, end, url } of scriptUrls) {
          if (!isExcludedUrl(url)) { // 不是已排除中的url
            s.overwrite(
              start,
              end,
              await urlToBuiltUrl(url, id, config, this),
              { contentOnly: true }
            )
          } else if (checkPublicFile(url, config)) { // 检查是否是public下的文件
            s.overwrite(start, end, toOutputPublicFilePath(url), {
              contentOnly: true
            })
          }
        }

        // 已解析的style的url
        // ignore <link rel="stylesheet"> if its url can't be resolved
        const resolvedStyleUrls = await Promise.all(
          styleUrls.map(async (styleUrl) => ({
            ...styleUrl,
            resolved: await this.resolve(styleUrl.url, id)
          }))
        )
        // 遍历对于已解析的style的url数组
        for (const { start, end, url, resolved } of resolvedStyleUrls) {
          // 对于解析不了的进行警告在构建时间是不存在的
          if (resolved == null) {
            config.logger.warnOnce(
              `\n${url} doesn't exist at build time, it will remain unchanged to be resolved at runtime`
            )
            // 直接进行把之前处理的已拼接的js字符串进行替换为空 - 也就是直接从js字符串中移除掉
            const importExpression = `\nimport ${JSON.stringify(url)}`
            js = js.replace(importExpression, '')
          } else {
            s.remove(start, end) // 对于可以的解析的，那么直接从html字符串中移除掉
          }
        }

        // 在已处理html的map中设置已处理好后的html字符串
        processedHtml.set(id, s.toString())

        // ***
        // 只在配置和需要时注入模块预加载垫片
        // ***
        // inject module preload polyfill only when configured and needed
        const { modulePreload } = config.build
        if (
          (modulePreload === true || // 默认是true
            (typeof modulePreload === 'object' && modulePreload.polyfill)) &&
          (someScriptsAreAsync || someScriptsAreDefer) // 按照下面情况是false || true
        ) {
          js = `import "${modulePreloadPolyfillId}";\n${js}` // 直接在js字符串的最前方注入导入模块预加载垫片的id，这个是内置的模块预加载垫片
        }

        /**
         * 
         * 举例：
         * processedHtml.set(id, s.toString()) // debug
         * id => '/root/workspace/fe/vite-playground/index.html'
         * s.toString() => '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta http-equiv="X-UA-Compatible" content="IE=edge">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Document</title>\n</head>\n<body>\n  <div id="app"></div>\n  \n</body>\n</html>'
         * 
         * js => 'import "vite/modulepreload-polyfill";\n\nimport "/main.js"'
         * 
         */

        return js // ***把拼接好后的js导入字符串返回，直接交给rollup作为本次transform钩子函数所执行的结果***
      }
    },

    // rollup的生成bundle钩子函数
    async generateBundle(options, bundle) {
      const analyzedChunk: Map<OutputChunk, number> = new Map()
      const getImportedChunks = (
        chunk: OutputChunk,
        seen: Set<string> = new Set()
      ): OutputChunk[] => {
        const chunks: OutputChunk[] = []
        chunk.imports.forEach((file) => {
          const importee = bundle[file]
          if (importee?.type === 'chunk' && !seen.has(file)) {
            seen.add(file)

            // post-order traversal
            chunks.push(...getImportedChunks(importee, seen))
            chunks.push(importee)
          }
        })
        return chunks
      }

      const toScriptTag = (
        chunk: OutputChunk,
        toOutputPath: (filename: string) => string,
        isAsync: boolean
      ): HtmlTagDescriptor => ({
        tag: 'script',
        attrs: {
          ...(isAsync ? { async: true } : {}),
          type: 'module',
          crossorigin: true,
          src: toOutputPath(chunk.fileName)
        }
      })

      const toPreloadTag = (
        filename: string,
        toOutputPath: (filename: string) => string
      ): HtmlTagDescriptor => ({
        tag: 'link',
        attrs: {
          rel: 'modulepreload',
          crossorigin: true,
          href: toOutputPath(filename)
        }
      })

      const getCssTagsForChunk = (
        chunk: OutputChunk,
        toOutputPath: (filename: string) => string,
        seen: Set<string> = new Set()
      ): HtmlTagDescriptor[] => {
        const tags: HtmlTagDescriptor[] = []
        if (!analyzedChunk.has(chunk)) {
          analyzedChunk.set(chunk, 1)
          chunk.imports.forEach((file) => {
            const importee = bundle[file]
            if (importee?.type === 'chunk') {
              tags.push(...getCssTagsForChunk(importee, toOutputPath, seen))
            }
          })
        }

        chunk.viteMetadata.importedCss.forEach((file) => {
          if (!seen.has(file)) {
            seen.add(file)
            tags.push({
              tag: 'link',
              attrs: {
                rel: 'stylesheet',
                href: toOutputPath(file)
              }
            })
          }
        })

        return tags
      }

      // 直接遍历在transform钩子函数中所缓存的已处理html字符串
      for (const [id, html] of processedHtml) {
        const relativeUrlPath = path.posix.relative(
          config.root,
          normalizePath(id)
        )
        const assetsBase = getBaseInHTML(relativeUrlPath, config)
        const toOutputFilePath = (
          filename: string,
          type: 'asset' | 'public'
        ) => {
          if (isExternalUrl(filename)) {
            return filename
          } else {
            return toOutputFilePathInHtml(
              filename,
              type,
              relativeUrlPath,
              'html',
              config,
              (filename: string, importer: string) => assetsBase + filename
            )
          }
        }

        // 准备各类资源路径

        const toOutputAssetFilePath = (filename: string) =>
          toOutputFilePath(filename, 'asset')

        const toOutputPublicAssetFilePath = (filename: string) =>
          toOutputFilePath(filename, 'public')

        const isAsync = isAsyncScriptMap.get(config)!.get(id)!

        let result = html

        // 查找对应的入口chunk
        // find corresponding entry chunk
        const chunk = Object.values(bundle).find(
          (chunk) =>
            chunk.type === 'chunk' &&
            chunk.isEntry && // 哪个chunk是入口
            chunk.facadeModuleId === id // 且它的id是已处理html字符串的存入的id
        ) as OutputChunk | undefined

        let canInlineEntry = false // 是否可以内联入口

        // 注入chunk资源link
        // inject chunk asset links
        if (chunk) {
          // an entry chunk can be inlined if
          //  - it's an ES module (e.g. not generated by the legacy plugin)
          //  - it contains no meaningful code other than import statements
          if (options.format === 'es' && isEntirelyImport(chunk.code)) { // 它把此chunk代码中的import语句以及注释替换为空然后.length做了个取反操作 - 正常情况下为false
            // isEntirelyImport意为是否为完全的导入
            canInlineEntry = true
          }

          // when not inlined, inject <script> for entry and modulepreload its dependencies
          // when inlined, discard entry chunk and inject <script> for everything in post-order
          const imports = getImportedChunks(chunk) // 获取此入口chunk中的导入
          let assetTags: HtmlTagDescriptor[]
          if (canInlineEntry) { // 可以内联入口
            assetTags = imports.map((chunk) =>
              toScriptTag(chunk, toOutputAssetFilePath, isAsync) // 转成type是module的外部script标签
            ) // 把chunk中的导入转为script标签
          } else {
            const { modulePreload } = config.build
            const resolveDependencies =
              typeof modulePreload === 'object' &&
              modulePreload.resolveDependencies
            const importsFileNames = imports.map((chunk) => chunk.fileName) // chunk中存在的导入
            const resolvedDeps = resolveDependencies
              ? resolveDependencies(chunk.fileName, importsFileNames, {
                  hostId: relativeUrlPath,
                  hostType: 'html'
                })
              : importsFileNames
            assetTags = [
              toScriptTag(chunk, toOutputAssetFilePath, isAsync), // 转成type是module的外部script标签，src的值就是chunk的filename所处理后的url
              ...resolvedDeps.map((i) => toPreloadTag(i, toOutputAssetFilePath)) // 转成link标签带有模块预加载的rel
            ]
          }
          // 转为css link标签收集到资源标签数组中
          assetTags.push(...getCssTagsForChunk(chunk, toOutputAssetFilePath))

          // 把转换后的标签信息（包含chunk路径url在标签信息中）统一注入到结果字符串中去
          result = injectToHead(result, assetTags)
        }

        // ***默认是分割的***

        // 就是css代码不分割的话，那么就把这个chunk转为link标签形式注入到html中
        // 当配置中的css代码分割是false时则注入css link标签
        // inject css link when cssCodeSplit is false
        if (!config.build.cssCodeSplit) {
          const cssChunk = Object.values(bundle).find(
            (chunk) => chunk.type === 'asset' && chunk.name === 'style.css' // 这个在cssPostPlugin中的generateBundle钩子函数中做的
          ) as OutputAsset | undefined
          if (cssChunk) {
            result = injectToHead(result, [ // 也是把link style标签注入到head标签里面去
              {
                tag: 'link',
                attrs: {
                  rel: 'stylesheet',
                  href: toOutputAssetFilePath(cssChunk.fileName)
                }
              }
            ])
          }
        }

        // html字符串中出现<div style="background-image: url(...)">这种形式的
        // 和<style>...</style>这种的

        // no use assets plugin because it will emit file
        let match: RegExpExecArray | null
        let s: MagicString | undefined
        while ((match = inlineCSSRE.exec(result))) { // 对结果字符串进行匹配内联css正则
          // const inlineCSSRE = /__VITE_INLINE_CSS__([a-z\d]{8}_\d+)__/g
          s ||= new MagicString(result)
          const { 0: full, 1: scopedName } = match
          const cssTransformedCode = htmlProxyResult.get(scopedName)! // 之前缓存中获取结果
          // 这个结果是在css.ts中的插件中经过编译后的css代码啦~
          s.overwrite(
            match.index,
            match.index + full.length,
            cssTransformedCode, // 重写经过编译后的css代码啦 ~
            { contentOnly: true }
          )
        }
        if (s) {
          result = s.toString()
        }
        // 应用对于html字符串的**后置**转换钩子函数
        result = await applyHtmlTransforms(result, postHooks, {
          path: '/' + relativeUrlPath,
          filename: id,
          bundle,
          chunk
        })
        // 替换资源url
        // resolve asset url references
        result = result.replace(assetUrlRE, (_, fileHash, postfix = '') => {
          return (
            toOutputAssetFilePath(getAssetFilename(fileHash, config)!) + postfix
          )
        })

        // 替换public资源url正则
        result = result.replace(publicAssetUrlRE, (_, fileHash) => {
          return normalizePath(
            toOutputPublicAssetFilePath(
              getPublicAssetFilename(fileHash, config)!
            )
          )
        })

        /**
         * 
         * 举例：
         * index.html
         * <script type="module" src="/main.js"><script>
         * foo.js
         * export default 'foo'
         * 
         * main.js
         * import foo from './foo'
         * import './style.css' // 主要是css.ts中做的事情（大致为利用treeshaking机制导致最终chunk中没有此代码，另外利用renderChunk钩子在其中向bundle对象中发射文件用于生成css文件）
         * console.log(foo)
         * 
         * 那么js就是入口chunk所以它会生成写入文件系统中
         * html文件的生成就在下方，以及里面引入打包后的结果逻辑就在上方...
         * 
         * 最终生成的文件
         * index.html
         * // 注意type="module"时默认就是defer的
         * <head><script type="module" crossorigin src="/index.[hash].js"><script><link rel="stylesheet" href="/index.[hash].css"></link></head>
         * 
         * index.[hash].js
         * ...modulePreload垫片...console.log('foo')
         * 
         * index.[hash].css
         * ...
         * 
         */

        // 默认情况下为true && false
        // 有入口chunk且可以内联入口（意思就是直接把入口chunk中的导入全部直接放在script标签中了，这样一来入口chunK中没有内容了，那么就可以把其删除掉了）
        // 但是正常情况下还是有内容的，所以入口chunk是不可以进行内联的
        if (chunk && canInlineEntry) {
          // ***所有从入口的导入都内联到了html字符串中啦，删除掉它以防止rollup将其输出***
          // all imports from entry have been inlined to html, prevent rollup from outputting it
          // ***
          delete bundle[chunk.fileName] // ***在最终传入的bundle中把入口chunk给删除掉***
          // 去掉入口chunk
          // ***

          // ***
          // 注意是有入口chunk且可以内联入口时才进行此操作的
          // ***

          // 因为上方把也就是transform钩子函数中所拼接的入口的导入字符串都一一转换成了html中标签形式
          // 所以说这里最终的chunk中就不需要这个拼接产生的chunk了，直接给其删除掉就可以啦~
          // 因为它里面最终产出的bundle后的结果中的import的url都提取出来了，所以也就不需要了，直接删除
          // ***这样rollup就不会把该入口chunk也给生成出来了***
        }

        const shortEmitName = normalizePath(path.relative(config.root, id))
        // ***
        // ***
        // 这个函数主要就是向bundle对象中存入要写入的文件对应的信息的
        // 在最终生成的文件中会出现一个.html文件的，内容就是这里的result
        // ***
        this.emitFile({
          type: 'asset',
          fileName: shortEmitName,
          source: result
        })
      }
    }
  }
}

export interface HtmlTagDescriptor {
  tag: string
  attrs?: Record<string, string | boolean | undefined>
  children?: string | HtmlTagDescriptor[]
  /**
   * default: 'head-prepend'
   */
  injectTo?: 'head' | 'body' | 'head-prepend' | 'body-prepend'
}

export type IndexHtmlTransformResult =
  | string
  | HtmlTagDescriptor[]
  | {
      html: string
      tags: HtmlTagDescriptor[]
    }

export interface IndexHtmlTransformContext {
  /**
   * public path when served
   */
  path: string
  /**
   * filename on disk
   */
  filename: string
  server?: ViteDevServer
  bundle?: OutputBundle
  chunk?: OutputChunk
  originalUrl?: string
}

export type IndexHtmlTransformHook = (
  this: void,
  html: string,
  ctx: IndexHtmlTransformContext
) => IndexHtmlTransformResult | void | Promise<IndexHtmlTransformResult | void>

export type IndexHtmlTransform =
  | IndexHtmlTransformHook
  | {
      enforce?: 'pre' | 'post'
      transform: IndexHtmlTransformHook
    }

export function preImportMapHook(
  config: ResolvedConfig
): IndexHtmlTransformHook {
  return (html, ctx) => {
    const importMapIndex = html.match(importMapRE)?.index
    if (importMapIndex === undefined) return

    const moduleScriptIndex = html.match(moduleScriptRE)?.index
    if (moduleScriptIndex === undefined) return

    if (moduleScriptIndex < importMapIndex) {
      const relativeHtml = normalizePath(
        path.relative(config.root, ctx.filename)
      )
      config.logger.warnOnce(
        colors.yellow(
          colors.bold(
            `(!) <script type="importmap"> should come before <script type="module"> in /${relativeHtml}`
          )
        )
      )
    }
  }
}

/**
 * Move importmap before the first module script
 */
export function postImportMapHook(): IndexHtmlTransformHook {
  return (html) => {
    if (!moduleScriptRE.test(html)) return

    let importMap: string | undefined
    html = html.replace(importMapRE, (match) => {
      importMap = match
      return ''
    })
    if (importMap) {
      html = html.replace(moduleScriptRE, (match) => `${importMap}\n${match}`)
    }

    return html
  }
}

export function resolveHtmlTransforms(
  plugins: readonly Plugin[]
): [IndexHtmlTransformHook[], IndexHtmlTransformHook[]] {
  const preHooks: IndexHtmlTransformHook[] = []
  const postHooks: IndexHtmlTransformHook[] = []

  for (const plugin of plugins) {
    const hook = plugin.transformIndexHtml
    if (hook) {
      if (typeof hook === 'function') {
        postHooks.push(hook)
      } else if (hook.enforce === 'pre') {
        preHooks.push(hook.transform)
      } else {
        postHooks.push(hook.transform)
      }
    }
  }

  return [preHooks, postHooks]
}

export async function applyHtmlTransforms(
  html: string,
  hooks: IndexHtmlTransformHook[],
  ctx: IndexHtmlTransformContext
): Promise<string> {
  for (const hook of hooks) {
    const res = await hook(html, ctx)
    if (!res) {
      continue
    }
    if (typeof res === 'string') {
      html = res
    } else {
      let tags: HtmlTagDescriptor[]
      if (Array.isArray(res)) {
        tags = res
      } else {
        html = res.html || html
        tags = res.tags
      }

      const headTags: HtmlTagDescriptor[] = []
      const headPrependTags: HtmlTagDescriptor[] = []
      const bodyTags: HtmlTagDescriptor[] = []
      const bodyPrependTags: HtmlTagDescriptor[] = []

      for (const tag of tags) {
        if (tag.injectTo === 'body') {
          bodyTags.push(tag)
        } else if (tag.injectTo === 'body-prepend') {
          bodyPrependTags.push(tag)
        } else if (tag.injectTo === 'head') {
          headTags.push(tag)
        } else {
          headPrependTags.push(tag)
        }
      }

      html = injectToHead(html, headPrependTags, true)
      html = injectToHead(html, headTags)
      html = injectToBody(html, bodyPrependTags, true)
      html = injectToBody(html, bodyTags)
    }
  }

  return html
}

const importRE = /\bimport\s*("[^"]*[^\\]"|'[^']*[^\\]');*/g
const commentRE = /\/\*[\s\S]*?\*\/|\/\/.*$/gm
function isEntirelyImport(code: string) {
  // only consider "side-effect" imports, which match <script type=module> semantics exactly
  // the regexes will remove too little in some exotic cases, but false-negatives are alright
  return !code.replace(importRE, '').replace(commentRE, '').trim().length
}

function getBaseInHTML(urlRelativePath: string, config: ResolvedConfig) {
  // Prefer explicit URL if defined for linking to assets and public files from HTML,
  // even when base relative is specified
  return config.base === './' || config.base === ''
    ? path.posix.join(
        path.posix.relative(urlRelativePath, '').slice(0, -2),
        './'
      )
    : config.base
}

const headInjectRE = /([ \t]*)<\/head>/i
const headPrependInjectRE = /([ \t]*)<head[^>]*>/i

const htmlInjectRE = /<\/html>/i
const htmlPrependInjectRE = /([ \t]*)<html[^>]*>/i

const bodyInjectRE = /([ \t]*)<\/body>/i
const bodyPrependInjectRE = /([ \t]*)<body[^>]*>/i

const doctypePrependInjectRE = /<!doctype html>/i

function injectToHead(
  html: string,
  tags: HtmlTagDescriptor[],
  prepend = false
) {
  if (tags.length === 0) return html

  if (prepend) {
    // inject as the first element of head
    if (headPrependInjectRE.test(html)) {
      return html.replace(
        headPrependInjectRE,
        (match, p1) => `${match}\n${serializeTags(tags, incrementIndent(p1))}`
      )
    }
  } else {
    // inject before head close
    if (headInjectRE.test(html)) {
      // respect indentation of head tag
      return html.replace(
        headInjectRE,
        (match, p1) => `${serializeTags(tags, incrementIndent(p1))}${match}`
      )
    }
    // try to inject before the body tag
    if (bodyPrependInjectRE.test(html)) {
      return html.replace(
        bodyPrependInjectRE,
        (match, p1) => `${serializeTags(tags, p1)}\n${match}`
      )
    }
  }
  // if no head tag is present, we prepend the tag for both prepend and append
  return prependInjectFallback(html, tags)
}

function injectToBody(
  html: string,
  tags: HtmlTagDescriptor[],
  prepend = false
) {
  if (tags.length === 0) return html

  if (prepend) {
    // inject after body open
    if (bodyPrependInjectRE.test(html)) {
      return html.replace(
        bodyPrependInjectRE,
        (match, p1) => `${match}\n${serializeTags(tags, incrementIndent(p1))}`
      )
    }
    // if no there is no body tag, inject after head or fallback to prepend in html
    if (headInjectRE.test(html)) {
      return html.replace(
        headInjectRE,
        (match, p1) => `${match}\n${serializeTags(tags, p1)}`
      )
    }
    return prependInjectFallback(html, tags)
  } else {
    // inject before body close
    if (bodyInjectRE.test(html)) {
      return html.replace(
        bodyInjectRE,
        (match, p1) => `${serializeTags(tags, incrementIndent(p1))}${match}`
      )
    }
    // if no body tag is present, append to the html tag, or at the end of the file
    if (htmlInjectRE.test(html)) {
      return html.replace(htmlInjectRE, `${serializeTags(tags)}\n$&`)
    }
    return html + `\n` + serializeTags(tags)
  }
}

function prependInjectFallback(html: string, tags: HtmlTagDescriptor[]) {
  // prepend to the html tag, append after doctype, or the document start
  if (htmlPrependInjectRE.test(html)) {
    return html.replace(htmlPrependInjectRE, `$&\n${serializeTags(tags)}`)
  }
  if (doctypePrependInjectRE.test(html)) {
    return html.replace(doctypePrependInjectRE, `$&\n${serializeTags(tags)}`)
  }
  return serializeTags(tags) + html
}

const unaryTags = new Set(['link', 'meta', 'base'])

function serializeTag(
  { tag, attrs, children }: HtmlTagDescriptor,
  indent: string = ''
): string {
  if (unaryTags.has(tag)) {
    return `<${tag}${serializeAttrs(attrs)}>`
  } else {
    return `<${tag}${serializeAttrs(attrs)}>${serializeTags(
      children,
      incrementIndent(indent)
    )}</${tag}>`
  }
}

function serializeTags(
  tags: HtmlTagDescriptor['children'],
  indent: string = ''
): string {
  if (typeof tags === 'string') {
    return tags
  } else if (tags && tags.length) {
    return tags.map((tag) => `${indent}${serializeTag(tag, indent)}\n`).join('')
  }
  return ''
}

function serializeAttrs(attrs: HtmlTagDescriptor['attrs']): string {
  let res = ''
  for (const key in attrs) {
    if (typeof attrs[key] === 'boolean') {
      res += attrs[key] ? ` ${key}` : ``
    } else {
      res += ` ${key}=${JSON.stringify(attrs[key])}`
    }
  }
  return res
}

function incrementIndent(indent: string = '') {
  return `${indent}${indent[0] === '\t' ? '\t' : '  '}`
}
