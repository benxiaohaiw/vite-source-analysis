import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import glob from 'fast-glob'
import type { Loader, OnLoadResult, Plugin } from 'esbuild'
import { build, transform } from 'esbuild'
import colors from 'picocolors'
import type { ResolvedConfig } from '..'
import { JS_TYPES_RE, KNOWN_ASSET_TYPES, SPECIAL_QUERY_RE } from '../constants'
import {
  cleanUrl,
  createDebugger,
  dataUrlRE,
  externalRE,
  isObject,
  isOptimizable,
  moduleListContains,
  multilineCommentsRE,
  normalizePath,
  singlelineCommentsRE,
  virtualModulePrefix,
  virtualModuleRE
} from '../utils'
import type { PluginContainer } from '../server/pluginContainer'
import { createPluginContainer } from '../server/pluginContainer'
import { transformGlobImport } from '../plugins/importMetaGlob'

type ResolveIdOptions = Parameters<PluginContainer['resolveId']>[2]

const debug = createDebugger('vite:deps')

const htmlTypesRE = /\.(html|vue|svelte|astro)$/

// A simple regex to detect import sources. This is only used on
// <script lang="ts"> blocks in vue (setup only) or svelte files, since
// seemingly unused imports are dropped by esbuild when transpiling TS which
// prevents it from crawling further.
// We can't use es-module-lexer because it can't handle TS, and don't want to
// use Acorn because it's slow. Luckily this doesn't have to be bullet proof
// since even missed imports can be caught at runtime, and false positives will
// simply be ignored.
export const importsRE =
  /(?<!\/\/.*)(?<=^|;|\*\/)\s*import(?!\s+type)(?:[\w*{}\n\r\t, ]+from\s*)?\s*("[^"]+"|'[^']+')\s*(?=$|;|\/\/|\/\*)/gm

export async function scanImports(config: ResolvedConfig): Promise<{
  deps: Record<string, string>
  missing: Record<string, string>
}> {
  // Only used to scan non-ssr code

  const start = performance.now()

  let entries: string[] = []

  // 明确的入口规则
  const explicitEntryPatterns = config.optimizeDeps.entries
  const buildInput = config.build.rollupOptions?.input

  if (explicitEntryPatterns) {
    entries = await globEntries(explicitEntryPatterns, config)
  } else if (buildInput) {
    const resolvePath = (p: string) => path.resolve(config.root, p)
    if (typeof buildInput === 'string') {
      entries = [resolvePath(buildInput)]
    } else if (Array.isArray(buildInput)) {
      entries = buildInput.map(resolvePath)
    } else if (isObject(buildInput)) {
      entries = Object.values(buildInput).map(resolvePath)
    } else {
      throw new Error('invalid rollupOptions.input value.')
    }
  } else {
    // ***
    // 默认情况下还是以**/*.html为规则在config.root下进行查找
    // ***
    entries = await globEntries('**/*.html', config)
  }

  // 不应扫描不受支持的入口文件类型和虚拟文件依赖项。
  // Non-supported entry file types and virtual files should not be scanned for
  // dependencies.
  entries = entries.filter(
    (entry) => isScannable(entry) && fs.existsSync(entry)
  )
  // 过滤出可扫描且入口文件是存在的入口文件路径

  if (!entries.length) {
    if (!explicitEntryPatterns && !config.optimizeDeps.include) {
      config.logger.warn(
        colors.yellow(
          '(!) Could not auto-determine entry point from rollupOptions or html files ' +
            'and there are no explicit optimizeDeps.include patterns. ' +
            'Skipping dependency pre-bundling.'
        )
      )
    }
    return { deps: {}, missing: {} }
  } else {
    debug(`Crawling dependencies using entries:\n  ${entries.join('\n  ')}`)
  }

  const deps: Record<string, string> = {}
  const missing: Record<string, string> = {}
  const container = await createPluginContainer(config) // ***再一次创建插件容器
  const plugin = esbuildScanPlugin(config, container, deps, missing, entries) // 使用esbuildScanPlugin

  const { plugins = [], ...esbuildOptions } =
    config.optimizeDeps?.esbuildOptions ?? {}

  // ***
  // 这一过程主要是利用esbuild向deps和missing中添加信息，其中最核心就是使用esbuildScanPlugin来去完成收集信息任务的
  // ***
  await Promise.all(
    entries.map((entry) =>
      build({
        absWorkingDir: process.cwd(),
        write: false,
        entryPoints: [entry], // 以entry为每次的单个入口点，***那么默认是以index.html作为入口点的***
        bundle: true,
        format: 'esm', // esm
        logLevel: 'error',
        plugins: [...plugins, plugin], // 最后的是vite内置的esbuildScanPlugin
        ...esbuildOptions
      })
    )
  )

  debug(`Scan completed in ${(performance.now() - start).toFixed(2)}ms:`, deps)

  return {
    // Ensure a fixed order so hashes are stable and improve logs
    deps: orderedDependencies(deps), // 对依赖项间进行排序
    missing
  }
}

