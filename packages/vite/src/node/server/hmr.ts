import fs from 'node:fs'
import path from 'node:path'
import type { Server } from 'node:http'
import colors from 'picocolors'
import type { Update } from 'types/hmrPayload'
import type { RollupError } from 'rollup'
import { CLIENT_DIR } from '../constants'
import { createDebugger, normalizePath, unique } from '../utils'
import type { ViteDevServer } from '..'
import { isCSSRequest } from '../plugins/css'
import { getAffectedGlobModules } from '../plugins/importMetaGlob'
import { isExplicitImportRequired } from '../plugins/importAnalysis'
import type { ModuleNode } from './moduleGraph'

export const debugHmr = createDebugger('vite:hmr')

const normalizedClientDir = normalizePath(CLIENT_DIR)

export interface HmrOptions {
  protocol?: string
  host?: string
  port?: number
  clientPort?: number
  path?: string
  timeout?: number
  overlay?: boolean
  server?: Server
}

export interface HmrContext {
  file: string
  timestamp: number
  modules: Array<ModuleNode>
  read: () => string | Promise<string>
  server: ViteDevServer
}

export function getShortName(file: string, root: string): string {
  return file.startsWith(root + '/') ? path.posix.relative(root, file) : file
}

// 处理热模替换更新
export async function handleHMRUpdate(
  file: string,
  server: ViteDevServer
): Promise<void> {
  const { ws, config, moduleGraph } = server
  // ***
  // 获取的文件路径相对于root根的相对路径
  // ***
  const shortFile = getShortName(file, config.root) // ****
  const fileName = path.basename(file) // 获取文件名

  const isConfig = file === config.configFile // 是否为配置文件
  const isConfigDependency = config.configFileDependencies.some(
    (name) => file === name // 是否为配置文件的依赖文件
  )
  const isEnv =
    config.inlineConfig.envFile !== false &&
    (fileName === '.env' || fileName.startsWith('.env.')) // 是否为.env文件
  if (isConfig || isConfigDependency || isEnv) {
    // 自动重启服务器
    // auto restart server
    debugHmr(`[config change] ${colors.dim(shortFile)}`)
    config.logger.info(
      colors.green(
        `${path.relative(process.cwd(), file)} changed, restarting server...`
      ),
      { clear: true, timestamp: true }
    )
    try {
      await server.restart() // 直接重启服务器
    } catch (e) {
      config.logger.error(colors.red(e))
    }
    return
  }

  debugHmr(`[file change] ${colors.dim(shortFile)}`)

  // (dev only) the client itself cannot be hot updated.
  if (file.startsWith(normalizedClientDir)) { // 文件是客户端目录开头的则直接进行浏览器的全重新加载
    ws.send({
      type: 'full-reload',
      path: '*'
    })
    return
  }

  const mods = moduleGraph.getModulesByFile(file)
  // 查找出文件可能对应具有不同query的多个模块
  // 比如vue中就是把一个文件模块分为不同query的多个模块（比如在vue3中一个.vue文件分为xxx.vue mod（实际上被编译为了esm的JS文件内容） xxx.vue?type=css mod）

  // 检查是否有任何插件想要执行自定义 HMR 处理
  // check if any plugin wants to perform custom HMR handling
  const timestamp = Date.now()
  const hmrContext: HmrContext = {
    file,
    timestamp,
    modules: mods ? [...mods] : [],
    read: () => readModifiedFile(file), // 读取修改的文件内容
    server
  }

  // 获取插件中的handleHotUpdate钩子函数 - 一一让它们执行（注：它们都会执行一遍，中间没有跳过逻辑）
  for (const hook of config.getSortedPluginHooks('handleHotUpdate')) {
    const filteredModules = await hook(hmrContext) // 把上下文传入进去执行钩子函数，会返回过滤后的模块
    if (filteredModules) {
      hmrContext.modules = filteredModules // 有的话就直接替换
    }
  }

  // 最终的moduels中是否需要更新的模块
  if (!hmrContext.modules.length) {
    // 没有的话 - 猜测可能是html文件发生变化
    // html文件不能热更新
    // html file cannot be hot updated
    if (file.endsWith('.html')) {
      config.logger.info(colors.green(`page reload `) + colors.dim(shortFile), {
        clear: true,
        timestamp: true
      })
      // 直接做全重新加载
      ws.send({
        type: 'full-reload',
        path: config.server.middlewareMode
          ? '*'
          : '/' + normalizePath(path.relative(config.root, file))
      })
    } else {
      // loaded but not in the module graph, probably not js
      debugHmr(`[no modules matched] ${colors.dim(shortFile)}`)
    }
    // 不是html且没有需要更新的模块直接返回
    return
  }

  // 开始更新模块
  // **拿的是这个相对路径**
  updateModules(shortFile, hmrContext.modules, timestamp, server)
}

