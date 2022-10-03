import colors from 'picocolors'
import _debug from 'debug'
import { getHash } from '../utils'
import { getDepOptimizationConfig } from '..'
import type { ResolvedConfig, ViteDevServer } from '..'
import {
  addManuallyIncludedOptimizeDeps,
  addOptimizedDepInfo,
  createIsOptimizedDepUrl,
  debuggerViteDeps as debug,
  depsFromOptimizedDepInfo,
  depsLogString,
  discoverProjectDependencies,
  extractExportsData,
  getOptimizedDepPath,
  initDepsOptimizerMetadata,
  isOptimizedDepFile,
  loadCachedDepOptimizationMetadata,
  newDepOptimizationProcessing,
  optimizeServerSsrDeps,
  runOptimizeDeps,
  toDiscoveredDependencies
} from '.'
import type {
  DepOptimizationProcessing,
  DepOptimizationResult,
  DepsOptimizer,
  OptimizedDepInfo
} from '.'

const isDebugEnabled = _debug('vite:deps').enabled

/**
 * The amount to wait for requests to register newly found dependencies before triggering
 * a re-bundle + page reload
 */
const debounceMs = 100

const depsOptimizerMap = new WeakMap<ResolvedConfig, DepsOptimizer>()
const devSsrDepsOptimizerMap = new WeakMap<ResolvedConfig, DepsOptimizer>()

// 从map中获取依赖优化器
export function getDepsOptimizer(
  config: ResolvedConfig,
  ssr?: boolean
): DepsOptimizer | undefined {
  // Workers compilation shares the DepsOptimizer from the main build
  const isDevSsr = ssr && config.command !== 'build'
  return (isDevSsr ? devSsrDepsOptimizerMap : depsOptimizerMap).get(
    config.mainConfig || config
  )
}

// 初始化依赖优化器
export async function initDepsOptimizer(
  config: ResolvedConfig,
  server?: ViteDevServer
): Promise<void> {
  // Non Dev SSR Optimizer
  const ssr = config.command === 'build' && !!config.build.ssr
  if (!getDepsOptimizer(config, ssr)) {
    await createDepsOptimizer(config, server) // 创建一个依赖优化器
  }
}

let creatingDevSsrOptimizer: Promise<void> | undefined
export async function initDevSsrDepsOptimizer(
  config: ResolvedConfig,
  server: ViteDevServer
): Promise<void> {
  if (getDepsOptimizer(config, true)) {
    // ssr
    return
  }
  if (creatingDevSsrOptimizer) {
    return creatingDevSsrOptimizer
  }
  creatingDevSsrOptimizer = (async function () {
    // Important: scanning needs to be done before starting the SSR dev optimizer
    // If ssrLoadModule is called before server.listen(), the main deps optimizer
    // will not be yet created
    const ssr = false
    if (!getDepsOptimizer(config, ssr)) {
      await initDepsOptimizer(config, server)
    }
    await getDepsOptimizer(config, ssr)!.scanProcessing

    await createDevSsrDepsOptimizer(config)
    creatingDevSsrOptimizer = undefined
  })()
  return await creatingDevSsrOptimizer
}

