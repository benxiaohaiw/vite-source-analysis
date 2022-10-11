import aliasPlugin from '@rollup/plugin-alias'
import type { PluginHookUtils, ResolvedConfig } from '../config'
import { isDepsOptimizerEnabled } from '../config'
import type { HookHandler, Plugin } from '../plugin'
import { getDepsOptimizer } from '../optimizer'
import { shouldExternalizeForSSR } from '../ssr/ssrExternal'
import { jsonPlugin } from './json'
import { resolvePlugin } from './resolve'
import { optimizedDepsBuildPlugin, optimizedDepsPlugin } from './optimizedDeps'
import { esbuildPlugin } from './esbuild'
import { importAnalysisPlugin } from './importAnalysis'
import { cssPlugin, cssPostPlugin } from './css'
import { assetPlugin } from './asset'
import { clientInjectionsPlugin } from './clientInjections'
import { buildHtmlPlugin, htmlInlineProxyPlugin } from './html'
import { wasmFallbackPlugin, wasmHelperPlugin } from './wasm'
import { modulePreloadPolyfillPlugin } from './modulePreloadPolyfill'
import { webWorkerPlugin } from './worker'
import { preAliasPlugin } from './preAlias'
import { definePlugin } from './define'
import { ssrRequireHookPlugin } from './ssrRequireHook'
import { workerImportMetaUrlPlugin } from './workerImportMetaUrl'
import { assetImportMetaUrlPlugin } from './assetImportMetaUrl'
import { ensureWatchPlugin } from './ensureWatch'
import { metadataPlugin } from './metadata'
import { dynamicImportVarsPlugin } from './dynamicImportVars'
import { importGlobPlugin } from './importMetaGlob'

