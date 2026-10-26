#!/usr/bin/env node
/**
 * Проверить пакет воркбенча по обязательным пунктам раздела 3 «Спецификации разработки воркбенчей».
 *
 * Использование:
 *   node scripts/check-workbench-package.mjs [каталог пакета или .tgz]
 *   node scripts/check-workbench-package.mjs --tarball dsh-workbench-project-console-1.0.0.tgz
 *
 * Код выхода 0 — все обязательные пункты пройдены; 1 — есть непройденные. Рекомендации только выводятся.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..')
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const failures = []
const warnings = []
const notes = []
const pass = (message) => notes.push(`  ✓ ${message}`)
const fail = (message) => failures.push(message)
const warn = (message) => warnings.push(message)

const args = process.argv.slice(2)
let tarball = ''
let rootArg = ''
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--tarball') tarball = args[index + 1] ?? ''
  else rootArg = args[index]
}

/* ------------------------------------------------------------ Чтение пакета */

let manifest
let readPackageFile
let listFiles
let sourceLabel

if (tarball) {
  const tarballPath = isAbsolute(tarball) ? tarball : resolve(process.cwd(), tarball)
  if (!existsSync(tarballPath)) {
    console.error(`check-workbench-package: не найден ${tarballPath}`)
    process.exit(2)
  }
  sourceLabel = tarballPath
  const entries = execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' }).split('\n').filter(Boolean)
  const packageEntry = entries.find((name) => name.endsWith('/package.json') && name.split('/').length === 2)
  if (!packageEntry) {
    console.error('check-workbench-package: в tarball нет package.json')
    process.exit(2)
  }
  const prefix = packageEntry.slice(0, -'package.json'.length)
  manifest = JSON.parse(execFileSync('tar', ['-xzOf', tarballPath, packageEntry], { encoding: 'utf8' }))
  const readEntry = (relative) => execFileSync('tar', ['-xzOf', tarballPath, `${prefix}${relative}`], { encoding: 'utf8' })
  readPackageFile = readEntry
  listFiles = () => entries.filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length)).filter(Boolean)
} else {
  const root = resolve(rootArg || DEFAULT_ROOT)
  sourceLabel = root
  const manifestPath = join(root, 'package.json')
  if (!existsSync(manifestPath)) {
    console.error(`check-workbench-package: ${root} — не пакет воркбенча (нет package.json)`)
    process.exit(2)
  }
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  readPackageFile = (relative) => readFileSync(join(root, relative), 'utf8')
  const walk = (dir, prefix) => {
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const next = join(dir, entry.name)
      const relative = prefix ? `${prefix}${entry.name}` : entry.name
      if (entry.isDirectory()) out.push(...walk(next, `${relative}/`))
      else out.push(relative)
    }
    return out
  }
  listFiles = () => walk(root, '')
}

