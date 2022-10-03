import { extname } from 'node:path'
import type { ModuleInfo, PartialResolvedId } from 'rollup'
import { isDirectCSSRequest } from '../plugins/css'
import {
  cleanUrl,
  normalizePath,
  removeImportQuery,
  removeTimestampQuery
} from '../utils'
import { FS_PREFIX } from '../constants'
import type { TransformResult } from './transformRequest'

export class ModuleNode {
  /**
   * Public served url path, starts with /
   */
  url: string
  /**
   * Resolved file system path + query
   */
  id: string | null = null
  file: string | null = null
  type: 'js' | 'css'
  info?: ModuleInfo
  meta?: Record<string, any>
  importers = new Set<ModuleNode>()
  importedModules = new Set<ModuleNode>()
  acceptedHmrDeps = new Set<ModuleNode>()
  acceptedHmrExports: Set<string> | null = null
  importedBindings: Map<string, Set<string>> | null = null
  isSelfAccepting?: boolean
  transformResult: TransformResult | null = null
  ssrTransformResult: TransformResult | null = null
  ssrModule: Record<string, any> | null = null
  ssrError: Error | null = null
  lastHMRTimestamp = 0
  lastInvalidationTimestamp = 0

  /**
   * @param setIsSelfAccepting - set `false` to set `isSelfAccepting` later. e.g. #7870
   */
  constructor(url: string, setIsSelfAccepting = true) {
    this.url = url
    /**
     * const cssLangs = `\\.(css|less|sass|scss|styl|stylus|pcss|postcss)($|\\?)`
     * const cssLangRE = new RegExp(cssLangs)
     * const directRequestRE = /(\?|&)direct\b/
     * 
     * export const isDirectCSSRequest = (request: string): boolean =>
     *   cssLangRE.test(request) && directRequestRE.test(request)
     * 
     */
    this.type = isDirectCSSRequest(url) ? 'css' : 'js' // 模块节点的类型
    // ***
    // 在transform.ts中有说明的
    // url必须是css语言请求 且 请求是要带?direct的才能是css请求，也就是说只有link的请求url的才能是css类型
    // 其它的一律为js类型
    // ***
    if (setIsSelfAccepting) {
      this.isSelfAccepting = false
    }
  }
}

function invalidateSSRModule(mod: ModuleNode, seen: Set<ModuleNode>) {
  if (seen.has(mod)) {
    return
  }
  seen.add(mod)
  mod.ssrModule = null
  mod.ssrError = null
  mod.importers.forEach((importer) => invalidateSSRModule(importer, seen))
}

export type ResolvedUrl = [
  url: string,
  resolvedId: string,
  meta: object | null | undefined
]

export class ModuleGraph {
  urlToModuleMap = new Map<string, ModuleNode>()
  idToModuleMap = new Map<string, ModuleNode>()
  // ***
  // 单个文件可能对应具有不同query的多个模块
  // 比如vue中就是把一个文件模块分为不同query的多个模块（比如在vue3中一个.vue文件分为xxx.vue mod（实际上被编译为了esm的JS文件内容） xxx.vue?type=css mod）
  // ***
  // a single file may corresponds to multiple modules with different queries
  fileToModulesMap = new Map<string, Set<ModuleNode>>()
  safeModulesPath = new Set<string>()

  constructor(
    private resolveId: (
      url: string,
      ssr: boolean
    ) => Promise<PartialResolvedId | null>
  ) {}

  async getModuleByUrl(
    rawUrl: string,
    ssr?: boolean
  ): Promise<ModuleNode | undefined> {
    const [url] = await this.resolveUrl(rawUrl, ssr)
    return this.urlToModuleMap.get(url)
  }

  getModuleById(id: string): ModuleNode | undefined {
    return this.idToModuleMap.get(removeTimestampQuery(id))
  }

  getModulesByFile(file: string): Set<ModuleNode> | undefined {
    return this.fileToModulesMap.get(file)
  }

  onFileChange(file: string): void {
    const mods = this.getModulesByFile(file)
    if (mods) {
      const seen = new Set<ModuleNode>()
      mods.forEach((mod) => {
        this.invalidateModule(mod, seen)
      })
    }
  }

  invalidateModule(
    mod: ModuleNode,
    seen: Set<ModuleNode> = new Set(),
    timestamp: number = Date.now()
  ): void {
    // Save the timestamp for this invalidation, so we can avoid caching the result of possible already started
    // processing being done for this module
    mod.lastInvalidationTimestamp = timestamp
    // Don't invalidate mod.info and mod.meta, as they are part of the processing pipeline
    // Invalidating the transform result is enough to ensure this module is re-processed next time it is requested
    mod.transformResult = null
    mod.ssrTransformResult = null
    invalidateSSRModule(mod, seen)
  }

  invalidateAll(): void {
    const timestamp = Date.now()
    const seen = new Set<ModuleNode>()
    this.idToModuleMap.forEach((mod) => {
      this.invalidateModule(mod, seen, timestamp)
    })
  }

