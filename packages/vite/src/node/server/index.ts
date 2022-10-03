import fs from 'node:fs'
import path from 'node:path'
import type * as net from 'node:net'
import type * as http from 'node:http'
import { performance } from 'node:perf_hooks'
import connect from 'connect'
import corsMiddleware from 'cors'
import colors from 'picocolors'
import chokidar from 'chokidar'
import type { FSWatcher, WatchOptions } from 'dep-types/chokidar'
import type { Connect } from 'dep-types/connect'
import launchEditorMiddleware from 'launch-editor-middleware'
import type { SourceMap } from 'rollup'
import picomatch from 'picomatch'
import type { Matcher } from 'picomatch'
import type { CommonServerOptions } from '../http'
import {
  httpServerStart,
  resolveHttpServer,
  resolveHttpsConfig,
  setClientErrorHandler
} from '../http'
import type { InlineConfig, ResolvedConfig } from '../config'
import { isDepsOptimizerEnabled, resolveConfig } from '../config'
import {
  isParentDirectory,
  mergeConfig,
  normalizePath,
  resolveHostname,
  resolveServerUrls
} from '../utils'
import { ssrLoadModule } from '../ssr/ssrModuleLoader'
import { cjsSsrResolveExternals } from '../ssr/ssrExternal'
import {
  rebindErrorStacktrace,
  ssrRewriteStacktrace
} from '../ssr/ssrStacktrace'
import { ssrTransform } from '../ssr/ssrTransform'
import {
  getDepsOptimizer,
  initDepsOptimizer,
  initDevSsrDepsOptimizer
} from '../optimizer'
import { CLIENT_DIR } from '../constants'
import type { Logger } from '../logger'
import { printServerUrls } from '../logger'
import { invalidatePackageData } from '../packages'
import { resolveChokidarOptions } from '../watch'
import type { PluginContainer } from './pluginContainer'
import { createPluginContainer } from './pluginContainer'
import type { WebSocketServer } from './ws'
import { createWebSocketServer } from './ws'
import { baseMiddleware } from './middlewares/base'
import { proxyMiddleware } from './middlewares/proxy'
import { spaFallbackMiddleware } from './middlewares/spaFallback'
import { transformMiddleware } from './middlewares/transform'
import {
  createDevHtmlTransformFn,
  indexHtmlMiddleware
} from './middlewares/indexHtml'
import {
  servePublicMiddleware,
  serveRawFsMiddleware,
  serveStaticMiddleware
} from './middlewares/static'
import { timeMiddleware } from './middlewares/time'
import { ModuleGraph } from './moduleGraph'
import { errorMiddleware, prepareError } from './middlewares/error'
import type { HmrOptions } from './hmr'
import { handleFileAddUnlink, handleHMRUpdate } from './hmr'
import { openBrowser } from './openBrowser'
import type { TransformOptions, TransformResult } from './transformRequest'
import { transformRequest } from './transformRequest'
import { searchForWorkspaceRoot } from './searchRoot'

export { searchForWorkspaceRoot } from './searchRoot'

export interface ServerOptions extends CommonServerOptions {
  /**
   * Configure HMR-specific options (port, host, path & protocol)
   */
  hmr?: HmrOptions | boolean
  /**
   * chokidar watch options
   * https://github.com/paulmillr/chokidar#api
   */
  watch?: WatchOptions
  /**
   * Create Vite dev server to be used as a middleware in an existing server
   */
  middlewareMode?: boolean | 'html' | 'ssr'
  /**
   * Prepend this folder to http requests, for use when proxying vite as a subfolder
   * Should start and end with the `/` character
   */
  base?: string
  /**
   * Options for files served via '/\@fs/'.
   */
  fs?: FileSystemServeOptions
  /**
   * Origin for the generated asset URLs.
   *
   * @example `http://127.0.0.1:8080`
   */
  origin?: string
  /**
   * Pre-transform known direct imports
   * @default true
   */
  preTransformRequests?: boolean
  /**
   * Force dep pre-optimization regardless of whether deps have changed.
   *
   * @deprecated Use optimizeDeps.force instead, this option may be removed
   * in a future minor version without following semver
   */
  force?: boolean
}