export function updateModules(
  file: string, // 相对路径
  modules: ModuleNode[],
  timestamp: number,
  { config, ws }: ViteDevServer
): void {
  const updates: Update[] = []
  const invalidatedModules = new Set<ModuleNode>() // 无效的模块集合
  let needFullReload = false // 默认不需要全重新加载

  // 遍历需要更新的模块 一一进行分析判断最终的决定
  for (const mod of modules) {
    // 让此模块的转换结果置为空 - 同时遍历此模块的incoming
    //   如果这个incoming模块中没有accept当前模块，那么就让这个incoming模块也无效
    invalidate(mod, timestamp, invalidatedModules)
    if (needFullReload) { // 需要全重新加载那么跳过当前模块
      continue
    }

    // 边界的集合
    const boundaries = new Set<{
      boundary: ModuleNode
      acceptedVia: ModuleNode
    }>()
    const hasDeadEnd = propagateUpdate(mod, boundaries) // 传播更新

    // 是否有死路
    if (hasDeadEnd) {
      // 出现死路了那么就直接进行全重新加载
      needFullReload = true
      continue
    }

    // ***
    // Via -> 通过
    // ***

    /**
     * css.ts
     * 
     * const cssLangs = `\\.(css|less|sass|scss|styl|stylus|pcss|postcss)($|\\?)`
     * const cssLangRE = new RegExp(cssLangs)
     * export const isCSSRequest = (request: string): boolean =>
     *   cssLangRE.test(request)
     * 
     * utils.ts
     * 
     * const knownJsSrcRE = /\.((j|t)sx?|m[jt]s|vue|marko|svelte|astro)($|\?)/
     * export const isJSRequest = (url: string): boolean => {
     *   url = cleanUrl(url)
     *   if (knownJsSrcRE.test(url)) {
     *     return true
     *   }
     *   if (!path.extname(url) && !url.endsWith('/')) {
     *     return true
     *   }
     *   return false
     * }
     * 
     */

    // 整合需要更新的信息
    updates.push(
      ...[...boundaries].map(({ boundary, acceptedVia }) => ({ // 边界模块, accepted通过模块（被accept模块）
        // ***
        // moduleGraph.ts中的ModuleNode类的构造函数中的代码
        /**
         * const cssLangs = `\\.(css|less|sass|scss|styl|stylus|pcss|postcss)($|\\?)`
         * const cssLangRE = new RegExp(cssLangs)
         * const directRequestRE = /(\?|&)direct\b/
         * 
         * export const isDirectCSSRequest = (request: string): boolean =>
         *   cssLangRE.test(request) && directRequestRE.test(request)
         * 
         */
        // this.type = isDirectCSSRequest(url) ? 'css' : 'js' // 模块节点的类型
        // ***
        // 在transform.ts中有说明的
        // url必须是css语言请求 且 请求是要带?direct的才能是css请求，也就是说只有link的请求url的才能是css类型
        // 其它的一律为js类型
        // ***
        // ***
        type: `${boundary.type}-update` as const, // js or css
        timestamp,
        path: boundary.url, // 边界模块的url
        explicitImportRequired: // 明确的导入校验
          boundary.type === 'js' // 边界模块类型要求是js
            ? isExplicitImportRequired(acceptedVia.url) // return !isJSRequest(cleanUrl(url)) && !isCSSRequest(url)
            : undefined,
        acceptedPath: acceptedVia.url // 被accept模块的url
      }))
    )
  }

  // 需要全重新加载那么就直接告诉
  if (needFullReload) {
    // ***
    // 这个能够实现 xxx x100的效果
    // ***
    config.logger.info(colors.green(`page reload `) + colors.dim(file), {
      clear: true,
      timestamp: true
    })
    ws.send({
      type: 'full-reload'
    })
    return
  }

  // 没有要更新的信息且不需要进行全重新加载那么就直接return - 不更新啦
  if (updates.length === 0) {
    debugHmr(colors.yellow(`no update happened `) + colors.dim(file))
    return
  }

  // ***
  // 这个能够实现 xxx x100的效果
  // ***
  config.logger.info(
    updates
      .map(({ path }) => colors.green(`hmr update `) + colors.dim(path))
      .join('\n'),
    { clear: true, timestamp: true }
  )
  // 告诉客户端需要更新的信息
  ws.send({
    type: 'update',
    updates
  })
}

