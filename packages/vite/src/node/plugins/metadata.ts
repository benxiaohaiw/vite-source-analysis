import type { Plugin } from '../plugin'

export interface ChunkMetadata {
  importedAssets: Set<string>
  importedCss: Set<string>
}

/**
 * Prepares the rendered chunks to contain additional metadata during build.
 */
export function metadataPlugin(): Plugin {
  return {
    name: 'vite:build-metadata',

    async renderChunk(_code, chunk) { // 给每一个chunk对象添加属性，以便使用
      chunk.viteMetadata = {
        importedAssets: new Set(),
        importedCss: new Set()
      }
      return null
    }
  }
}