function orderedDependencies(deps: Record<string, string>) {
  const depsList = Object.entries(deps)
  // Ensure the same browserHash for the same set of dependencies
  depsList.sort((a, b) => a[0].localeCompare(b[0]))
  return Object.fromEntries(depsList)
}

function globEntries(pattern: string | string[], config: ResolvedConfig) {
  return glob(pattern, {
    cwd: config.root,
    ignore: [
      '**/node_modules/**',
      `**/${config.build.outDir}/**`,
      // if there aren't explicit entries, also ignore other common folders
      ...(config.optimizeDeps.entries
        ? []
        : [`**/__tests__/**`, `**/coverage/**`])
    ],
    absolute: true,
    suppressErrors: true // suppress EACCES errors
  })
}

const scriptModuleRE =
  /(<script\b[^>]*type\s*=\s*(?:"module"|'module')[^>]*>)(.*?)<\/script>/gims
export const scriptRE = /(<script\b(?:\s[^>]*>|>))(.*?)<\/script>/gims
export const commentRE = /<!--.*?-->/gs
const srcRE = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im
const typeRE = /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im
const langRE = /\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im
const contextRE = /\bcontext\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im

function esbuildScanPlugin(
  config: ResolvedConfig,
  container: PluginContainer,
  depImports: Record<string, string>,
  missing: Record<string, string>,
  entries: string[]
): Plugin {
  const seen = new Map<string, string | undefined>()

  // 使用插件容器中的resolveId钩子进行解析
  const resolve = async (
    id: string,
    importer?: string,
    options?: ResolveIdOptions
  ) => {
    const key = id + (importer && path.dirname(importer))
    if (seen.has(key)) {
      return seen.get(key)
    }
    const resolved = await container.resolveId(
      id,
      importer && normalizePath(importer),
      {
        ...options,
        scan: true
      }
    )
    const res = resolved?.id
    seen.set(key, res)
    return res
  }

  const include = config.optimizeDeps?.include
  const exclude = [
    ...(config.optimizeDeps?.exclude || []),
    '@vite/client',
    '@vite/env'
  ]

  const externalUnlessEntry = ({ path }: { path: string }) => ({
    path,
    external: !entries.includes(path)
  })

  return {
    name: 'vite:dep-scan',
    setup(build) {
      const scripts: Record<string, OnLoadResult> = {}

      // ***
      // 外部化的话那么esbuild就不会对其进行分析处理了，直接作为外部依赖引入即可 -> 这就是外部化
      // ***

      // /^(https?:)?\/\//的resolve
      // external urls
      build.onResolve({ filter: externalRE }, ({ path }) => ({
        path,
        external: true // 外部化
      }))

      // /^\s*data:/i的resolve
      // data urls
      build.onResolve({ filter: dataUrlRE }, ({ path }) => ({
        path,
        external: true // 外部化
      }))

      // /^virtual-module:.*/的resolve
      // local scripts (`<script>` in Svelte and `<script setup>` in Vue)
      build.onResolve({ filter: virtualModuleRE }, ({ path }) => {
        return {
          // strip prefix to get valid filesystem path so esbuild can resolve imports in the file
          path: path.replace(virtualModulePrefix, ''), // ***返回缓存的路径***
          namespace: 'script'
        }
      })

      // 任意但是命名空间是script的load
      build.onLoad({ filter: /.*/, namespace: 'script' }, ({ path }) => {
        return scripts[path] // 直接把路径对应的缓存内容交给esbuild就可以啦 ~，它拿到之后会直接再次进行分析的
      })

      // ***比如.vue***
      // /\.(html|vue|svelte|astro)$/的resolve，主要是提取script中的导入内容
      // html types: extract script contents -----------------------------------
      build.onResolve({ filter: htmlTypesRE }, async ({ path, importer }) => {
        const resolved = await resolve(path, importer) // 使用插件容器的resolveId钩子进行解析出路径
        if (!resolved) return
        // It is possible for the scanner to scan html types in node_modules.
        // If we can optimize this html type, skip it so it's handled by the
        // bare import resolve, and recorded as optimization dep.
        if (
          resolved.includes('node_modules') &&
          isOptimizable(resolved, config.optimizeDeps)
        )
          return
        return {
          path: resolved, // 把路径返回
          namespace: 'html' // 并告知是html命名空间
        }
      })


      // ***比如.vue***
      // /\.(html|vue|svelte|astro)$/且命名空间是html的load
      // extract scripts inside HTML-like files and treat it as a js module
      build.onLoad(
        { filter: htmlTypesRE, namespace: 'html' },
        async ({ path }) => {
          let raw = fs.readFileSync(path, 'utf-8') // 读取.html|vue等文件内容
          // Avoid matching the content of the comment
          raw = raw.replace(commentRE, '<!---->') // 把注释内容全部替换为空注释标签<!---->
          const isHtml = path.endsWith('.html') // 是否html
          const regex = isHtml ? scriptModuleRE : scriptRE
          //  /(<script\b[^>]*type\s*=\s*(?:"module"|'module')[^>]*>)(.*?)<\/script>/gims 前者
          // /(<script\b(?:\s[^>]*>|>))(.*?)<\/script>/gims 后者
          regex.lastIndex = 0
          let js = '' // 空串
          let scriptId = 0
          let match: RegExpExecArray | null
          while ((match = regex.exec(raw))) {
            const [, openTag, content] = match // content为script标签的内容
            const typeMatch = openTag.match(typeRE) // /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im
            const type =
              typeMatch && (typeMatch[1] || typeMatch[2] || typeMatch[3])
            const langMatch = openTag.match(langRE)
            const lang =
              langMatch && (langMatch[1] || langMatch[2] || langMatch[3])
            // skip type="application/ld+json" and other non-JS types
            if (
              type &&
              !(
                type.includes('javascript') ||
                type.includes('ecmascript') ||
                type === 'module'
              )
            ) {
              continue
            }
            let loader: Loader = 'js'
            if (lang === 'ts' || lang === 'tsx' || lang === 'jsx') {
              loader = lang
            } else if (path.endsWith('.astro')) {
              loader = 'ts'
            }
            const srcMatch = openTag.match(srcRE) // /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im
            if (srcMatch) {
              const src = srcMatch[1] || srcMatch[2] || srcMatch[3]
              js += `import ${JSON.stringify(src)}\n` // ***拼接代码***
            } else if (content.trim()) {
              // The reason why virtual modules are needed:
              // 1. There can be module scripts (`<script context="module">` in Svelte and `<script>` in Vue)
              // or local scripts (`<script>` in Svelte and `<script setup>` in Vue)
              // 2. There can be multiple module scripts in html
              // We need to handle these separately in case variable names are reused between them

              // append imports in TS to prevent esbuild from removing them
              // since they may be used in the template
              const contents =
                content + // ***直接把script标签中的内容做拼接***
                (loader.startsWith('ts') ? extractImportPaths(content) : '') // 是ts的话则提取导入路径做一个字符串的拼接

              const key = `${path}?id=${scriptId++}`
              if (contents.includes('import.meta.glob')) {
                let transpiledContents
                // transpile because `transformGlobImport` only expects js
                if (loader !== 'js') {
                  transpiledContents = (await transform(contents, { loader }))
                    .code
                } else {
                  transpiledContents = contents
                }

                scripts[key] = {
                  loader: 'js', // since it is transpiled
                  contents:
                    (
                      await transformGlobImport(
                        transpiledContents,
                        path,
                        config.root,
                        resolve
                      )
                    )?.s.toString() || transpiledContents,
                  pluginData: {
                    htmlType: { loader }
                  }
                }
              } else {
                scripts[key] = { // 做一个缓存
                  loader,
                  contents,
                  pluginData: {
                    htmlType: { loader }
                  }
                }
              }

              const virtualModulePath = JSON.stringify(
                virtualModulePrefix + key
              )

              const contextMatch = openTag.match(contextRE) // /\bcontext\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im
              const context =
                contextMatch &&
                (contextMatch[1] || contextMatch[2] || contextMatch[3])

              // Especially for Svelte files, exports in <script context="module"> means module exports,
              // exports in <script> means component props. To avoid having two same export name from the
              // star exports, we need to ignore exports in <script>
              if (path.endsWith('.svelte') && context !== 'module') {
                js += `import ${virtualModulePath}\n`
              } else {
                js += `export * from ${virtualModulePath}\n` // ***.vue是做了一个这个，那么就可以利用上面的virtualModuleRE正则进行resolve了
                // 之后再进行从缓存中获取script的内容交给esbuild，它就又可以再次进行分析啦 ~***
              }
            }
          }

          // This will trigger incorrectly if `export default` is contained
          // anywhere in a string. Svelte and Astro files can't have
          // `export default` as code so we know if it's encountered it's a
          // false positive (e.g. contained in a string)
          if (!path.endsWith('.vue') || !js.includes('export default')) {
            js += '\nexport default {}'
          } // 做一个默认导出空对象

          return {
            loader: 'js',
            contents: js
          }
        }
      )

      // 主要还是进行下面的这个操作的（做记录且对依赖包进行外部化）

      // ***
      // 对于依赖包而言是直接外部化的，所以esbuild不会对它进行分析的，直接作为外部依赖引入的
      // ***

      // 裸导入也就是直接导入的包：记录且外部化
      // bare imports: record and externalize ----------------------------------
      build.onResolve(
        {
          // avoid matching windows volume
          filter: /^[\w@][^:]/ // 以@字符或单个小写字母字符开头进行匹配
        },
        async ({ path: id, importer, pluginData }) => {
          if (moduleListContains(exclude, id)) {
            return externalUnlessEntry({ path: id })
          }
          if (depImports[id]) {
            return externalUnlessEntry({ path: id })
          }
          const resolved = await resolve(id, importer, {
            custom: {
              depScan: { loader: pluginData?.htmlType?.loader }
            }
          }) // 使用插件容器的resolveId钩子函数进行解析路径

          if (resolved) {
            if (shouldExternalizeDep(resolved, id)) {
              return externalUnlessEntry({ path: id })
            }
            if (resolved.includes('node_modules') || include?.includes(id)) {
              // dependency or forced included, externalize and stop crawling
              if (isOptimizable(resolved, config.optimizeDeps)) {

                // ***
                // 缓存，其实就是记录到外面传入的deps对象中
                // 包名 => 包入口文件路径
                // ***
                depImports[id] = resolved
              }

              // ***
              // ***最重要的一步：对此依赖包进行外部化操作***
              // ***
              return externalUnlessEntry({ path: id })

            } else if (isScannable(resolved)) {
              const namespace = htmlTypesRE.test(resolved) ? 'html' : undefined
              // linked package, keep crawling
              return {
                path: path.resolve(resolved),
                namespace
              }
            } else {
              return externalUnlessEntry({ path: id })
            }
          } else {
            // ***
            // 到这里说明这个包引入了，但是没有解析到它的路径存在，可以说明此包没有被安装！
            missing[id] = normalizePath(importer) // 那么存入missing中，对于之后的逻辑可以做个提示说明此包可能没有被安装！
          }
        }
      )

      // Externalized file types -----------------------------------------------
      // these are done on raw ids using esbuild's native regex filter so it
      // should be faster than doing it in the catch-all via js
      // they are done after the bare import resolve because a package name
      // may end with these extensions

      // css & json & wasm
      build.onResolve(
        {
          filter: /\.(css|less|sass|scss|styl|stylus|pcss|postcss|json|wasm)$/
        },
        externalUnlessEntry
      )

      // 所知道的资源类型
      // known asset types
      build.onResolve(
        {
          filter: new RegExp(`\\.(${KNOWN_ASSET_TYPES.join('|')})$`)
        },
        externalUnlessEntry
      )

      // 所知道的vite query类型
      // known vite query types: ?worker, ?raw
      build.onResolve({ filter: SPECIAL_QUERY_RE }, ({ path }) => ({ // /[\?&](?:worker|sharedworker|raw|url)\b/
        path,
        external: true
      }))

      // ***重要***
      // ***捕获所有***
      // catch all -------------------------------------------------------------

      build.onResolve(
        {
          filter: /.*/
        },
        async ({ path: id, importer, pluginData }) => {
          // use vite resolver to support urls and omitted extensions
          const resolved = await resolve(id, importer, {
            custom: {
              depScan: { loader: pluginData?.htmlType?.loader }
            }
          })
          if (resolved) {
            if (shouldExternalizeDep(resolved, id) || !isScannable(resolved)) {
              return externalUnlessEntry({ path: id })
            }

            const namespace = htmlTypesRE.test(resolved) ? 'html' : undefined

            return {
              path: path.resolve(cleanUrl(resolved)),
              namespace
            }
          } else {
            // resolve failed... probably unsupported type
            return externalUnlessEntry({ path: id })
          }
        }
      )

      // for jsx/tsx, we need to access the content and check for
      // presence of import.meta.glob, since it results in import relationships
      // but isn't crawled by esbuild.
      build.onLoad({ filter: JS_TYPES_RE }, ({ path: id }) => { // /\.(?:j|t)sx?$|\.mjs$/
        let ext = path.extname(id).slice(1)
        if (ext === 'mjs') ext = 'js'

        let contents = fs.readFileSync(id, 'utf-8') // ***读取文件内容***
        if (ext.endsWith('x') && config.esbuild && config.esbuild.jsxInject) {
          contents = config.esbuild.jsxInject + `\n` + contents
        }

        const loader =
          config.optimizeDeps?.esbuildOptions?.loader?.[`.${ext}`] ||
          (ext as Loader)

        return {
          loader,
          contents
        }
      })
    }
  }
}

/**
 * when using TS + (Vue + `<script setup>`) or Svelte, imports may seem
 * unused to esbuild and dropped in the build output, which prevents
 * esbuild from crawling further.
 * the solution is to add `import 'x'` for every source to force
 * esbuild to keep crawling due to potential side effects.
 */
function extractImportPaths(code: string) {
  // empty singleline & multiline comments to avoid matching comments
  code = code
    .replace(multilineCommentsRE, '/* */')
    .replace(singlelineCommentsRE, '')

  let js = ''
  let m
  while ((m = importsRE.exec(code)) != null) {
    // This is necessary to avoid infinite loops with zero-width matches
    if (m.index === importsRE.lastIndex) {
      importsRE.lastIndex++
    }
    js += `\nimport ${m[1]}`
  }
  return js
}

function shouldExternalizeDep(resolvedId: string, rawId: string): boolean {
  // not a valid file path
  if (!path.isAbsolute(resolvedId)) {
    return true
  }
  // virtual id
  if (resolvedId === rawId || resolvedId.includes('\0')) {
    return true
  }
  return false
}

function isScannable(id: string): boolean {
  return JS_TYPES_RE.test(id) || htmlTypesRE.test(id)
}
