#!/usr/bin/env node
/**
 * Собрать многофайловые исходники из src/ в однофайловый клиентский модуль lib/client.js, нужный Desktop.
 *
 * Обрабатываются только строки `import` / `export` в нулевой колонке; остальное (включая CSS-шаблонные строки)
 * переносится как есть. Модули с относительными путями встраиваются в тот же файл; «голые» имена пакетов (например, react)
 * уходят в require загрузчика модулей, потому что это общая база хоста.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = resolve(ROOT, 'src')
const ENTRY = 'client/index.js'
const OUT = resolve(ROOT, 'lib/client.js')
const PACKAGE_NAME = 'dsh-workbench-project-console'

const IMPORT_DEFAULT = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+'([^']+)'\s*;?$/
const IMPORT_NAMED = /^import\s*\{([^}]*)\}\s*from\s+'([^']+)'\s*;?$/
const IMPORT_SIDE = /^import\s+'([^']+)'\s*;?$/
const EXPORT_DECL = /^export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)\b(.*)$/
const EXPORT_LIST = /^export\s*\{([^}]*)\}\s*;?$/
const BARE = /^[A-Za-z@][\w./@-]*$/

const modules = new Map()

const toModuleId = (absPath) => {
  const relative = absPath.slice(SRC.length + 1).split('\\').join('/')
  if (relative.startsWith('..')) throw new Error(`build-client: ${absPath} находится вне src/`)
  return relative
}

const namedBindings = (list) => list.split(',').map((entry) => entry.trim()).filter(Boolean)
  .map((entry) => {
    const alias = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(entry)
    return alias ? `${alias[1]}: ${alias[2]}` : entry
  }).join(', ')

/** Превратить строку import в `__require(...)`; относительные модули сначала собираются рекурсивно. */
async function resolveImport(spec, fromAbs, id) {
  if (!spec.startsWith('.')) {
    if (!BARE.test(spec)) throw new Error(`build-client: ${id} ссылается на неподдерживаемый идентификатор модуля ${spec}`)
    return spec
  }
  const base = resolve(dirname(fromAbs), spec)
  const absolute = base.endsWith('.js') ? base : `${base}.js`
  return collect(absolute)
}

async function collect(absPath) {
  const id = toModuleId(absPath)
  const existing = modules.get(id)
  if (existing) return id

  let source
  try {
    source = await readFile(absPath, 'utf8')
  } catch {
    throw new Error(`build-client: не найден ${absPath}`)
  }

  const pending = { id, body: [], exports: [] }
  modules.set(id, pending) // регистрируем сразу, чтобы модули могли ссылаться друг на друга

  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (line !== trimmed) {
      pending.body.push(line)
      continue
    }
    if (trimmed.startsWith('import ')) {
      let match = IMPORT_DEFAULT.exec(trimmed)
      if (match) {
        pending.body.push(`const ${match[1]} = __require(${JSON.stringify(await resolveImport(match[2], absPath, id))})`)
        continue
      }
      match = IMPORT_NAMED.exec(trimmed)
      if (match) {
        pending.body.push(`const { ${namedBindings(match[1])} } = __require(${JSON.stringify(await resolveImport(match[2], absPath, id))})`)
        continue
      }
      match = IMPORT_SIDE.exec(trimmed)
      if (match) {
        pending.body.push(`__require(${JSON.stringify(await resolveImport(match[1], absPath, id))})`)
        continue
      }
      throw new Error(`build-client: в ${id} нераспознанная строка import: ${trimmed}`)
    }
    if (trimmed.startsWith('export ')) {
      const reexport = EXPORT_LIST.exec(trimmed)
      if (reexport) {
        for (const name of namedBindings(reexport[1]).split(',').map((entry) => entry.trim()).filter(Boolean)) {
          const alias = /^([A-Za-z_$][\w$]*):\s*([A-Za-z_$][\w$]*)$/.exec(name)
          pending.exports.push(alias ? alias[1] : name)
        }
        continue
      }
      const match = EXPORT_DECL.exec(trimmed)
      if (!match) throw new Error(`build-client: ${id} поддерживает только export function/class/const/let/var или export { a, b }: ${trimmed}`)
      pending.exports.push(match[2])
      pending.body.push(`${match[1]} ${match[2]}${match[3]}`)
      continue
    }
    pending.body.push(line)
  }
  return id
}

const entryId = await collect(resolve(SRC, ENTRY))

const indent = (line) => (line === '' ? '' : `    ${line}`)
const rendered = [...modules.values()].map((pending) => {
  const body = pending.body.map(indent)
  if (pending.exports.length > 0) body.push(`    module.exports = { ${pending.exports.join(', ')} }`)
  return `  __factories[${JSON.stringify(pending.id)}] = function (exports, module, __require) {\n${body.join('\n')}\n  }`
})

const output = `// Этот файл собран скриптом scripts/build-client.mjs из src/ — не редактируйте его вручную.
window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE_NAME)},
  factory: (require) => {
    const __factories = Object.create(null)
    const __cache = Object.create(null)
    function __require(id) {
      if (__factories[id] === undefined) return require(id)
      if (__cache[id] !== undefined) return __cache[id].exports
      const module = { exports: {} }
      __cache[id] = module
      __factories[id](module.exports, module, __require)
      return module.exports
    }
${rendered.join('\n')}
    return __require(${JSON.stringify(entryId)})
  }
})
`

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, output, 'utf8')
process.stdout.write(`build-client: модулей ${modules.size} -> ${OUT} (${Buffer.byteLength(output)} байт)\n`)
