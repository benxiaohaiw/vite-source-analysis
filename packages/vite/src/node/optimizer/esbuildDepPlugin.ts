import path from 'node:path'
import type { ImportKind, Plugin } from 'esbuild'
import { KNOWN_ASSET_TYPES } from '../constants'
import { getDepOptimizationConfig } from '..'
import type { ResolvedConfig } from '..'
import {
  flattenId,
  isBuiltin,
  isExternalUrl,
  moduleListContains,
  normalizePath
} from '../utils'
import { browserExternalId, optionalPeerDepId } from '../plugins/resolve'
import type { ExportsData } from '.'

const externalWithConversionNamespace =
  'vite:dep-pre-bundle:external-conversion'
const convertedExternalPrefix = 'vite-dep-pre-bundle-external:'

const externalTypes = [
  'css',
  // supported pre-processor types
  'less',
  'sass',
  'scss',
  'styl',
  'stylus',
  'pcss',
  'postcss',
  // wasm
  'wasm',
  // known SFC types
  'vue',
  'svelte',
  'marko',
  'astro',
  // JSX/TSX may be configured to be compiled differently from how esbuild
  // handles it by default, so exclude them as well
  'jsx',
  'tsx',
  ...KNOWN_ASSET_TYPES
]

export function esbuildDepPlugin(
  qualified: Record<string, string>,
  exportsData: Record<string, ExportsData>,
  external: string[],
  config: ResolvedConfig,
  ssr: boolean
): Plugin {
  const { extensions } = getDepOptimizationConfig(config, ssr)

  // remove optimizable extensions from `externalTypes` list
  const allExternalTypes = extensions
    ? externalTypes.filter((type) => !extensions?.includes('.' + type))
    : externalTypes

  // default resolver which prefers ESM
  const _resolve = config.createResolver({ asSrc: false, scan: true })

  // cjs resolver that prefers Node
  const _resolveRequire = config.createResolver({
    asSrc: false,
    isRequire: true,
    scan: true
  })

  const resolve = (
    id: string,
    importer: string,
    kind: ImportKind,
    resolveDir?: string
  ): Promise<string | undefined> => {
    let _importer: string
    // explicit resolveDir - this is passed only during yarn pnp resolve for
    // entries
    if (resolveDir) {
      _importer = normalizePath(path.join(resolveDir, '*'))
    } else {
      // map importer ids to file paths for correct resolution
      _importer = importer in qualified ? qualified[importer] : importer
    }
    const resolver = kind.startsWith('require') ? _resolveRequire : _resolve
    return resolver(id, _importer, undefined, ssr)
  }

  const resolveResult = (id: string, resolved: string) => {
    if (resolved.startsWith(browserExternalId)) {
      return {
        path: id,
        namespace: 'browser-external'
      }
    }
    if (resolved.startsWith(optionalPeerDepId)) {
      return {
        path: resolved,
        namespace: 'optional-peer-dep'
      }
    }
    if (ssr && isBuiltin(resolved)) {
      return
    }
    if (isExternalUrl(resolved)) {
      return {
        path: resolved,
        external: true
      }
    }
    return {
      path: path.resolve(resolved)
      // 没有带命名空间
    }
  }

  return {
    name: 'vite:dep-pre-bundle',
    setup(build) {
      // externalize assets and commonly known non-js file types
      // See #8459 for more details about this require-import conversion
      build.onResolve(
        {
          filter: new RegExp(`\\.(` + allExternalTypes.join('|') + `)(\\?.*)?$`)
        },
        async ({ path: id, importer, kind }) => {
          // if the prefix exist, it is already converted to `import`, so set `external: true`
          if (id.startsWith(convertedExternalPrefix)) {
            return {
              path: id.slice(convertedExternalPrefix.length),
              external: true
            }
          }

          const resolved = await resolve(id, importer, kind)
          if (resolved) {
            if (kind === 'require-call') {
              // here it is not set to `external: true` to convert `require` to `import`
              return {
                path: resolved,
                namespace: externalWithConversionNamespace
              }
            }
            return {
              path: resolved,
              external: true
            }
          }
        }
      )
      build.onLoad(
        { filter: /./, namespace: externalWithConversionNamespace },
        (args) => {
          // import itself with prefix (this is the actual part of require-import conversion)
          return {
            contents:
              `export { default } from "${convertedExternalPrefix}${args.path}";` +
              `export * from "${convertedExternalPrefix}${args.path}";`,
            loader: 'js'
          }
        }
      )

      function resolveEntry(id: string) {
        const flatId = flattenId(id)
        if (flatId in qualified) {
          return {
            path: flatId,
            namespace: 'dep' // 入口是会带dep的命名空间
          }
        }
      }

      // 对入口点是依赖包名进行resolve
      build.onResolve(
        { filter: /^[\w@][^:]/ },
        async ({ path: id, importer, kind }) => {
          if (moduleListContains(external, id)) {
            return {
              path: id,
              external: true
            }
          }

          // ensure esbuild uses our resolved entries
          let entry: { path: string; namespace: string } | undefined
          // if this is an entry, return entry namespace resolve result
          if (!importer) { // 没有导入者说明是入口点
            if ((entry = resolveEntry(id))) return entry // 带有dep的命名空间
            // check if this is aliased to an entry - also return entry namespace
            const aliased = await _resolve(id, undefined, true)
            if (aliased && (entry = resolveEntry(aliased))) {
              return entry // 也是带有dep的命名空间
            }
          }

          // 说明有导入者且是包的话那就说明是包的依赖包啦 ~
          // use vite's own resolver
          const resolved = await resolve(id, importer, kind) // 还是使用vite自已的解析者
          if (resolved) {
            return resolveResult(id, resolved) // ***内置包进行浏览器外部化了等一些操作***
            // **此方法重点看**
            // 会返回不带dep命名空间的
          }
        }
      )

      // ***
      // ***
      // 对于入口文件，我们将自己读取它，并***构造一个代理模块来保留入口的原始id而不是文件路径***，***以便esbuild输出所需的输出文件结构***。
      // 有必要进行重新导出以将虚拟代理模块从实际模块中分离出来，因为实际模块可能通过相对导入得到引用 - 如果我们不分离代理和实际模块，esbuild将创建相同模块的重复副本！
      // ***
      // ***
      // For entry files, we'll read it ourselves and construct a proxy module
      // to retain the entry's raw id instead of file path so that esbuild
      // outputs desired output file structure.
      // It is necessary to do the re-exporting to separate the virtual proxy
      // module from the actual module since the actual module may get
      // referenced via relative imports - if we don't separate the proxy and
      // the actual module, esbuild will create duplicated copies of the same
      // module!
      const root = path.resolve(config.root)
      build.onLoad({ filter: /.*/, namespace: 'dep' }, ({ path: id }) => { // 只有入口返回的才有dep的命名空间，其它的这里并不进行去处理（交给esbuild自己去处理啦 ~）
        // 原因在上方依赖包的resolve那里的resolveResult里面其余的都是不带有dep命名空间的
        const entryFile = qualified[id]

        let relativePath = normalizePath(path.relative(root, entryFile))
        if (
          !relativePath.startsWith('./') &&
          !relativePath.startsWith('../') &&
          relativePath !== '.'
        ) {
          relativePath = `./${relativePath}`
        }

        let contents = ''
        const { hasImports, exports, hasReExports } = exportsData[id]
        if (!hasImports && !exports.length) {
          // cjs
          contents += `export default require("${relativePath}");`
          // ***
          // 在这里可以联想到在main.js中使用element-ui依赖的throttle-debounce包时
          // throttle-debounce作为入口点依赖最终打包结果是export { xxx as default }
          // 其中xxx就是require(relativePath)的结果也就是throttle-debounce包入口文件中的module.exports = {}这个结果
          // 看到这里我们就需要想到vite所做的互操作的原因，因为在使用此依赖包时可能会命名导入{ throttle }这样，但是它默认导出的是module.exports结果
          // 所以你可以看到vite互操作里面就会进行解构赋值以支持命名导入！
          // ***
        } else {
          if (exports.includes('default')) {
            contents += `import d from "${relativePath}";export default d;`
          }
          if (hasReExports || exports.length > 1 || exports[0] !== 'default') {
            contents += `\nexport * from "${relativePath}"`
          }
        }

        return {
          loader: 'js',
          contents,
          resolveDir: root
        }
      })

      // node的内置模块浏览器是不能加载的，所以就需要做兼容处理
      build.onLoad(
        { filter: /.*/, namespace: 'browser-external' },
        ({ path }) => {
          if (config.isProduction) {
            return {
              contents: 'module.exports = {}'
            }
          } else {
            return {
              // Return in CJS to intercept named imports. Use `Object.create` to
              // create the Proxy in the prototype to workaround esbuild issue. Why?
              //
              // In short, esbuild cjs->esm flow:
              // 1. Create empty object using `Object.create(Object.getPrototypeOf(module.exports))`.
              // 2. Assign props of `module.exports` to the object.
              // 3. Return object for ESM use.
              //
              // If we do `module.exports = new Proxy({}, {})`, step 1 returns empty object,
              // step 2 does nothing as there's no props for `module.exports`. The final object
              // is just an empty object.
              //
              // Creating the Proxy in the prototype satisfies step 1 immediately, which means
              // the returned object is a Proxy that we can intercept.
              //
              // Note: Skip keys that are accessed by esbuild and browser devtools.
              contents: `\
module.exports = Object.create(new Proxy({}, {
  get(_, key) {
    if (
      key !== '__esModule' &&
      key !== '__proto__' &&
      key !== 'constructor' &&
      key !== 'splice'
    ) {
      console.warn(\`Module "${path}" has been externalized for browser compatibility. Cannot access "${path}.\${key}" in client code.\`)
    }
  }
}))`
            }
          }
        }
      )

      build.onLoad(
        { filter: /.*/, namespace: 'optional-peer-dep' },
        ({ path }) => {
          if (config.isProduction) {
            return {
              contents: 'module.exports = {}'
            }
          } else {
            const [, peerDep, parentDep] = path.split(':')
            return {
              contents: `throw new Error(\`Could not resolve "${peerDep}" imported by "${parentDep}". Is it installed?\`)`
            }
          }
        }
      )
    }
  }
}

// esbuild doesn't transpile `require('foo')` into `import` statements if 'foo' is externalized
// https://github.com/evanw/esbuild/issues/566#issuecomment-735551834
export function esbuildCjsExternalPlugin(externals: string[]): Plugin {
  return {
    name: 'cjs-external',
    setup(build) {
      const escape = (text: string) =>
        `^${text.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}$`
      const filter = new RegExp(externals.map(escape).join('|'))

      build.onResolve({ filter: /.*/, namespace: 'external' }, (args) => ({
        path: args.path,
        external: true
      }))

      build.onResolve({ filter }, (args) => ({
        path: args.path,
        namespace: 'external'
      }))

      build.onLoad({ filter: /.*/, namespace: 'external' }, (args) => ({
        contents: `export * from ${JSON.stringify(args.path)}`
      }))
    }
  }
}
