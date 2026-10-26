/** Тонкая обёртка клиента над серверными интерфейсами воркбенча. */
const PREFIX = '/api/project-console'

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export function newId(prefix = 'p') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

async function parse(response) {
  let payload
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok) {
    throw new ApiError((payload && payload.error) || `Запрос не удался (HTTP ${response.status})`, response.status)
  }
  return payload
}

/** Прочитать документ проектов. */
export async function readState() {
  const response = await fetch(`${PREFIX}/state`, { credentials: 'same-origin', cache: 'no-store' })
  const payload = await parse(response)
  if (!payload || typeof payload !== 'object') throw new ApiError('Сервер вернул нераспознанные данные.', 500)
  return { revision: Number(payload.revision) || 0, state: payload.state || { version: 1, projects: [] } }
}

/** Попросить AI разобрать команду на естественном языке в план изменений (без записи). */
export async function askAi(instruction, projects, today) {
  const response = await fetch(`${PREFIX}/ai`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction, projects, today })
  })
  if (response.status === 404) {
    throw new ApiError('Сервер ещё не загрузил API AI-разбора (заработает после перезапуска Harness).', 404)
  }
  const payload = await parse(response)
  if (!payload || typeof payload !== 'object' || !payload.plan) {
    throw new ApiError('Сервер не вернул пригодный план изменений.', 500)
  }
  return payload
}

/** Полностью заменить документ проектов; при несовпадении версии бросает 409. */
export async function writeState(revision, state) {
  const response = await fetch(`${PREFIX}/state`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision, state })
  })
  return parse(response)
}