export async function handleFileAddUnlink(
  file: string,
  server: ViteDevServer
): Promise<void> {
  const modules = [...(server.moduleGraph.getModulesByFile(file) || [])] // 也是通过文件路径获取该文件模块所分为的不同的query的模块

  // 到server._importGlobMap获取和file匹配的modules
  modules.push(...getAffectedGlobModules(file, server))

  // 如果有模块则进行更新模块
  if (modules.length > 0) {
    updateModules(
      getShortName(file, server.config.root),
      unique(modules), // 去重 - Array.from(new Set(arr))
      Date.now(),
      server
    )
  }
}

// importedBindings中的每一项是否都在acceptedExports有 - && - every
function areAllImportsAccepted(
  importedBindings: Set<string>,
  acceptedExports: Set<string>
) {
  for (const binding of importedBindings) {
    if (!acceptedExports.has(binding)) {
      return false
    }
  }
  return true
}

// 传播更新
function propagateUpdate(
  node: ModuleNode,
  boundaries: Set<{
    boundary: ModuleNode
    acceptedVia: ModuleNode
  }>,
  currentChain: ModuleNode[] = [node] // 包含当前模块的当前链
): boolean /* hasDeadEnd */ {
  // #7561
  // if the imports of `node` have not been analyzed, then `node` has not
  // been loaded in the browser and we should stop propagation.
  // 如果没有分析模块的导入，那么模块就没有加载到浏览器中，我们应该停止传播。
  if (node.id && node.isSelfAccepting === undefined) {
    debugHmr(
      `[propagate update] stop propagation because not analyzed: ${colors.dim(
        node.id
      )}`
    )
    return false
  }

  // 查看当前模块是否自身accept
  if (node.isSelfAccepting) { // link发出的css请求会走到这里的
    // 有则直接加入到边界中
    boundaries.add({
      boundary: node,
      acceptedVia: node
    })

    // 另外还要检查CSS importers，因为像Tailwind JIT这样的PostCSS插件可以将任何文件注册为CSS文件的依赖项。
    // additionally check for CSS importers, since a PostCSS plugin like
    // Tailwind JIT may register any file as a dependency to a CSS file.
    for (const importer of node.importers) { // 遍历模块的incoming 模块
      // 当前incoming 模块是css请求且不在当前链中
      if (isCSSRequest(importer.url) && !currentChain.includes(importer)) {
        // 那么就继续向上（importer）传播更新
        propagateUpdate(importer, boundaries, currentChain.concat(importer))
      }
    }

    // 告诉外界没有出现死路
    return false
  }

  // 一个没有importers的部分accepted module被认为是自我接受的，因为交易是“如果我的某些部分在我之外使用，我就不能自我接受”。
  // 此外，导入的模块（这个）必须在importers之前更新，以便它们在重新加载时获得新的导入模块。
  // A partially accepted module with no importers is considered self accepting,
  // because the deal is "there are parts of myself I can't self accept if they
  // are used outside of me".
  // Also, the imported module (this one) must be updated before the importers,
  // so that they do get the fresh imported module when/if they are reloaded.
  if (node.acceptedHmrExports) { // 当前模块有acceptedHmrExports
    // 则直接加入边界
    boundaries.add({
      boundary: node,
      acceptedVia: node
    })
  } else {
    // 没有acceptedHmrExports且没有incoming modules
    if (!node.importers.size) {
      // 告诉外界遇到死路了
      return true
    }

    // 对于一个非CSS文件，如果它的所有importers都是CSS文件（通过PostCSS插件注册），它应该被认为是一个死胡同，并强制完全重新加载。
    // #3716, #3913
    // For a non-CSS file, if all of its importers are CSS files (registered via
    // PostCSS plugins) it should be considered a dead end and force full reload.
    if (
      !isCSSRequest(node.url) && // 不是css请求
      [...node.importers].every((i) => isCSSRequest(i.url)) // 且它的incoming modules都是css请求
    ) {
      // 遇到死胡同啦
      return true
    }
  }

  // 遍历当前模块的incoming connection modules
  for (const importer of node.importers) {
    // 形成子链
    const subChain = currentChain.concat(importer)
    // 当前incoming module中的acceptedHmrDeps是否有当前模块
    if (importer.acceptedHmrDeps.has(node)) {
      // 直接边界中加入且跳出当前循环
      boundaries.add({
        boundary: importer,
        acceptedVia: node
      })
      continue
    }

    // 当前模块有id 且 当前模块有acceptedHmrExports 且 当前incoming module有importedBindings
    if (node.id && node.acceptedHmrExports && importer.importedBindings) {
      // 通过当前模块的id在incoming module的importedBindings中获取
      const importedBindingsFromNode = importer.importedBindings.get(node.id)
      if (
        importedBindingsFromNode && // 存在
        areAllImportsAccepted(importedBindingsFromNode, node.acceptedHmrExports) // 且importedBindingsFromNode中的每一项是否都在当前模块的acceptedHmrExports中有
      ) {
        continue
      }
    }

    // 当前链中是否有当前incoming module
    if (currentChain.includes(importer)) {
      // 循环依赖直接被认为是遇到死胡同啦
      // circular deps is considered dead end
      return true
    }

    // 那么就继续向上（importer）传播更新
    if (propagateUpdate(importer, boundaries, subChain)) {
      return true
    }
  }
  // 没有遇到死胡同啦
  return false
}