const files = listFiles()
const hasFile = (relative) => files.some((name) => name === relative || name === relative.replace(/^\.\//, ''))
const readIfPresent = (relative) => {
  if (!hasFile(relative)) return undefined
  try {
    return readPackageFile(relative)
  } catch {
    return undefined
  }
}

/* -------------------------------------------------------------- 3.2 Манифест */

if (typeof manifest.name === 'string' && manifest.name.trim()) pass(`package.json name = ${manifest.name}`)
else fail('в package.json нет поля name')

if (typeof manifest.version === 'string' && SEMVER.test(manifest.version)) pass(`version = ${manifest.version} (полный SemVer)`)
else fail(`version не полный SemVer: ${JSON.stringify(manifest.version)}`)

if (manifest.type === 'module') pass('type = module')
else warn('рекомендуется "type": "module"')

const mainEntry = manifest.main ?? manifest.exports?.['.']
const mainPath = typeof mainEntry === 'string' ? mainEntry.replace(/^\.\//, '') : ''
if (mainPath && hasFile(mainPath)) pass(`Серверная точка входа на месте: ${mainPath}`)
else fail(`main / exports["."] не указывают на существующий файл пакета: ${JSON.stringify(mainEntry)}`)
if (manifest.exports?.['.'] === undefined) fail('exports["."] должен указывать на серверную точку входа')
for (const key of ['./package.json', './cordis.patch.yml']) {
  if (manifest.exports?.[key] === undefined) warn(`рекомендуется объявить exports["${key}"]`)
}

/* --------------------------------------------------------- 3.3 Файл патча */

const patchPath = manifest.dsh?.bundle?.patch
if (typeof patchPath !== 'string') {
  fail('нет dsh.bundle.patch — пакет не активируется как слой плагина')
} else {
  const relative = patchPath.replace(/^\.\//, '')
  const text = readIfPresent(relative)
  if (text === undefined) {
    fail(`dsh.bundle.patch указывает на файл вне пакета: ${patchPath}`)
  } else {
    const withoutComments = text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n').trim()
    if (withoutComments === '') fail(`файл патча пустой (или только комментарии): ${patchPath}`)
    else {
      pass(`файл патча есть и не пустой: ${patchPath}`)
      if (!/^\s*-\s*insert\s*:/m.test(text)) fail('в файле патча нет строки insert')
      const nameMatch = /^\s*name\s*:\s*['"]?([^'"\n#]+?)['"]?\s*$/m.exec(text)
      if (!nameMatch) fail('в строке insert не указан name (нужно имя npm-пакета)')
      else if (nameMatch[1].trim() !== manifest.name) fail(`name в insert должен быть именем пакета: ожидалось ${manifest.name}, получено ${nameMatch[1].trim()}`)
      else pass(`insert.name = ${manifest.name}`)
      if (/^\s*name\s*:\s*[.\/]/m.test(text)) fail('insert.name не может быть относительным или абсолютным путём')
    }
  }
}

/* --------------------------------------------------------- 3.5 Клиентская часть */

const client = manifest.dsh?.client
if (!client || typeof client !== 'object') {
  fail('нет объявления dsh.client — клиентский модуль не загрузится')
} else {
  if (client.platform === 'web') pass('dsh.client.platform = web')
  else fail(`dsh.client.platform должен быть "web", а сейчас ${JSON.stringify(client.platform)}`)

  const inject = client.inject
  if (!Array.isArray(inject) || inject.some((item) => typeof item !== 'string')) {
    fail('dsh.client.inject должен быть массивом строк')
  } else if (!inject.includes('dsh-desktop-workbenches')) {
    fail('dsh.client.inject должен содержать "dsh-desktop-workbenches", иначе возможности воркбенча не будут готовы заранее')
  } else {
    pass(`dsh.client.inject содержит dsh-desktop-workbenches (позиций: ${inject.length})`)
  }

  const clientEntry = manifest.exports?.['./client']
  if (typeof clientEntry !== 'string') {
    fail('если объявлен dsh.client, нужно экспортировать exports["./client"]')
  } else {
    const relative = clientEntry.replace(/^\.\//, '')
    if (!hasFile(relative)) fail(`exports["./client"] указывает на файл вне пакета: ${clientEntry}`)
    else {
      const code = readIfPresent(relative) ?? ''
      pass(`Клиентский бандл на месте: ${clientEntry}`)
      if (!code.includes('__ModuleLoader__')) fail('клиентский бандл не вызывает window.__ModuleLoader__.load')
      else {
        const idMatch = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{\s*id\s*:\s*['"]([^'"]+)['"]/.exec(code)
        if (!idMatch) fail('не удалось прочитать load({ id }) из клиентского бандла')
        else if (idMatch[1] !== manifest.name) fail(`id клиентского модуля должен совпадать с именем пакета: ожидалось ${manifest.name}, получено ${idMatch[1]}`)
        else pass(`id клиентского модуля = ${manifest.name}`)
      }
      // Встроенные модули вызываются как __require("<id модуля>"); оставшиеся __require("<имя пакета>") попадают в базовую линию хоста.
      const internalIds = new Set([...code.matchAll(/__factories\[\s*['"]([^'"]+)['"]\s*\]/g)].map((match) => match[1]))
      const bare = [...new Set([...code.matchAll(/__require\(\s*['"]([^'"]+)['"]\s*\)/g)]
        .map((match) => match[1])
        .filter((spec) => !internalIds.has(spec) && !spec.startsWith('.') && !spec.includes('/')))]
      if (bare.length > 0) {
        // React-семейство — общая база загрузчика модулей, в dsh.client.external его не считаем.
        const baseline = ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client']
        const external = [...(Array.isArray(client.external) ? client.external : []), ...baseline]
        const missing = bare.filter((spec) => !external.some((item) => spec === item || spec.startsWith(`${item}/`)))
        if (missing.length > 0) warn(`клиент требует модули, не объявленные в dsh.client.external: ${missing.join(', ')}`)
      }
    }
  }
}

/* ---------------------------------------------------------------- Зависимости */

const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.peerDependencies ?? {}) }
if ('@deepseek-ai/schemastery' in dependencies) pass('объявлен @deepseek-ai/schemastery')
else warn('рекомендуется объявить @deepseek-ai/schemastery (нужен для Config на сервере)')

const dshPeers = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
if (dshPeers.length > 0) {
  warn(`объявлены peer-зависимости Harness: ${dshPeers.map(([name, range]) => (name + '@' + range)).join(', ')}; диапазон должен явно включать prerelease-ветку, иначе при установке будет ERESOLVE`)
}

/* ------------------------------------------------------ files и чувствительные файлы */

if (Array.isArray(manifest.files) && manifest.files.length > 0) {
  const required = [patchPath, mainEntry, manifest.exports?.['./client']]
    .filter((value) => typeof value === 'string')
    .map((value) => value.replace(/^\.\//, ''))
  const missing = required.filter((relative) => !manifest.files.some((pattern) => {
    const clean = pattern.replace(/^\.\//, '')
    return clean === relative || (clean.endsWith('/') && relative.startsWith(clean))
  }))
  if (missing.length > 0) fail(`в files не входят обязательные файлы: ${missing.join(', ')}`)
  else pass('files покрывает патч, серверную точку входа и клиентский бандл')
} else {
  warn('рекомендуется явно ограничить содержимое пакета через files')
}

const suspicious = files.filter((name) => /(^|\/)(\.env|\.npmrc|credentials[^/]*|\.git\/|id_rsa|.*\.pem|.*\.key)$/i.test(name))
if (suspicious.length > 0) fail(`в пакете похоже есть чувствительные файлы: ${suspicious.join(', ')}`)
else pass('типичных чувствительных файлов не найдено')

/* ------------------------------------------------ Проверка серверной точки входа во время работы */

const server = mainPath && !tarball
  ? await import(pathToFileURL(join(resolve(rootArg || DEFAULT_ROOT), mainPath)).href).catch((error) => error)
  : undefined
if (server instanceof Error) {
  warn(`не удалось импортировать серверную точку входа для проверки: ${server.message}`)
} else if (server) {
  if (server.name !== manifest.name) fail(`name на сервере должен совпадать с именем пакета: ожидалось ${manifest.name}, получено ${server.name}`)
  else pass(`name на сервере = ${manifest.name}`)
  if (!Array.isArray(server.inject) || !server.inject.includes('connection')) fail('серверный inject должен содержать "connection"')
  else pass(`серверный inject = ${JSON.stringify(server.inject)}`)
  if (typeof server.Config !== 'function') fail('серверный Config должен быть Schemastery-схемой (не обычным объектом)')
  else {
    try {
      server.Config({ root: '/tmp/check' })
      server.Config({})
      fail('Config не проверяет обязательность root')
    } catch {
      pass('Config — Schemastery-схема и проверяет обязательные поля')
    }
  }
  if (typeof server.apply !== 'function') fail('сервер не экспортирует apply')
  else pass('сервер экспортирует apply')
} else if (tarball) {
  notes.push('  · в режиме tarball проверка серверной точки входа пропущена (нужны разрешаемые зависимости)')
}

/* ------------------------------------------------------------------ Вывод */

const title = `Проверка пакета воркбенча: ${sourceLabel}`
console.log(title)
console.log(`Пакет ${manifest.name}@${manifest.version}, файлов: ${files.length}`)
for (const line of notes) console.log(line)
if (warnings.length > 0) {
  console.log('\\nРекомендации:')
  for (const message of warnings) console.log(`  ! ${message}`)
}
if (failures.length > 0) {
  console.log('\\nНе пройдены обязательные пункты:')
  for (const message of failures) console.log(`  ✗ ${message}`)
  console.log(`\nИтог: не пройдено (обязательных пунктов: ${failures.length})`)
  process.exit(1)
}
console.log(`\nИтог: пройдено (обязательные пункты выполнены, рекомендаций: ${warnings.length})`)