export interface ResolvedServerOptions extends ServerOptions {
  fs: Required<FileSystemServeOptions>
  middlewareMode: boolean
}

export interface FileSystemServeOptions {
  /**
   * Strictly restrict file accessing outside of allowing paths.
   *
   * Set to `false` to disable the warning
   *
   * @default true
   */
  strict?: boolean

  /**
   * Restrict accessing files outside the allowed directories.
   *
   * Accepts absolute path or a path relative to project root.
   * Will try to search up for workspace root by default.
   */
  allow?: string[]

  /**
   * Restrict accessing files that matches the patterns.
   *
   * This will have higher priority than `allow`.
   * picomatch patterns are supported.
   *
   * @default ['.env', '.env.*', '*.crt', '*.pem']
   */
  deny?: string[]
}

export type ServerHook = (
  this: void,
  server: ViteDevServer
) => (() => void) | void | Promise<(() => void) | void>

export interface ViteDevServer {
  /**
   * The resolved vite config object
   */
  config: ResolvedConfig
  /**
   * A connect app instance.
   * - Can be used to attach custom middlewares to the dev server.
   * - Can also be used as the handler function of a custom http server
   *   or as a middleware in any connect-style Node.js frameworks
   *
   * https://github.com/senchalabs/connect#use-middleware
   */
  middlewares: Connect.Server
  /**
   * native Node http server instance
   * will be null in middleware mode
   */
  httpServer: http.Server | null
  /**
   * chokidar watcher instance
   * https://github.com/paulmillr/chokidar#api
   */
  watcher: FSWatcher
  /**
   * web socket server with `send(payload)` method
   */
  ws: WebSocketServer
  /**
   * Rollup plugin container that can run plugin hooks on a given file
   */
  pluginContainer: PluginContainer
  /**
   * Module graph that tracks the import relationships, url to file mapping
   * and hmr state.
   */
  moduleGraph: ModuleGraph
  /**
   * The resolved urls Vite prints on the CLI. null in middleware mode or
   * before `server.listen` is called.
   */
  resolvedUrls: ResolvedServerUrls | null
  /**
   * Programmatically resolve, load and transform a URL and get the result
   * without going through the http request pipeline.
   */
  transformRequest(
    url: string,
    options?: TransformOptions
  ): Promise<TransformResult | null>
  /**
   * Apply vite built-in HTML transforms and any plugin HTML transforms.
   */
  transformIndexHtml(
    url: string,
    html: string,
    originalUrl?: string
  ): Promise<string>
  /**
   * Transform module code into SSR format.
   */
  ssrTransform(
    code: string,
    inMap: SourceMap | null,
    url: string,
    originalCode?: string
  ): Promise<TransformResult | null>
  /**
   * Load a given URL as an instantiated module for SSR.
   */
  ssrLoadModule(
    url: string,
    opts?: { fixStacktrace?: boolean }
  ): Promise<Record<string, any>>
  /**
   * Returns a fixed version of the given stack
   */
  ssrRewriteStacktrace(stack: string): string
  /**
   * Mutates the given SSR error by rewriting the stacktrace
   */
  ssrFixStacktrace(e: Error): void
  /**
   * Start the server.
   */
  listen(port?: number, isRestart?: boolean): Promise<ViteDevServer>
  /**
   * Stop the server.
   */
  close(): Promise<void>
  /**
   * Print server urls
   */
  printUrls(): void
  /**
   * Restart the server.
   *
   * @param forceOptimize - force the optimizer to re-bundle, same as --force cli flag
   */
  restart(forceOptimize?: boolean): Promise<void>
  /**
   * @internal
   */
  _importGlobMap: Map<string, string[][]>
  /**
   * Deps that are externalized
   * @internal
   */
  _ssrExternals: string[] | null
  /**
   * @internal
   */
  _restartPromise: Promise<void> | null
  /**
   * @internal
   */
  _forceOptimizeOnRestart: boolean
  /**
   * @internal
   */
  _pendingRequests: Map<
    string,
    {
      request: Promise<TransformResult | null>
      timestamp: number
      abort: () => void
    }
  >
  /**
   * @internal
   */
  _fsDenyGlob: Matcher
}

export interface ResolvedServerUrls {
  local: string[]
  network: string[]
}

