declare const __MODE__: string
declare const __DEFINES__: Record<string, any>

const context = (() => {
  if (typeof globalThis !== 'undefined') {
    return globalThis
  } else if (typeof self !== 'undefined') {
    return self
  } else if (typeof window !== 'undefined') {
    return window
  } else {
    return Function('return this')()
  }
})()

// ***主要是config.define中所定义的然后在clientInjections插件中把__DEFINES__给替换掉了，之后在浏览器端就有这些定义的变量啦 ~***
// assign defines
const defines = __DEFINES__
Object.keys(defines).forEach((key) => {
  const segments = key.split('.')
  let target = context
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    if (i === segments.length - 1) {
      target[segment] = defines[key]
    } else {
      target = target[segment] || (target[segment] = {})
    }
  }
})