  // ****
  /**
   * Update the module graph based on a module's updated imports information
   * If there are dependencies that no longer have any importers, they are
   * returned as a Set.
   */
  async updateModuleInfo( //更新模块信息
    mod: ModuleNode, // 要更新的模块
    importedModules: Set<string | ModuleNode>, // 导入的urls
    importedBindings: Map<string, Set<string>> | null, // 类似这样一个map { 'vue'=>['Vue'], 'echarts'=>['*'], 'element-ui'=>['Button'] }
    acceptedModules: Set<string | ModuleNode>, // 被接受的urls
    acceptedExports: Set<string> | null,
    isSelfAccepting: boolean, // 是否自身接受
    ssr?: boolean
  ): Promise<Set<ModuleNode> | undefined> {
    mod.isSelfAccepting = isSelfAccepting // 修改
    const prevImports = mod.importedModules // 之前所导入的urls
    const nextImports = (mod.importedModules = new Set()) // 现在导入的urls
    let noLongerImported: Set<ModuleNode> | undefined
    // update import graph
    for (const imported of importedModules) { // 分析出来的现在所导入的urls
      const dep =
        typeof imported === 'string'
          ? await this.ensureEntryFromUrl(imported, ssr) // 创建与之对应的模块节点加入到模块图中
          : imported
      // 创建双向依赖关系
      dep.importers.add(mod)
      nextImports.add(dep)
    }
    // remove the importer from deps that were imported but no longer are.
    prevImports.forEach((dep) => { // 遍历之前导入的
      if (!nextImports.has(dep)) { // 在现在导入中没有
        dep.importers.delete(mod) // 需要把这个依赖删除掉当前这个模块
        if (!dep.importers.size) { // 如果依赖模块没有导入的了（没有incoming）
          // dependency no longer imported
          ;(noLongerImported || (noLongerImported = new Set())).add(dep) // 记录不再被导入的依赖
        }
      }
    })
    // update accepted hmr deps
    const deps = (mod.acceptedHmrDeps = new Set())
    for (const accepted of acceptedModules) {
      const dep =
        typeof accepted === 'string'
          ? await this.ensureEntryFromUrl(accepted, ssr) // 确保模块节点
          : accepted
      deps.add(dep) // 更新当前模块接受的依赖模块
    }
    // update accepted hmr exports
    mod.acceptedHmrExports = acceptedExports // 更新
    mod.importedBindings = importedBindings // 更新
    return noLongerImported // 返回不再被导入的模块（备注：incoming mods一个也没有的这些模块）
  }

  // ****
  async ensureEntryFromUrl(
    rawUrl: string,
    ssr?: boolean,
    setIsSelfAccepting = true
  ): Promise<ModuleNode> {
    const [url, resolvedId, meta] = await this.resolveUrl(rawUrl, ssr)
    let mod = this.idToModuleMap.get(resolvedId)
    if (!mod) {
      mod = new ModuleNode(url, setIsSelfAccepting) // ***创建一个模块节点***
      if (meta) mod.meta = meta
      this.urlToModuleMap.set(url, mod)
      mod.id = resolvedId
      this.idToModuleMap.set(resolvedId, mod)
      const file = (mod.file = cleanUrl(resolvedId))
      let fileMappedModules = this.fileToModulesMap.get(file)
      if (!fileMappedModules) {
        fileMappedModules = new Set()
        this.fileToModulesMap.set(file, fileMappedModules)
      }
      fileMappedModules.add(mod)
    }
    // multiple urls can map to the same module and id, make sure we register
    // the url to the existing module in that case
    else if (!this.urlToModuleMap.has(url)) {
      this.urlToModuleMap.set(url, mod)
    }
    return mod
  }

  // some deps, like a css file referenced via @import, don't have its own
  // url because they are inlined into the main css import. But they still
  // need to be represented in the module graph so that they can trigger
  // hmr in the importing css file.
  createFileOnlyEntry(file: string): ModuleNode {
    file = normalizePath(file)
    let fileMappedModules = this.fileToModulesMap.get(file)
    if (!fileMappedModules) {
      fileMappedModules = new Set()
      this.fileToModulesMap.set(file, fileMappedModules)
    }

    const url = `${FS_PREFIX}${file}`
    for (const m of fileMappedModules) {
      if (m.url === url || m.id === file) {
        return m
      }
    }

    const mod = new ModuleNode(url) // 创建一个模块节点
    mod.file = file
    fileMappedModules.add(mod)
    return mod
  }

  // *****
  // for incoming urls, it is important to:
  // 1. remove the HMR timestamp query (?t=xxxx)
  // 2. resolve its extension so that urls with or without extension all map to
  // the same module
  async resolveUrl(url: string, ssr?: boolean): Promise<ResolvedUrl> {
    url = removeImportQuery(removeTimestampQuery(url))
    const resolved = await this.resolveId(url, !!ssr) // **插件容器中的resolveId钩子函数**
    const resolvedId = resolved?.id || url
    if (
      url !== resolvedId &&
      !url.includes('\0') &&
      !url.startsWith(`virtual:`)
    ) {
      const ext = extname(cleanUrl(resolvedId))
      const { pathname, search, hash } = new URL(url, 'relative://')
      if (ext && !pathname!.endsWith(ext)) {
        url = pathname + ext + search + hash
      }
    }
    return [url, resolvedId, resolved?.meta]
  }
}