export async function createServer(
  inlineConfig: InlineConfig = {}
): Promise<ViteDevServer> {
  // 解析配置
  // 其中会把内置插件默认应用
  const config = await resolveConfig(inlineConfig, 'serve', 'development')
  const { root, server: serverConfig } = config
  const httpsOptions = await resolveHttpsConfig(config.server.https)
  const { middlewareMode } = serverConfig

  const resolvedWatchOptions = resolveChokidarOptions({
    disableGlobbing: true,
    ...serverConfig.watch
  }) // 默认了一些参数选项比如ignore **/node_modules/**等

  // 使用connect库
  const middlewares = connect() as Connect.Server
  const httpServer = middlewareMode
    ? null
    : await resolveHttpServer(serverConfig, middlewares, httpsOptions)
  const ws = createWebSocketServer(httpServer, config, httpsOptions)

  if (httpServer) {
    setClientErrorHandler(httpServer, config.logger)
  }

  // 经过实验发现其是深度观察
  // 创建一个文件观察者
  const watcher = chokidar.watch(
    path.resolve(root), // 这里直接就让观察root根目录啦 ~
    resolvedWatchOptions // 默认了一些参数选项比如ignore **/node_modules/**等
  ) as FSWatcher

  // 造一个模块图
  const moduleGraph: ModuleGraph = new ModuleGraph((url, ssr) =>
    container.resolveId(url, undefined, { ssr })
  )

  // 创建插件容器
  const container = await createPluginContainer(config, moduleGraph, watcher)
  const closeHttpServer = createServerCloseFn(httpServer)

  let exitProcess: () => void

  const server: ViteDevServer = {
    config,
    middlewares,
    httpServer,
    watcher,
    pluginContainer: container,
    ws,
    moduleGraph,
    resolvedUrls: null, // will be set on listen
    ssrTransform(
      code: string,
      inMap: SourceMap | null,
      url: string,
      originalCode = code
    ) {
      return ssrTransform(code, inMap, url, originalCode, server.config)
    },
    transformRequest(url, options) {
      return transformRequest(url, server, options)
    },
    transformIndexHtml: null!, // to be immediately set
    async ssrLoadModule(url, opts?: { fixStacktrace?: boolean }) {
      if (isDepsOptimizerEnabled(config, true)) {
        await initDevSsrDepsOptimizer(config, server)
      }
      await updateCjsSsrExternals(server)
      return ssrLoadModule(
        url,
        server,
        undefined,
        undefined,
        opts?.fixStacktrace
      )
    },
    ssrFixStacktrace(e) {
      if (e.stack) {
        const stacktrace = ssrRewriteStacktrace(e.stack, moduleGraph)
        rebindErrorStacktrace(e, stacktrace)
      }
    },
    ssrRewriteStacktrace(stack: string) {
      return ssrRewriteStacktrace(stack, moduleGraph)
    },
    async listen(port?: number, isRestart?: boolean) { // listen方法
      await startServer(server, port, isRestart) // 开启服务器
      if (httpServer) {
        server.resolvedUrls = await resolveServerUrls(
          httpServer,
          config.server,
          config
        )
      }
      return server
    },
    async close() {
      if (!middlewareMode) {
        process.off('SIGTERM', exitProcess)
        if (process.env.CI !== 'true') {
          process.stdin.off('end', exitProcess)
        }
      }
      await Promise.all([
        watcher.close(),
        ws.close(),
        container.close(),
        getDepsOptimizer(server.config)?.close(),
        getDepsOptimizer(server.config, true)?.close(),
        closeHttpServer()
      ])
      server.resolvedUrls = null
    },
    printUrls() { // 打印urls
      if (server.resolvedUrls) {
        printServerUrls(
          server.resolvedUrls,
          serverConfig.host,
          config.logger.info
        )
      } else if (middlewareMode) {
        throw new Error('cannot print server URLs in middleware mode.')
      } else {
        throw new Error(
          'cannot print server URLs before server.listen is called.'
        )
      }
    },
    async restart(forceOptimize?: boolean) {
      if (!server._restartPromise) {
        server._forceOptimizeOnRestart = !!forceOptimize
        server._restartPromise = restartServer(server).finally(() => {
          server._restartPromise = null
          server._forceOptimizeOnRestart = false
        })
      }
      return server._restartPromise
    },

    _ssrExternals: null,
    _restartPromise: null,
    _importGlobMap: new Map(),
    _forceOptimizeOnRestart: false,
    _pendingRequests: new Map(),
    _fsDenyGlob: picomatch(config.server.fs.deny, { matchBase: true })
  }

  server.transformIndexHtml = createDevHtmlTransformFn(server)

  if (!middlewareMode) {
    exitProcess = async () => {
      try {
        await server.close()
      } finally {
        process.exit()
      }
    }
    process.once('SIGTERM', exitProcess)
    if (process.env.CI !== 'true') {
      process.stdin.on('end', exitProcess)
    }
  }

  const { packageCache } = config
  const setPackageData = packageCache.set.bind(packageCache) // 重写了此方法
  packageCache.set = (id, pkg) => {
    if (id.endsWith('.json')) {
      watcher.add(id) // 若是以.json结尾那么增加到watcher中
    }
    return setPackageData(id, pkg) // 设置包数据
  }

  // ***
  // 文件改变事件回调
  watcher.on('change', async (file) => {
    file = normalizePath(file)
    if (file.endsWith('/package.json')) {
      return invalidatePackageData(packageCache, file) // 直接从packageCache map中删除file对应的键值对
      // 这里直接返回
    }
    // 文件改变时使模块图缓存无效
    // invalidate module graph cache on file change
    moduleGraph.onFileChange(file) // 让当前文件路径所对应的多个不同query的模块的transformResult为空等操作
    if (serverConfig.hmr !== false) {
      try {
        await handleHMRUpdate(file, server) // 处理热模替换更新
      } catch (err) {
        ws.send({
          type: 'error',
          err: prepareError(err)
        })
      }
    }
  })

  /**
   * 
   * 要注意：在vite启动后，模块图中是没有任何模块的
   * 那么它的模块图中的模块节点是在什么时刻添加的呢？
   * indexHtml plugin -> ensureEntryFromUrl - ensureWatchedFile
   * transformRequest中的loadAndTransform -> 在load和transform之间ensureEntryFromUrl - ensureWatchedFile
   * importAnalysis plugin中的normalizeUrl -> ensureEntryFromUrl
   * 
   */

  // 经过实验发现其是深度观察
  // 虽然这里没有监听addDir、unlinkDir事件，但是对于深度嵌套的目录中的文件add、unlink、change都会监听到的
  // 且在一开始启动监听时，对于所要监听的目录中存在的符合对应事件add、addDir的，那么第一次就会响应的
  // 也就是说src/main.js -> 启动监听后 -> 在一开始就会触发add事件
  

  // all

  
  // 文件增加事件回调
  watcher.on('add', (file) => {
    handleFileAddUnlink(normalizePath(file), server)
  })
  // addDir

  // 文件删除事件回调
  watcher.on('unlink', (file) => {
    handleFileAddUnlink(normalizePath(file), server)
  })
  // unlinkDir
  // ***

  if (!middlewareMode && httpServer) {
    httpServer.once('listening', () => {
      // update actual port since this may be different from initial value
      serverConfig.port = (httpServer.address() as net.AddressInfo).port
    })
  }

  // apply server configuration hooks from plugins
  const postHooks: ((() => void) | void)[] = []
  for (const hook of config.getSortedPluginHooks('configureServer')) {
    postHooks.push(await hook(server))
  }

  // Internal middlewares ------------------------------------------------------

  // 下方是中间件的顺序

  // request timer
  if (process.env.DEBUG) {
    middlewares.use(timeMiddleware(root))
  }

  // 默认开启跨域
  // cors (enabled by default)
  const { cors } = serverConfig
  if (cors !== false) {
    middlewares.use(corsMiddleware(typeof cors === 'boolean' ? {} : cors))
  }

  // 代理
  // proxy
  const { proxy } = serverConfig
  if (proxy) {
    middlewares.use(proxyMiddleware(httpServer, proxy, config))
  }

  // base
  const devBase = config.base
  if (devBase !== '/') {
    middlewares.use(baseMiddleware(server))
  }

  // open in editor support
  middlewares.use('/__open-in-editor', launchEditorMiddleware())

  // ***
  // ***
  // 服务在/public下的静态文件
  // ***
  // ***
  // serve static files under /public
  // this applies before the transform middleware so that these files are served
  // as-is without transforms.
  if (config.publicDir) {
    middlewares.use(
      servePublicMiddleware(config.publicDir, config.server.headers)
    )
  }

  // ***
  // 核心
  // 主要转换中间件
  // ***
  // main transform middleware
  middlewares.use(transformMiddleware(server)) // 核心函数 -> transformMiddleware
  // ***

  // 服务静态文件中间件
  // serve static files
  middlewares.use(serveRawFsMiddleware(server))
  middlewares.use(serveStaticMiddleware(root, server))

  // 单页面应用回退中间件
  // spa fallback
  if (config.appType === 'spa') {
    middlewares.use(spaFallbackMiddleware(root)) // 主要功能就是把请求的url回退到/index.html
  }

  // run post config hooks
  // This is applied before the html middleware so that user middleware can
  // serve custom content instead of index.html.
  postHooks.forEach((fn) => fn && fn())

  if (config.appType === 'spa' || config.appType === 'mpa') {
    // transform index.html
    middlewares.use(indexHtmlMiddleware(server)) // *** 转换index.html ***
    // ******

    // handle 404s
    // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
    middlewares.use(function vite404Middleware(_, res) {
      res.statusCode = 404
      res.end()
    })
  }

  // 错误处理中间件
  // error handler
  middlewares.use(errorMiddleware(server, middlewareMode))

  let initingServer: Promise<void> | undefined
  let serverInited = false
  const initServer = async () => {
    if (serverInited) {
      return
    }
    if (initingServer) {
      return initingServer
    }
    initingServer = (async function () {
      await container.buildStart({}) // 触发插件容器 -> 构建开始阶段
      // ssr ? config.ssr.optimizeDeps : config.optimizeDeps -> disabled属性可控制是否开启
      // ***
      if (isDepsOptimizerEnabled(config, false)) { // 依赖优化器是否开启
        // non-ssr
        await initDepsOptimizer(config, server) // *** 开启则初始化依赖优化器 ***
      }
      initingServer = undefined
      serverInited = true
    })()
    return initingServer
  }

  if (!middlewareMode && httpServer) {
    // overwrite listen to init optimizer before server start
    const listen = httpServer.listen.bind(httpServer)
    httpServer.listen = (async (port: number, ...args: any[]) => { // 在服务器启动之前重写listen方法以便于可以初始化optimizer优化器
      try {
        await initServer() // 初始化优化器
      } catch (e) {
        httpServer.emit('error', e)
        return
      }
      return listen(port, ...args) // 原先的listen方法
    }) as any
  } else {
    await initServer()
  }

  return server
}