function invalidate(mod: ModuleNode, timestamp: number, seen: Set<ModuleNode>) {
  if (seen.has(mod)) {
    return
  }
  seen.add(mod)
  mod.lastHMRTimestamp = timestamp
  mod.transformResult = null // 直接把转换结果置为空
  mod.ssrModule = null
  mod.ssrError = null
  mod.ssrTransformResult = null
  // 遍历此模块的incoming
  mod.importers.forEach((importer) => {
    // 如果这个incoming模块中没有accept当前模块，那么就让这个incoming模块也无效
    if (!importer.acceptedHmrDeps.has(mod)) {
      invalidate(importer, timestamp, seen)
    }
  })
}

// 处理删除模块
export function handlePrunedModules(
  mods: Set<ModuleNode>,
  { ws }: ViteDevServer
): void {
  // ***
  // 更新已处理模块的HMR时间戳，因为如果它被重新导入，它应该会重新应用副作用，没有时间戳浏览器将不会重新导入它!
  // ***
  // update the disposed modules' hmr timestamp
  // since if it's re-imported, it should re-apply side effects
  // and without the timestamp the browser will not re-import it!
  const t = Date.now()
  mods.forEach((mod) => {
    mod.lastHMRTimestamp = t // 修改模块的上次HMR时间戳
    debugHmr(`[dispose] ${colors.dim(mod.file)}`)
  })
  ws.send({
    type: 'prune', // 删除
    paths: [...mods].map((m) => m.url) // 整合模块的url
  })
}

const enum LexerState {
  inCall,
  inSingleQuoteString,
  inDoubleQuoteString,
  inTemplateString,
  inArray
}

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


// 自接受模块的话不会提取
// 下面方法可以把所要接受的模块提取出来添加到urls这个集合中，其中每一项的url属性就是accept方法的参数中所要接受的
/**
 * 词法import.meta.hot.accept()用于已接受的deps。
 * 因为hot.accept()只能接受字符串字面值或字符串字面值的数组，所以我们实际上不需要对整个源代码进行繁重的@babel/parse的调用。
 * Lex import.meta.hot.accept() for accepted deps.
 * Since hot.accept() can only accept string literals or array of string
 * literals, we don't really need a heavy @babel/parse call on the entire source.
 *
 * @returns selfAccepts
 */
