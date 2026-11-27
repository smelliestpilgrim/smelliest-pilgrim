// Node loader: map @zos/* and ZML imports to mocks, add .js to extensionless relative imports.
import { pathToFileURL } from 'node:url'
import path from 'node:path'
const here = path.dirname(new URL(import.meta.url).pathname)
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('@zos/')) return { url: pathToFileURL(path.join(here, 'mock', spec.slice(5) + '.mjs')).href, shortCircuit: true }
  if (spec === '@zeppos/zml/base-page') return { url: pathToFileURL(path.join(here, 'mock', 'zml-page.mjs')).href, shortCircuit: true }
  if ((spec.startsWith('./') || spec.startsWith('../')) && !path.extname(spec)) spec += '.js'
  return next(spec, ctx)
}
export async function load(url, ctx, next) {
  // watch sources are ESM without "type":"module"
  if (/\/watch(-[0-9.]+)?\//.test(url) && url.split('?')[0].endsWith('.js')) return next(url, { ...ctx, format: 'module' })
  return next(url, ctx)
}