async function startServer(
  server: ViteDevServer,
  inlinePort?: number,
  isRestart: boolean = false
): Promise<void> {
  const httpServer = server.httpServer
  if (!httpServer) {
    throw new Error('Cannot call server.listen in middleware mode.')
  }

  const options = server.config.server
  const port = inlinePort ?? options.port ?? 5173
  const hostname = await resolveHostname(options.host)

  const protocol = options.https ? 'https' : 'http'
  const info = server.config.logger.info
  const devBase = server.config.base

  const serverPort = await httpServerStart(httpServer, {
    port,
    strictPort: options.strictPort,
    host: hostname.host,
    logger: server.config.logger
  }) // 此方法会调用httpServer的listen方法

  // @ts-ignore
  const profileSession = global.__vite_profile_session
  if (profileSession) {
    profileSession.post('Profiler.stop', (err: any, { profile }: any) => {
      // Write profile to disk, upload, etc.
      if (!err) {
        const outPath = path.resolve('./vite-profile.cpuprofile')
        fs.writeFileSync(outPath, JSON.stringify(profile))
        info(
          colors.yellow(
            `  CPU profile written to ${colors.white(colors.dim(outPath))}\n`
          )
        )
      } else {
        throw err
      }
    })
  }

  if (options.open && !isRestart) {
    const path = typeof options.open === 'string' ? options.open : devBase
    openBrowser(
      path.startsWith('http')
        ? path
        : `${protocol}://${hostname.name}:${serverPort}${path}`,
      true,
      server.config.logger
    )
  }
}