async function createDepsOptimizer(
  config: ResolvedConfig,
  server?: ViteDevServer
): Promise<void> {
  const { logger } = config
  const isBuild = config.command === 'build'
  const ssr = isBuild && !!config.build.ssr // safe as Dev SSR don't use this optimizer

  const sessionTimestamp = Date.now().toString()

  // ***
  // 加载缓存依赖优化元数据
  // 是强制性的 或者 元数据中的hash和现在工程数据变了（获取依赖的hash（工程的lock文件内容如package-lock.json + vite中一些配置 -> 做一个hash值））不一样了都需要进行一个新鲜的缓存返回undefined
  // ***
  const cachedMetadata = loadCachedDepOptimizationMetadata(config, ssr)
  // 加载的里面就没有processing这个参数了

  let handle: NodeJS.Timeout | undefined

  let closed = false

  let metadata =
    cachedMetadata || initDepsOptimizerMetadata(config, ssr, sessionTimestamp) // 没有则初始化依赖优化元数据


  // 单独的方法
  //   registerMissingImport
  //   run: () => debouncedProcessing(0)
  //   registerWorkersSource
  //   delayDepsOptimizerUntil
  //   resetRegisteredIds
  //   ensureFirstRun
  //   close

  // 创建一个依赖优化器
  const depsOptimizer: DepsOptimizer = {
    metadata,
    registerMissingImport,
    run: () => debouncedProcessing(0), // 防抖
    isOptimizedDepFile: (id: string) => isOptimizedDepFile(id, config),
    isOptimizedDepUrl: createIsOptimizedDepUrl(config),
    getOptimizedDepId: (depInfo: OptimizedDepInfo) =>
      isBuild ? depInfo.file : `${depInfo.file}?v=${depInfo.browserHash}`, // 带上?v=这样的query
    registerWorkersSource,
    delayDepsOptimizerUntil,
    resetRegisteredIds,
    ensureFirstRun,
    close,
    options: getDepOptimizationConfig(config, ssr)
  }

  // 存入map中
  depsOptimizerMap.set(config, depsOptimizer)

  let newDepsDiscovered = false

  let newDepsToLog: string[] = []
  let newDepsToLogHandle: NodeJS.Timeout | undefined
  const logNewlyDiscoveredDeps = () => {
    if (newDepsToLog.length) {
      config.logger.info(
        colors.green(
          `✨ new dependencies optimized: ${depsLogString(newDepsToLog)}`
        ),
        {
          timestamp: true
        }
      )
      newDepsToLog = []
    }
  }

  // 其实就是返回一个promise和它的内部的resolve函数
  let depOptimizationProcessing = newDepOptimizationProcessing()
  let depOptimizationProcessingQueue: DepOptimizationProcessing[] = [] // 可以理解为promise队列
  const resolveEnqueuedProcessingPromises = () => { // 遍历这个队列，把所有的promise全部resolve，之后清空队列
    // Resolve all the processings (including the ones which were delayed)
    for (const processing of depOptimizationProcessingQueue) { // 这个队列中会有depOptimizationProcessing指向的promise
      processing.resolve() // 队列中的promise进行resolve
    }
    depOptimizationProcessingQueue = []
  }

  let enqueuedRerun: (() => void) | undefined
  let currentlyProcessing = false

  // 如果没有缓存或者它已经过时，我们需要准备第一次运行
  // If there wasn't a cache or it is outdated, we need to prepare a first run
  let firstRunCalled = !!cachedMetadata // 根据是否有缓存元数据来去判断是否为【第一次运行已调用】
  // 没有缓存元数据则说明还没有第一次运行已调用


  let postScanOptimizationResult: Promise<DepOptimizationResult> | undefined

  let optimizingNewDeps: Promise<DepOptimizationResult> | undefined
  async function close() {
    closed = true
    await postScanOptimizationResult
    await optimizingNewDeps
  }

  // 没有缓存元数据
  if (!cachedMetadata) {
    // Enter processing state until crawl of static imports ends
    currentlyProcessing = true // 当前正在处理中

    // 使用手动添加的optimizeDeps.include信息初始化探索的deps
    // Initialize discovered deps with manually added optimizeDeps.include info

    const deps: Record<string, string> = {}
    await addManuallyIncludedOptimizeDeps(deps, config, ssr) // 增加手动包含的优化依赖项
    // 主要就是找到手动包含的依赖项的入口文件路径作为键值对存入当前的deps中来

    // 对手动包含依赖项信息进行整合，合法化信息数据
    const discovered = await toDiscoveredDependencies(
      config,
      deps,
      ssr,
      sessionTimestamp
    )

    // 把合法化后的结果增加到元数据中，并标记探索到新的依赖
    for (const depInfo of Object.values(discovered)) {
      addOptimizedDepInfo(metadata, 'discovered', { // 增加到已探索中
        ...depInfo,
        processing: depOptimizationProcessing.promise // *** 在每个依赖身上加上当前一开始的promise ***
      })
      newDepsDiscovered = true
    }

    // 不是构建
    if (!isBuild) {
      // Important, the scanner is dev only
      const scanPhaseProcessing = newDepOptimizationProcessing() // 又创建一个promise
      depsOptimizer.scanProcessing = scanPhaseProcessing.promise // 把它交给依赖优化器

      // 确保在扫描之前服务器的listen是先被调用的

      // Ensure server listen is called before the scanner
      // 开启一个宏任务
      setTimeout(async () => {
        try {
          debug(colors.green(`scanning for dependencies...`))

          // 探索工程项目依赖项 -> 扫描导入，开始分析
          const deps = await discoverProjectDependencies(config)

          debug(
            colors.green(
              Object.keys(deps).length > 0
                ? `dependencies found by scanner: ${depsLogString(
                    Object.keys(deps)
                  )}`
                : `no dependencies found by scanner`
            )
          )

          // Add these dependencies to the discovered list, as these are currently
          // used by the preAliasPlugin to support aliased and optimized deps.
          // This is also used by the CJS externalization heuristics in legacy mode
          for (const id of Object.keys(deps)) {
            if (!metadata.discovered[id]) {
              addMissingDep(id, deps[id]) // 当前已探索选项类别中没有的那么给它增加进去，其中逻辑和上一次添加的逻辑是一样的
              // 也是增加到已探索中
            }
          }

          if (!isBuild) {
            // 把元数据中所保存的已优化和已探索的依赖项组合起来返回
            const knownDeps = prepareKnownDeps()

            // 对于开发，我们运行扫描仪和第一次优化在后台运行，但我们等到爬取结束决定我们是否将此结果发送到浏览器，或者我们需要做另一个优化步骤
            // For dev, we run the scanner and the first optimization
            // run on the background, but we wait until crawling has ended
            // to decide if we send this result to the browser or we need to
            // do another optimize step
            postScanOptimizationResult = runOptimizeDeps(config, knownDeps) // 开始运行优化依赖项
            // 主要就是使用esbuild按照当前所知道的依赖项作为多入口进行构建打包形参最终的chunks结果
            // 把处理结果保存到postScanOptimizationResult变量上

            // ***
            // vite v3.1.3中的实验表现
            //   首次是在/node_modules/.vite/deps_temp产生相关文件，且程序运行到这个位置左右就已经结束了，此时依赖缓存目录还是_temps这个
            //   只有当请求来的时候执行到transformRequest.ts中时会去执行delayDepsOptimizerUntil这个方法，后面才会进行执行提交的逻辑（重命名）
            //   还有就是会把依赖缓存文件所赋予的promise进行resolve，这样就可以做到通知那些需要加载当前依赖缓存文件的url去加载它对应的文件（此时已经生成了）

            // ***
          }
        } catch (e) {
          logger.error(e.message)
        } finally {
          // ***
          // 让代表扫描阶段的promise进行resolve，告诉其它所等待当前这个promise的人扫描阶段已完成（相当于一个通知的作用），你可以安心做其他的事情了
          // ***
          scanPhaseProcessing.resolve()
          depsOptimizer.scanProcessing = undefined // 之后清空依赖优化器身上扫描阶段的promise
        }
      }, 0)
    }
  }

  // ------
  // 单独的方法
  //   registerMissingImport // *** 重点 ***在resolve、preAlias插件中使用
  //   run: () => debouncedProcessing(0)
  //   registerWorkersSource
  //   delayDepsOptimizerUntil *** 重点 ***在transformRequest.ts以及optimizedDepsBuildPlugin中使用
  //   resetRegisteredIds
  //   ensureFirstRun
  //   close
  // ------

  // 开始下一次的批量探索
  function startNextDiscoveredBatch() {
    newDepsDiscovered = false

    // Add the current depOptimizationProcessing to the queue, these
    // promises are going to be resolved once a rerun is committed
    depOptimizationProcessingQueue.push(depOptimizationProcessing) // 把depOptimizationProcessing所指向的promise加入队列中

    // Create a new promise for the next rerun, discovered missing
    // dependencies will be assigned this promise from this point
    depOptimizationProcessing = newDepOptimizationProcessing() // 再次创建一个新的promise交给depOptimizationProcessing
  }

  // 优化新的依赖
  async function optimizeNewDeps() {
    // a successful completion of the optimizeDeps rerun will end up
    // creating new bundled version of all current and discovered deps
    // in the cache dir and a new metadata info object assigned
    // to _metadata. A fullReload is only issued if the previous bundled
    // dependencies have changed.

    // if the rerun fails, _metadata remains untouched, current discovered
    // deps are cleaned, and a fullReload is issued

    // All deps, previous known and newly discovered are rebundled,
    // respect insertion order to keep the metadata file stable

    const knownDeps = prepareKnownDeps() // 准备当前元数据中所知道的已优化和已探索的依赖项

    startNextDiscoveredBatch() // 开始下一次的批量探索

    return await runOptimizeDeps(config, knownDeps) // 运行优化依赖项
  }

  // 准备所知道的依赖项（已优化和已探索）
  function prepareKnownDeps() {
    const knownDeps: Record<string, OptimizedDepInfo> = {}
    // Clone optimized info objects, fileHash, browserHash may be changed for them
    for (const dep of Object.keys(metadata.optimized)) {
      knownDeps[dep] = { ...metadata.optimized[dep] }
    }
    for (const dep of Object.keys(metadata.discovered)) {
      // Clone the discovered info discarding its processing promise
      const { processing, ...info } = metadata.discovered[dep]
      knownDeps[dep] = info
    }
    return knownDeps
  }

  // 此方法只在rerun和onCrawlEnd函数（它确切的说是只执行一次）中执行
  // 运行优化器
  async function runOptimizer(preRunResult?: DepOptimizationResult) {
    const isRerun = firstRunCalled
    firstRunCalled = true // 标记第一次运行已调用
    // 这里标记为true之后，便没有在其它的地方发现更改为false的code了
    // 也就是保证第一次运行调用优化器

    // 确保按顺序调用rerun
    // Ensure that rerun is called sequentially
    enqueuedRerun = undefined // 置为undefined

    // Ensure that a rerun will not be issued for current discovered deps
    if (handle) clearTimeout(handle)

    if (closed || Object.keys(metadata.discovered).length === 0) {
      currentlyProcessing = false
      return
    }

    currentlyProcessing = true // 标记当前正在处理中

    try {
      // ***
      // 是否有上一次的运行结果
      // 没有则再一次执行runOptimizeDeps产生新的元数据
      // 有就直接使用之前的运行结果作为processingResult
      // ***
      const processingResult =
        preRunResult ?? (await (optimizingNewDeps = optimizeNewDeps())) // *** 重点 ***
        // ***
        // ***此函数中会去执行startNextDiscoveredBatch把新依赖已探索改为false***
        // 这会影响下面的逻辑的执行
        // ***
      
      // ***
      // ***
      optimizingNewDeps = undefined // *** 置为undefined ***

      if (closed) {
        currentlyProcessing = false
        processingResult.cancel()
        resolveEnqueuedProcessingPromises()
        return
      }

      const newData = processingResult.metadata // 当前这里再一次的新数据

      // 之间是否需要互操作丢失匹配（其实就是看之前的已探索和现在的已优化之间的需不需要互操作是否都是一样的，一旦出现不一样那么就需要重新加载，因为又可能在导入时出现错误）
      const needsInteropMismatch = findInteropMismatches(
        metadata.discovered,
        newData.optimized
      )

      // After a re-optimization, if the internal bundled chunks change a full page reload
      // is required. If the files are stable, we can avoid the reload that is expensive
      // for large applications. Comparing their fileHash we can find out if it is safe to
      // keep the current browser state.
      const needsReload = // 客户端是否需要做一个重新刷新
        needsInteropMismatch.length > 0 || // 有了互操作丢失了那么就需要要进行重新加载
        metadata.hash !== newData.hash || // 之前和现在新的hash不一致
        Object.keys(metadata.optimized).some((dep) => { // 之前已优化中在新的已优化中出现了文件的hash不一样也是需要重新加载的
          return (
            metadata.optimized[dep].fileHash !== newData.optimized[dep].fileHash
          )
        })

      // 提交本次处理结果
      const commitProcessing = async () => {
        await processingResult.commit() // 提交当前这里本次的处理结果
        // 重命名目录deps_temp -> deps

        // While optimizeDeps is running, new missing deps may be discovered,
        // in which case they will keep being added to metadata.discovered
        for (const id in metadata.discovered) {
          if (!newData.optimized[id]) {
            addOptimizedDepInfo(newData, 'discovered', metadata.discovered[id]) // 增加到本次新元数据里面去
          }
        }

        // If we don't reload the page, we need to keep browserHash stable
        if (!needsReload) {
          newData.browserHash = metadata.browserHash
          for (const dep in newData.chunks) {
            newData.chunks[dep].browserHash = metadata.browserHash
          }
          for (const dep in newData.optimized) {
            newData.optimized[dep].browserHash = (
              metadata.optimized[dep] || metadata.discovered[dep]
            ).browserHash
          }
        }

        // Commit hash and needsInterop changes to the discovered deps info
        // object. Allow for code to await for the discovered processing promise
        // and use the information in the same object
        for (const o in newData.optimized) {
          const discovered = metadata.discovered[o]
          if (discovered) {
            const optimized = newData.optimized[o]
            discovered.browserHash = optimized.browserHash
            discovered.fileHash = optimized.fileHash
            discovered.needsInterop = optimized.needsInterop
            discovered.processing = undefined // 置为了undefined
          }
        }

        if (isRerun) {
          newDepsToLog.push(
            ...Object.keys(newData.optimized).filter(
              (dep) => !metadata.optimized[dep]
            )
          )
        }

        metadata = depsOptimizer.metadata = newData // 全部替换为本次新的元数据
        resolveEnqueuedProcessingPromises() // 让队列中的promise全部执行resolve
        // 保证optimizedDepsPlugin中就可以安全的读取构建后的文件啦 ~
        // ***
      }

      if (!needsReload) {
        await commitProcessing() // 提交

        if (!isDebugEnabled) {
          if (newDepsToLogHandle) clearTimeout(newDepsToLogHandle)
          newDepsToLogHandle = setTimeout(() => {
            newDepsToLogHandle = undefined
            logNewlyDiscoveredDeps()
          }, 2 * debounceMs)
        } else {
          debug(
            colors.green(
              `✨ ${
                !isRerun
                  ? `dependencies optimized`
                  : `optimized dependencies unchanged`
              }`
            )
          )
        }
      } else {
        // 需要客户端做全重新加载

        // ***
        /**
         * ***大前提：下面所举得依赖包都是提前全部下载好了，才开始vite dev，以及下面写入新的时候也没有进行安装依赖包或者改变vite的配置等***
         * 这个大的前提就是因为每次启动vite，在上方的loadCachedDepOptimizationMetadata逻辑中会去检查工程hash是否变化了的情况
         * 如果变化了，那么就需要一个新鲜的缓存，像新的那样进行优化依赖缓存的，
         * 那么所以就需要去保证是一样的，那么才会发生下面的逻辑现象
         * 
         * 无依赖缓存 -> vite dev -> 生成.vite/deps_temp目录
         * 浏览器请求/ -> 重命名为.vite/deps
         * import Vue from 'vue'
         * import { Button } from 'element-ui'
         * 
         * ------
         * 
         * 有依赖缓存 -> vite dev -> 什么事情也没有做
         * 浏览器请求/
         * 对于后续在请求/main.js时 -> 在importAnalysis插件transform钩子里会进行对import语句的尝试解析 -> 对于新增的两条语句 -> 
         * 当然进行注册丢失导入，并按照预定规则返回url -> 把结果交给浏览器 -> 
         * debounceProcessing起到作用 -> 最后只会执行一次 -> 把newDepsDiscovered调为true -> 
         * 空参数执行runOptimizer -> 把newDepsDiscovered调为false，同时又会进行优化依赖 -> 对比是否客户端需要做一个全重新加载 -> 自然就走到下面的else里去了 -> 
         * 提交本次新的优化依赖，告诉浏览器全重新加载，***把promise进行resolve*** -> 发送请求 -> vite对比依赖请求的hash -> 变了就会重新读取交给客户端
         * import Vue from 'vue'
         * import { Button } from 'element-ui'
         * import Schema from 'async-validator'
         * import { throttle, debounce } from 'throttle-debounce'
         * 
         * 可以证明
         * 
         */

        // newDepsDiscovered只有在startNextDiscoveredBatch函数中才会变为false
        if (newDepsDiscovered) {

          // 有新发现的deps，即将执行另一个重新运行。我们不解析处理承诺，因为一旦提交了重新运行，它们将被解析

          // There are newly discovered deps, and another rerun is about to be
          // executed. Avoid the current full reload discarding this rerun result
          // We don't resolve the processing promise, as they will be resolved
          // once a rerun is committed
          processingResult.cancel() // 当前处理结果取消

          // ***
          // 只有没有上一次的运行结果才会重新运行优化依赖且把newDepsDiscovered标记为false，代表新一次的探索开始
          // 而有上一次的运行结果不会重新运行优化依赖也不会把newDepsDiscovered标记为false的（强调：在onCrawlEnd中先是标记为了false再执行runOptimizer并传入上一次优化依赖的结果）
          // ***

          // 有新的依赖被探索到

          // 由于发现了新的依赖关系而延迟重新加载...
          debug(
            colors.green(
              `✨ delaying reload as new dependencies have been found...`
            )
          )
        } else {
          // 没有新的依赖被探索到，但是之前的依赖变化了，那么就需要保存这次的结果且通知客户端进行全重新加载（因为浏览器端有依赖的缓存）
          // 所以需要做一个全重新加载，这样一来对于那些依赖也会发请求，但是前后hash不一致就会把新的文件交给客户端啦 ~

          await commitProcessing()

          if (!isDebugEnabled) {
            if (newDepsToLogHandle) clearTimeout(newDepsToLogHandle)
            newDepsToLogHandle = undefined
            logNewlyDiscoveredDeps()
          }

          logger.info(
            colors.green(`✨ optimized dependencies changed. reloading`),
            {
              timestamp: true
            }
          )
          if (needsInteropMismatch.length > 0) {
            config.logger.warn(
              `Mixed ESM and CJS detected in ${colors.yellow(
                needsInteropMismatch.join(', ')
              )}, add ${
                needsInteropMismatch.length === 1 ? 'it' : 'them'
              } to optimizeDeps.needsInterop to speed up cold start`,
              {
                timestamp: true
              }
            )
          }

          fullReload() // 告诉客户端需要做一个全重新加载且让模块图中的所有模块无效
        }
      }
    } catch (e) {
      logger.error(
        colors.red(`error while updating dependencies:\n${e.stack}`),
        { timestamp: true, error: e }
      )
      resolveEnqueuedProcessingPromises()

      // Reset missing deps, let the server rediscover the dependencies
      metadata.discovered = {}
    }

    currentlyProcessing = false // 标记当前不在处理中
    // @ts-ignore
    enqueuedRerun?.()
  }

  // 全重新加载
  function fullReload() {
    if (server) {
      // Cached transform results have stale imports (resolved to
      // old locations) so they need to be invalidated before the page is
      // reloaded.
      server.moduleGraph.invalidateAll()

      server.ws.send({
        type: 'full-reload',
        path: '*'
      })
    }
  }

  // 重新运行
  async function rerun() {
    // debounce time to wait for new missing deps finished, issue a new
    // optimization of deps (both old and newly found) once the previous
    // optimizeDeps processing is finished
    const deps = Object.keys(metadata.discovered)
    const depsString = depsLogString(deps)
    debug(colors.green(`new dependencies found: ${depsString}`))
    runOptimizer() // 运行优化器
    // ***
    // 重新运行没有传参数表示没有上一次的运行结果，那么内部就会在再一次的执行runOptimizeDeps产生新的元数据
    // ***
  }

  // 获取探索的浏览器hash
  function getDiscoveredBrowserHash(
    hash: string,
    deps: Record<string, string>,
    missing: Record<string, string>
  ) {
    return getHash(
      hash + JSON.stringify(deps) + JSON.stringify(missing) + sessionTimestamp
    )
  }

  // preAlias、resolve插件中使用到了此函数
  // 所以有个场景：之前使用过vite，所以产生了优化依赖缓存数据，那么关闭vite后编辑文件又新增了一些代码，之后运行发送请求就会对这些依赖进行resolveId，那么
  // 按照resolve插件的逻辑因为是先尝试优化解析（没有）所以就会触发这个函数进行注册丢失的导入
  // 注册丢失的导入
  function registerMissingImport(
    id: string, // 包名
    resolved: string // 包入口文件路径
  ): OptimizedDepInfo {
    const optimized = metadata.optimized[id]
    if (optimized) { // 是否已优化了
      return optimized
    }
    const chunk = metadata.chunks[id]
    if (chunk) { // 是否在chunks中
      return chunk
    }
    let missing = metadata.discovered[id]
    if (missing) { // 是否已经在已探索中了
      // 那么它将在下一次重新运行
      // We are already discover this dependency
      // It will be processed in the next rerun call
      return missing
    }

    // ***
    // 增加丢失的当前依赖项
    // ***
    missing = addMissingDep(id, resolved)

    // Until the first optimize run is called, avoid triggering processing
    // We'll wait until the user codebase is eagerly processed by Vite so
    // we can get a list of every missing dependency before giving to the
    // browser a dependency that may be outdated, thus avoiding full page reloads

    // ***
    // 有了缓存元数据以及真正的执行了一次runOptimizer函数后firstRunCalled会一直是true，没有改变为false的代码
    // ***
    if (firstRunCalled) {
      // Debounced rerun, let other missing dependencies be discovered before
      // the running next optimizeDeps
      debouncedProcessing() // 防抖
    }

    // Return the path for the optimized bundle, this path is known before
    // esbuild is run to generate the pre-bundle
    return missing
  }

  // 增加丢失的依赖项
  function addMissingDep(id: string, resolved: string) {
    newDepsDiscovered = true

    return addOptimizedDepInfo(metadata, 'discovered', {
      id,
      // ***
      // 例如dev期间的vue -> /node_modules/.vite/deps/vue.js
      // ***这样就能够说明esbuild能够保证多入口打包之后形成的bundle都是和入口点一一进行对应的。***
      // https://www.yuque.com/lanbitouw/lsud0i/eb30fx
      // ***
      file: getOptimizedDepPath(id, config, ssr),
      src: resolved, // 这是vue包的入口文件路径
      // Assing a browserHash to this missing dependency that is unique to
      // the current state of known + missing deps. If its optimizeDeps run
      // doesn't alter the bundled files of previous known dependencies,
      // we don't need a full reload and this browserHash will be kept
      browserHash: getDiscoveredBrowserHash(
        metadata.hash,
        depsFromOptimizedDepInfo(metadata.optimized),
        depsFromOptimizedDepInfo(metadata.discovered)
      ),
      // loading of this pre-bundled dep needs to await for its processing
      // promise to be resolved
      processing: depOptimizationProcessing.promise,
      exportsData: extractExportsData(resolved, config, ssr)
    })
  }

  // 防抖
  function debouncedProcessing(timeout = debounceMs) {
    if (!newDepsDiscovered) {
      return
    }
    // 防抖重新运行，在运行下一次优化依赖项之前让其它丢失的依赖项是已探索的
    // Debounced rerun, let other missing dependencies be discovered before
    // the running next optimizeDeps
    enqueuedRerun = undefined
    // 清除定时器
    if (handle) clearTimeout(handle)
    if (newDepsToLogHandle) clearTimeout(newDepsToLogHandle)
    newDepsToLogHandle = undefined
    handle = setTimeout(() => {
      handle = undefined
      enqueuedRerun = rerun
      if (!currentlyProcessing) {
        enqueuedRerun() // 执行rerun函数
      }
    }, timeout)
  }

  // 没有依赖缓存数据时只执行一次，之后有了再次启动vite就不会再执行这个函数了
  // ***
  // 爬取结束事件
  // ***
  async function onCrawlEnd() {
    debug(colors.green(`✨ static imports crawl ended`)) // 静态导入爬取结束
    // ***
    // 第一次运行已调用上面的运行优化器函数（内部把它标记为了true），之后便一直是true了，所以对于后面的执行onCrawlEnd函数都会被return了
    // ***
    if (firstRunCalled) { // 第一次运行直接return
      return
    }

    currentlyProcessing = false

    // 获取已探索依赖的keys
    const crawlDeps = Object.keys(metadata.discovered)

    // 等待依赖优化器扫描阶段的完成，它会进行通知
    // Await for the scan+optimize step running in the background
    // It normally should be over by the time crawling of user code ended
    await depsOptimizer.scanProcessing

    // 扫描阶段完成之后 ------

    if (!isBuild && postScanOptimizationResult) {
      const result = await postScanOptimizationResult // esbuild对依赖项作为多入口点构建之后的结果
      postScanOptimizationResult = undefined

      const scanDeps = Object.keys(result.metadata.optimized)

      if (scanDeps.length === 0 && crawlDeps.length === 0) {
        debug(
          colors.green(
            `✨ no dependencies found by the scanner or crawling static imports`
          )
        )
        result.cancel()
        firstRunCalled = true
        return
      }

      const needsInteropMismatch = findInteropMismatches(
        metadata.discovered,
        result.metadata.optimized
      )
      const scannerMissedDeps = crawlDeps.some((dep) => !scanDeps.includes(dep))
      const outdatedResult =
        needsInteropMismatch.length > 0 || scannerMissedDeps

      // 是否有过期的结果
      if (outdatedResult) {
        // Drop this scan result, and perform a new optimization to avoid a full reload
        result.cancel()

        // Add deps found by the scanner to the discovered deps while crawling
        for (const dep of scanDeps) {
          if (!crawlDeps.includes(dep)) {
            addMissingDep(dep, result.metadata.optimized[dep].src!)
          }
        }
        if (scannerMissedDeps) {
          debug(
            colors.yellow(
              `✨ new dependencies were found while crawling that weren't detected by the scanner`
            )
          )
        }
        debug(colors.green(`✨ re-running optimizer`))
        debouncedProcessing(0) // 再次防抖
      } else {
        debug(
          colors.green(
            `✨ using post-scan optimizer result, the scanner found every used dependency`
          )
        )
        // 开始下一次批量探索
        startNextDiscoveredBatch()
        runOptimizer(result) // 运行优化器
      }
    } else {
      if (crawlDeps.length === 0) {
        debug(
          colors.green(
            `✨ no dependencies found while crawling the static imports`
          )
        )
        firstRunCalled = true
      } else {
        // queue the first optimizer run
        debouncedProcessing(0)
      }
    }
  }

  const runOptimizerIfIdleAfterMs = 100

  let registeredIds: { id: string; done: () => Promise<any> }[] = []
  let seenIds = new Set<string>()
  let workersSources = new Set<string>()
  let waitingOn: string | undefined
  let firstRunEnsured = false
  // 第一次运行是否以确保了

  // 重置
  function resetRegisteredIds() {
    registeredIds = []
    seenIds = new Set<string>()
    workersSources = new Set<string>()
    waitingOn = undefined
    firstRunEnsured = false
  }

  // 确保第一次运行
  // If all the inputs are dependencies, we aren't going to get any
  // delayDepsOptimizerUntil(id) calls. We need to guard against this
  // by forcing a rerun if no deps have been registered
  function ensureFirstRun() {
    if (!firstRunEnsured && !firstRunCalled && registeredIds.length === 0) {
      setTimeout(() => {
        if (!closed && registeredIds.length === 0) {
          onCrawlEnd()
        }
      }, runOptimizerIfIdleAfterMs)
    }
    firstRunEnsured = true // 标记第一次运行已确保
  }

  // 
  function registerWorkersSource(id: string): void {
    workersSources.add(id)
    // Avoid waiting for this id, as it may be blocked by the rollup
    // bundling process of the worker that also depends on the optimizer
    registeredIds = registeredIds.filter((registered) => registered.id !== id)
    if (waitingOn === id) {
      waitingOn = undefined
      runOptimizerWhenIdle() // 当空闲的时候运行优化器
    }
  }

  // ***
  // 延迟依赖优化器直到
  // ***
  function delayDepsOptimizerUntil(id: string, done: () => Promise<any>): void {
    // seen: 见过
    if (!depsOptimizer.isOptimizedDepFile(id) && !seenIds.has(id)) {
      seenIds.add(id)
      registeredIds.push({ id, done })
      runOptimizerWhenIdle()
    }
  }

  // ***
  // 当空闲的时候运行优化器
  // ***
  function runOptimizerWhenIdle() {
    if (!waitingOn) {
      const next = registeredIds.pop()
      if (next) {
        waitingOn = next.id
        const afterLoad = () => {
          waitingOn = undefined
          if (!closed && !workersSources.has(next.id)) {
            if (registeredIds.length > 0) {
              runOptimizerWhenIdle() // 还是继续运行
            } else {
              onCrawlEnd() // 调用爬取结束
            }
          }
        }
        next
          .done() // done方法返回的是一个promise
          .then(() => {
            setTimeout(
              afterLoad,
              registeredIds.length > 0 ? 0 : runOptimizerIfIdleAfterMs
            )
          })
          .catch(afterLoad)
      }
    }
  }
}

