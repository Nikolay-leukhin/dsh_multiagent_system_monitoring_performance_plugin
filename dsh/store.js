/**
 * Серверное хранилище данных пульта проектов.
 *
 * Один JSON-документ, один номер версии, одна атомарная запись: перед записью структура нормализуется (sanitize),
 * чтобы клиент не записал на диск данные неправильной формы; номер версии нужен для обнаружения гонок (CAS).
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export const STATE_VERSION = 1
export const STATE_FILE = 'state.json'
/** Предел размера документа воркбенча: больше — отказ, чтобы не испортить диск. */
export const MAX_STATE_BYTES = 4 * 1024 * 1024

const MAX_TEXT = 4000
const MAX_SHORT = 200
const MAX_ID = 120
const MAX_ITEMS = 2000

export class StateError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'StateError'
    this.status = status
  }
}

export function emptyState() {
  return { version: STATE_VERSION, seededAt: '', projects: [] }
}

const text = (value, max = MAX_SHORT) => (typeof value === 'string' ? value.slice(0, max) : '')
const isoDate = (value) => {
  const raw = text(value, 40).trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : ''
}
const isoStamp = (value) => {
  const raw = text(value, 40).trim()
  if (!raw) return ''
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString()
}
const clampPercent = (value) => {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(100, Math.max(0, Math.round(number)))
}
const list = (value) => (Array.isArray(value) ? value : [])

function sanitizeUpdate(raw) {
  if (!raw || typeof raw !== 'object') return null
  const body = text(raw.text, MAX_TEXT).trim()
  if (!body) return null
  return {
    id: text(raw.id, MAX_ID) || randomUUID(),
    at: isoStamp(raw.at) || new Date().toISOString(),
    kind: ['note', 'progress', 'blocker', 'decision'].includes(raw.kind) ? raw.kind : 'note',
    text: body
  }
}

function sanitizeTodo(raw) {
  if (!raw || typeof raw !== 'object') return null
  const title = text(raw.title, MAX_SHORT).trim()
  if (!title) return null
  return {
    id: text(raw.id, MAX_ID) || randomUUID(),
    title,
    owner: text(raw.owner, MAX_SHORT),
    dueDate: isoDate(raw.dueDate),
    done: raw.done === true,
    doneAt: raw.done === true ? isoStamp(raw.doneAt) || new Date().toISOString() : ''
  }
}

function sanitizeProject(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = text(raw.name, MAX_SHORT).trim()
  if (!name) return null
  const now = new Date().toISOString()
  return {
    id: text(raw.id, MAX_ID) || randomUUID(),
    name,
    module: text(raw.module, MAX_SHORT).trim() || 'Другие проекты',
    status: text(raw.status, MAX_SHORT).trim() || 'В работе',
    owner: text(raw.owner, MAX_SHORT),
    dueDate: isoDate(raw.dueDate),
    startedOn: isoDate(raw.startedOn),
    progress: clampPercent(raw.progress),
    link: text(raw.link, 500),
    summary: text(raw.summary, MAX_TEXT),
    tags: list(raw.tags).map((tag) => text(tag, 40)).filter(Boolean).slice(0, 20),
    createdAt: isoStamp(raw.createdAt) || now,
    updatedAt: isoStamp(raw.updatedAt) || now,
    updates: list(raw.updates).map(sanitizeUpdate).filter(Boolean).slice(0, MAX_ITEMS),
    todos: list(raw.todos).map(sanitizeTodo).filter(Boolean).slice(0, MAX_ITEMS)
  }
}

/** Нормализация структуры: вход неправильной формы превращается ввалидный документ, а не пишется как есть. */
export function sanitizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StateError('Данные проектов должны быть объектом.')
  }
  const projects = list(raw.projects).map(sanitizeProject).filter(Boolean).slice(0, MAX_ITEMS)
  const seen = new Set()
  const unique = []
  for (const project of projects) {
    const id = seen.has(project.id) ? randomUUID() : project.id
    seen.add(id)
    unique.push({ ...project, id })
  }
  // seededAt помнит, «генерировались ли уже демо-данные», чтобы после очистки они не появились снова.
  return { version: STATE_VERSION, seededAt: isoStamp(raw.seededAt), projects: unique }
}

function parseDocument(buffer) {
  let parsed
  try {
    parsed = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new StateError('Файл данных проектов не читается: исправьте его или уберите, затем повторите.', 500)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('state' in parsed)) {
    throw new StateError('Неверный формат файла данных проектов.', 500)
  }
  const revision = Number.isSafeInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0
  return { revision, state: sanitizeState(parsed.state) }
}

/**
 * Создать хранилище с каталогом данных `root`.
 * @param root — абсолютный путь к каталогу; если его нет, он будет создан перед первой записью.
 */
export function createProjectStore(root) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('project-console: каталог данных не настроен')
  const file = join(root, STATE_FILE)
  let cache
  let queue = Promise.resolve()

  const serialize = (task) => {
    const run = queue.then(task, task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  async function load() {
    if (cache) return cache
    let buffer
    try {
      buffer = await readFile(file)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        cache = { revision: 0, state: emptyState() }
        return cache
      }
      throw new StateError('Не удалось прочитать данные проектов.', 500)
    }
    if (buffer.length > MAX_STATE_BYTES) throw new StateError('Файл данных проектов слишком большой.', 500)
    cache = parseDocument(buffer)
    return cache
  }

  async function persist(document) {
    await mkdir(root, { recursive: true })
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    const payload = `${JSON.stringify(document, null, 2)}\n`
    if (Buffer.byteLength(payload) > MAX_STATE_BYTES) throw new StateError('Данные проектов слишком большие, сохранение отменено.', 413)
    try {
      await writeFile(temporary, payload, 'utf8')
      await rename(temporary, file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error instanceof StateError ? error : new StateError('Не удалось записать данные проектов.', 500)
    }
    return document
  }

  return {
    /** Прочитать текущий документ (вместе с номером версии). */
    read() {
      return serialize(async () => {
        const current = await load()
        return { revision: current.revision, state: current.state }
      })
    },
    /** Полностью заменить документ, если версия совпадает; вернуть новый номер версии. */
    write(payload) {
      return serialize(async () => {
        const current = await load()
        const revision = Number.isSafeInteger(payload?.revision) ? payload.revision : -1
        if (revision !== current.revision) {
          throw new StateError('Данные проектов изменены в другом окне: перезагрузите и сохраните снова.', 409)
        }
        const next = { revision: current.revision + 1, state: sanitizeState(payload?.state) }
        await persist(next)
        cache = next
        return { revision: next.revision, projectCount: next.state.projects.length }
      })
    },
    /** Только чтение сводки — для внешней проверки (например, curl). */
    async meta() {
      const current = await load()
      return { root, file, revision: current.revision, projectCount: current.state.projects.length }
    }
  }
}