export async function resolvePlugins(
  config: ResolvedConfig,
  prePlugins: Plugin[],
  normalPlugins: Plugin[],
  postPlugins: Plugin[]
): Promise<Plugin[]> {
  const isBuild = config.command === 'build'
  const isWatch = isBuild && !!config.build.watch
  const buildPlugins = isBuild
    ? (await import('../build')).resolveBuildPlugins(config)
    : { pre: [], post: [] }
  const { modulePreload } = config.build // 是否有配置build下的模块预加载的配置

  return [
    isWatch ? ensureWatchPlugin() : null,
    isBuild ? metadataPlugin() : null, // 构建时主要在renderChunk钩子中给每一个chunk对象添加viteMetadata属性，其中共vite使用
    preAliasPlugin(config),
    aliasPlugin({ entries: config.resolve.alias }),
    ...prePlugins,
    modulePreload === true ||
    (typeof modulePreload === 'object' && modulePreload.polyfill)
      ? modulePreloadPolyfillPlugin(config) // 模块预加载垫片插件
      // 主要就是对浏览器不支持link标签rel属性的modulepreload选项做一个垫片处理（也就是直接通过fetch来去模拟预加载这个效果）
      : null,
    ...(isDepsOptimizerEnabled(config, false) ||
    isDepsOptimizerEnabled(config, true)
      ? [
          isBuild
            ? optimizedDepsBuildPlugin(config)
            : optimizedDepsPlugin(config) // 优化依赖插件（主要是判断id是否为优化依赖id以及加载时需要等待处理完成（**重点**）才能去读取文件，因为可能还没有产生这个文件）
        ]
      : []),
    resolvePlugin({ // 解析插件（主要是它的resolveId钩子（[: /@fs/、/、.相对、绝对fs都是try fs -> [: 裸包导入 try optimized -> try node）以及load钩子（主要处理浏览器外部化开头的加载垫片 -> 在解析node内置模块时所返回的id））
      ...config.resolve,
      root: config.root,
      isProduction: config.isProduction,
      isBuild,
      packageCache: config.packageCache,
      ssrConfig: config.ssr,
      asSrc: true,
      getDepsOptimizer: (ssr: boolean) => getDepsOptimizer(config, ssr),
      shouldExternalize:
        isBuild && config.build.ssr && config.ssr?.format !== 'cjs'
          ? (id) => shouldExternalizeForSSR(id, config)
          : undefined
    }),
    // 主要就是把vite自己添加的一些inlin-css这种id形式进行解析和加载
    htmlInlineProxyPlugin(config),
    cssPlugin(config), // css插件（主要是transform内进行编译css代码）
    // undefined !== false -> true 直接应用这个esbuildPlugin - 它主要可以进行使用esbuild里面的transform函数进行转换代码（主要针对js、**ts**等都是可以的，尤其是ts）
    config.esbuild !== false ? esbuildPlugin(config.esbuild) : null, // ***
    jsonPlugin( // json插件（主要是tansform钩子将json转为对象）
      {
        namedExports: true, // 默认是命名导出
        ...config.json // 自定义配置可覆盖
      },
      isBuild
    ),
    wasmHelperPlugin(config),
    webWorkerPlugin(config),
    assetPlugin(config), // 资源插件（它的load钩子很重要）
    ...normalPlugins,
    wasmFallbackPlugin(),
    definePlugin(config),
    cssPostPlugin(config), // css后置插件（开发时将css代码转为js字符串返回即可）
    isBuild && config.build.ssr ? ssrRequireHookPlugin(config) : null,
    isBuild && buildHtmlPlugin(config), // ***构建的入口就是在这里开始的***
    workerImportMetaUrlPlugin(config),
    assetImportMetaUrlPlugin(config),
    ...buildPlugins.pre,
    dynamicImportVarsPlugin(config),
    importGlobPlugin(config),
    ...postPlugins,
    ...buildPlugins.post,
    // internal server-only plugins are always applied after everything else
    ...(isBuild
      ? []
      : [clientInjectionsPlugin(config), importAnalysisPlugin(config)]) // 客户端注入插件、导入分析插件（它的transform钩子很重要的）
      // 客户端注入插件（transform钩子）
      // 主要是对vite库下的dist/client/client.mjs || dist/client/env.mjs路径文件中使用到的定义的变量这些全部做一个替换
      // 另外对于不是上述两个文件的其它文件中的process.env.NODE_ENV会被替换为以下逻辑
      //   config.define?.['process.env.NODE_ENV'] || JSON.stringify(process.env.NODE_ENV || config.mode)
  ].filter(Boolean) as Plugin[]
}

export function createPluginHookUtils(
  plugins: readonly Plugin[]
): PluginHookUtils {
  // sort plugins per hook
  const sortedPluginsCache = new Map<keyof Plugin, Plugin[]>()
  function getSortedPlugins(hookName: keyof Plugin): Plugin[] {
    if (sortedPluginsCache.has(hookName))
      return sortedPluginsCache.get(hookName)!
    const sorted = getSortedPluginsByHook(hookName, plugins)
    sortedPluginsCache.set(hookName, sorted)
    return sorted
  }
  function getSortedPluginHooks<K extends keyof Plugin>(
    hookName: K
  ): NonNullable<HookHandler<Plugin[K]>>[] {
    const plugins = getSortedPlugins(hookName)
    return plugins
      .map((p) => {
        const hook = p[hookName]!
        // @ts-expect-error cast
        return 'handler' in hook ? hook.handler : hook
      })
      .filter(Boolean)
  }

  return {
    getSortedPlugins,
    getSortedPluginHooks
  }
}

export function getSortedPluginsByHook(
  hookName: keyof Plugin,
  plugins: readonly Plugin[]
): Plugin[] {
  const pre: Plugin[] = []
  const normal: Plugin[] = []
  const post: Plugin[] = []
  for (const plugin of plugins) {
    const hook = plugin[hookName]
    if (hook) {
      if (typeof hook === 'object') {
        if (hook.order === 'pre') {
          pre.push(plugin)
          continue
        }
        if (hook.order === 'post') {
          post.push(plugin)
          continue
        }
      }
      normal.push(plugin)
    }
  }
  return [...pre, ...normal, ...post]
}