async function createDevSsrDepsOptimizer(
  config: ResolvedConfig
): Promise<void> {
  const metadata = await optimizeServerSsrDeps(config)

  const depsOptimizer = {
    metadata,
    isOptimizedDepFile: (id: string) => isOptimizedDepFile(id, config),
    isOptimizedDepUrl: createIsOptimizedDepUrl(config),
    getOptimizedDepId: (depInfo: OptimizedDepInfo) =>
      `${depInfo.file}?v=${depInfo.browserHash}`,

    registerMissingImport: () => {
      throw new Error(
        'Vite Internal Error: registerMissingImport is not supported in dev SSR'
      )
    },
    // noop, there is no scanning during dev SSR
    // the optimizer blocks the server start
    run: () => {},
    registerWorkersSource: (id: string) => {},
    delayDepsOptimizerUntil: (id: string, done: () => Promise<any>) => {},
    resetRegisteredIds: () => {},
    ensureFirstRun: () => {},

    close: async () => {},
    options: config.ssr.optimizeDeps
  }
  devSsrDepsOptimizerMap.set(config, depsOptimizer)
}

function findInteropMismatches(
  discovered: Record<string, OptimizedDepInfo>,
  optimized: Record<string, OptimizedDepInfo>
) {
  const needsInteropMismatch = []
  for (const dep in discovered) {
    const discoveredDepInfo = discovered[dep]
    const depInfo = optimized[dep]
    if (depInfo) {
      if (
        discoveredDepInfo.needsInterop !== undefined &&
        depInfo.needsInterop !== discoveredDepInfo.needsInterop
      ) {
        // ***
        // 这仅发生在当一个以探索的依赖有混入esm和cjs语法且没有手动增加到optimizeDeps.needsInterop
        // ***
        // This only happens when a discovered dependency has mixed ESM and CJS syntax
        // and it hasn't been manually added to optimizeDeps.needsInterop
        needsInteropMismatch.push(dep)
        debug(colors.cyan(`✨ needsInterop mismatch detected for ${dep}`))
      }
    }
  }
  return needsInteropMismatch
}