export function lexAcceptedHmrDeps(
  code: string,
  start: number, // indexOf ( + 1
  urls: Set<{ url: string; start: number; end: number }>
): boolean {
  let state: LexerState = LexerState.inCall
  // 状态只能是 2 级深，因此不需要堆栈
  // the state can only be 2 levels deep so no need for a stack
  let prevState: LexerState = LexerState.inCall
  let currentDep: string = ''

  function addDep(index: number) {
    urls.add({ // 缓存
      url: currentDep,
      start: index - currentDep.length - 1,
      end: index + 1
    })
    currentDep = '' // 把当前依赖清空
  }

  for (let i = start; i < code.length; i++) {
    const char = code.charAt(i)
    switch (state) {
      case LexerState.inCall:
      case LexerState.inArray:
        if (char === `'`) {
          prevState = state
          state = LexerState.inSingleQuoteString
        } else if (char === `"`) {
          prevState = state
          state = LexerState.inDoubleQuoteString
        } else if (char === '`') {
          prevState = state
          state = LexerState.inTemplateString
        } else if (/\s/.test(char)) { // \s -> 匹配空格（包括换行符、制表符、空格符等），相等于[ \t\r\n\v\f]。
          continue
        } else {
          if (state === LexerState.inCall) {
            if (char === `[`) {
              state = LexerState.inArray
            } else {
              // reaching here means the first arg is neither a string literal
              // nor an Array literal (direct callback) or there is no arg
              // in both case this indicates a self-accepting module
              // 到达这里意味着第一个参数既不是字符串字面量也不是数组字面量（直接回调），或者在这两种情况下都没有参数，这表示自接受模块
              return true // done
            }
          } else if (state === LexerState.inArray) {
            if (char === `]`) {
              return false // done
            } else if (char === ',') {
              continue
            } else {
              error(i)
            }
          }
        }
        break
      case LexerState.inSingleQuoteString:
        if (char === `'`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      case LexerState.inDoubleQuoteString:
        if (char === `"`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      case LexerState.inTemplateString:
        if (char === '`') {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else if (char === '$' && code.charAt(i + 1) === '{') {
          error(i)
        } else {
          currentDep += char
        }
        break
      default:
        throw new Error('unknown import.meta.hot lexer state')
    }
  }
  return false
}

export function lexAcceptedHmrExports(
  code: string,
  start: number,
  exportNames: Set<string>
): boolean {
  const urls = new Set<{ url: string; start: number; end: number }>()
  lexAcceptedHmrDeps(code, start, urls)
  for (const { url } of urls) {
    exportNames.add(url)
  }
  return urls.size > 0
}

function error(pos: number) {
  const err = new Error(
    `import.meta.hot.accept() can only accept string literals or an ` +
      `Array of string literals.`
  ) as RollupError
  err.pos = pos
  throw err
}

// 当热重新加载Vue文件时，我们监听文件改变事件立即读取，这样有时可能太早，且会得到一个空缓冲区buffer。
// 那么轮询直到文件的修改时间改变，然后再读取。
// vitejs/vite#610 when hot-reloading Vue files, we read immediately on file
// change event and sometimes this can be too early and get an empty buffer.
// Poll until the file's modified time has changed before reading again.
async function readModifiedFile(file: string): Promise<string> { // 读取修改的的文件
  const content = fs.readFileSync(file, 'utf-8') // 同步读取文件内容
  if (!content) { // 如果没有文件内容
    const mtime = fs.statSync(file).mtimeMs // 文件的修改时间
    await new Promise((r) => {
      let n = 0
      const poll = async () => {
        n++
        const newMtime = fs.statSync(file).mtimeMs // 当前文件的修改时间
        if (newMtime !== mtime || n > 10) { // 不一样 或者 次数大于10次以上
          r(0)
        } else {
          setTimeout(poll, 10) // 再次进行poll
        }
      }
      setTimeout(poll, 10) // 10ms执行一次
    })
    return fs.readFileSync(file, 'utf-8') // 再次读取文件内容
  } else {
    return content // 有内容则直接返回
  }
}