function createServerCloseFn(server: http.Server | null) {
  if (!server) {
    return () => {}
  }

  let hasListened = false
  const openSockets = new Set<net.Socket>()

  server.on('connection', (socket) => {
    openSockets.add(socket)
    socket.on('close', () => {
      openSockets.delete(socket)
    })
  })

  server.once('listening', () => {
    hasListened = true
  })

  return () =>
    new Promise<void>((resolve, reject) => {
      openSockets.forEach((s) => s.destroy())
      if (hasListened) {
        server.close((err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      } else {
        resolve()
      }
    })
}

function resolvedAllowDir(root: string, dir: string): string {
  return normalizePath(path.resolve(root, dir))
}

export function resolveServerOptions(
  root: string,
  raw: ServerOptions | undefined,
  logger: Logger
): ResolvedServerOptions {
  const server: ResolvedServerOptions = {
    preTransformRequests: true,
    ...(raw as ResolvedServerOptions),
    middlewareMode: !!raw?.middlewareMode
  }
  let allowDirs = server.fs?.allow
  const deny = server.fs?.deny || ['.env', '.env.*', '*.{crt,pem}']

  if (!allowDirs) {
    allowDirs = [searchForWorkspaceRoot(root)]
  }

  allowDirs = allowDirs.map((i) => resolvedAllowDir(root, i))

  // only push client dir when vite itself is outside-of-root
  const resolvedClientDir = resolvedAllowDir(root, CLIENT_DIR)
  if (!allowDirs.some((dir) => isParentDirectory(dir, resolvedClientDir))) {
    allowDirs.push(resolvedClientDir)
  }

  server.fs = {
    strict: server.fs?.strict ?? true,
    allow: allowDirs,
    deny
  }

  if (server.origin?.endsWith('/')) {
    server.origin = server.origin.slice(0, -1)
    logger.warn(
      colors.yellow(
        `${colors.bold('(!)')} server.origin should not end with "/". Using "${
          server.origin
        }" instead.`
      )
    )
  }

  return server
}

async function restartServer(server: ViteDevServer) {
  // @ts-ignore
  global.__vite_start_time = performance.now()
  const { port: prevPort, host: prevHost } = server.config.server

  await server.close()

  let inlineConfig = server.config.inlineConfig
  if (server._forceOptimizeOnRestart) {
    inlineConfig = mergeConfig(inlineConfig, {
      optimizeDeps: {
        force: true
      }
    })
  }

  let newServer = null
  try {
    newServer = await createServer(inlineConfig)
  } catch (err: any) {
    server.config.logger.error(err.message, {
      timestamp: true
    })
    return
  }

  for (const key in newServer) {
    if (key === '_restartPromise') {
      // prevent new server `restart` function from calling
      // @ts-ignore
      newServer[key] = server[key]
    } else {
      // @ts-ignore
      server[key] = newServer[key]
    }
  }

  const {
    logger,
    server: { port, host, middlewareMode }
  } = server.config
  if (!middlewareMode) {
    await server.listen(port, true)
    logger.info('server restarted.', { timestamp: true })
    if (port !== prevPort || host !== prevHost) {
      logger.info('')
      server.printUrls()
    }
  } else {
    logger.info('server restarted.', { timestamp: true })
  }

  // new server (the current server) can restart now
  newServer._restartPromise = null
}

async function updateCjsSsrExternals(server: ViteDevServer) {
  if (!server._ssrExternals) {
    let knownImports: string[] = []

    // Important! We use the non-ssr optimized deps to find known imports
    // Only the explicitly defined deps are optimized during dev SSR, so
    // we use the generated list from the scanned deps in regular dev.
    // This is part of the v2 externalization heuristics and it is kept
    // for backwards compatibility in case user needs to fallback to the
    // legacy scheme. It may be removed in a future v3 minor.
    const depsOptimizer = getDepsOptimizer(server.config, false) // non-ssr

    if (depsOptimizer) {
      await depsOptimizer.scanProcessing
      knownImports = [
        ...Object.keys(depsOptimizer.metadata.optimized),
        ...Object.keys(depsOptimizer.metadata.discovered)
      ]
    }
    server._ssrExternals = cjsSsrResolveExternals(server.config, knownImports)
  }
}
