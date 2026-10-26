/**
 * Анализ портфеля проектов: чистые функции, без DOM и React; общие для серверных тестов и панели.
 * Время всегда сравнивается по локальному календарному дню (YYYY-MM-DD), чтобы часовой пояс не ломал «сколько осталось».
 */

export const MODULES = ['Рабочие проекты', 'Текущие задачи', 'Другие проекты']
export const STATUSES = ['В работе', 'Не начат', 'Блокер', 'Завершён', 'На паузе']
export const RISK_LEVELS = ['overdue', 'blocked', 'urgent', 'slipping', 'soon', 'unscheduled', 'normal', 'done']

export const RISK_META = {
  overdue: { label: 'Просрочено', tone: 'danger', rank: 0 },
  blocked: { label: 'Блокер', tone: 'danger', rank: 1 },
  urgent: { label: 'Срочно', tone: 'danger', rank: 2 },
  slipping: { label: 'Отставание', tone: 'warn', rank: 3 },
  soon: { label: 'Скоро дедлайн', tone: 'warn', rank: 4 },
  unscheduled: { label: 'Без срока', tone: 'muted', rank: 5 },
  normal: { label: 'В норме', tone: 'ok', rank: 6 },
  done: { label: 'Завершён', tone: 'muted', rank: 7 }
}

export const RISK_ORDER = RISK_LEVELS
export const DANGER_LEVELS = ['overdue', 'blocked', 'urgent']
export const WATCH_LEVELS = ['slipping', 'soon']

const DAY_MS = 24 * 60 * 60 * 1000

/** ISO-текст локального календарного дня. */
export function todayISO(now) {
  const date = now instanceof Date ? now : new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Разобрать YYYY-MM-DD в миллисекунды локальной полуночи; при ошибке — null. */
export function dayStart(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim())
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date.getTime()
}

/** Целая разница дней от a до b (положительная, если b позже a). */
export function daysBetween(a, b) {
  const from = dayStart(a)
  const to = dayStart(b)
  if (from === null || to === null) return null
  return Math.round((to - from) / DAY_MS)
}

/** Остаток дней: отрицательное значение — просрочено. */
export function daysLeft(dueDate, today = todayISO()) {
  const left = daysBetween(today, dueDate)
  return left
}

export function formatRemaining(dueDate, today = todayISO()) {
  const left = daysLeft(dueDate, today)
  if (left === null) return 'Без срока'
  if (left < 0) return `Просрочено на ${Math.abs(left)} дн.`
  if (left === 0) return 'Срок сегодня'
  if (left === 1) return 'Срок завтра'
  return `Осталось ${left} дн.`
}

/** Последний день недели (воскресенье). */
export function endOfWeek(today = todayISO()) {
  const start = dayStart(today)
  if (start === null) return today
  const date = new Date(start)
  const weekday = date.getDay()
  date.setDate(date.getDate() + (weekday === 0 ? 0 : 7 - weekday))
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function openTodos(project) {
  return (Array.isArray(project?.todos) ? project.todos : []).filter((todo) => todo && todo.done !== true)
}

export function latestUpdate(project) {
  const updates = Array.isArray(project?.updates) ? project.updates : []
  if (updates.length === 0) return null
  return updates.reduce((latest, item) => {
    if (!latest) return item
    return String(item?.at ?? '') > String(latest?.at ?? '') ? item : latest
  }, null)
}

/**
 * Риск по срокам одного проекта.
 * Порядок: завершён → просрочено → блокер → без срока → срочно (≤3 дней) → отставание → скоро (≤7 дней) → в норме.
 */
export function projectRisk(project, today = todayISO()) {
  const status = String(project?.status ?? '')
  if (status === 'Завершён') {
    return { level: 'done', ...RISK_META.done, detail: 'Сдано', remainingDays: daysLeft(project?.dueDate, today) }
  }
  if (status === 'Блокер') {
    return { level: 'blocked', ...RISK_META.blocked, detail: 'Заблокирован — нужно продвинуть', remainingDays: daysLeft(project?.dueDate, today) }
  }
  const left = daysLeft(project?.dueDate, today)
  if (left === null) {
    return { level: 'unscheduled', ...RISK_META.unscheduled, detail: 'Дедлайн не задан', remainingDays: null }
  }
  if (left < 0) {
    return { level: 'overdue', ...RISK_META.overdue, detail: `Срок просрочен на ${Math.abs(left)} дн.`, remainingDays: left }
  }
  if (left <= 3) {
    return { level: 'urgent', ...RISK_META.urgent, detail: left === 0 ? 'Срок сегодня' : `Осталось ${left} дн.`, remainingDays: left }
  }
  const slip = slippage(project, today)
  if (slip !== null && slip >= 0.3) {
    const percent = Math.round(slip * 100)
    return { level: 'slipping', ...RISK_META.slipping, detail: `Прошло ${percent}% срока, а прогресс всего ${clampProgress(project)}%`, remainingDays: left }
  }
  if (left <= 7) {
    return { level: 'soon', ...RISK_META.soon, detail: `Осталось ${left} дн.`, remainingDays: left }
  }
  return { level: 'normal', ...RISK_META.normal, detail: `Осталось ${left} дн. — в графике`, remainingDays: left }
}

export function clampProgress(project) {
  const value = Number(project?.progress)
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

/** Доля прошедшего времени минус прогресс; null, если нет даты начала или период нулевой. */
export function slippage(project, today = todayISO()) {
  const start = dayStart(project?.startedOn)
  const due = dayStart(project?.dueDate)
  const now = dayStart(today)
  if (start === null || due === null || now === null || due <= start) return null
  const elapsed = Math.min(1, Math.max(0, (now - start) / (due - start)))
  return elapsed - clampProgress(project) / 100
}

/** Отсортировать проекты по риску: опасные впереди, внутри уровня — по остатку дней (меньше первым), затем по названию. */
export function sortByRisk(projects, today = todayISO()) {
  return [...projects].map((project) => ({ project, risk: projectRisk(project, today) }))
    .sort((a, b) => {
      if (a.risk.rank !== b.risk.rank) return a.risk.rank - b.risk.rank
      const leftA = a.risk.remainingDays
      const leftB = b.risk.remainingDays
      if (leftA !== null && leftB !== null && leftA !== leftB) return leftA - leftB
      if (leftA === null && leftB !== null) return 1
      if (leftA !== null && leftB === null) return -1
      return String(a.project.name).localeCompare(String(b.project.name), 'zh-Hans-CN')
    })
}

/** Сводка по одному модулю. */
export function moduleRollup(projects, module, today = todayISO()) {
  const items = module === 'Все' ? projects : projects.filter((project) => (project?.module || 'Другие проекты') === module)
  const risks = items.map((project) => projectRisk(project, today))
  return {
    module,
    total: items.length,
    active: items.filter((project) => project?.status === 'В работе').length,
    done: items.filter((project) => project?.status === 'Завершён').length,
    danger: risks.filter((risk) => DANGER_LEVELS.includes(risk.level)).length,
    watch: risks.filter((risk) => WATCH_LEVELS.includes(risk.level)).length,
    openTodos: items.reduce((sum, project) => sum + openTodos(project).length, 0)
  }
}

/** Список модулей: три фиксированных впереди, свои дополняются в порядке появления. */
export function moduleNames(projects) {
  const extra = []
  for (const project of projects) {
    const module = project?.module || 'Другие проекты'
    if (!MODULES.includes(module) && !extra.includes(module)) extra.push(module)
  }
  return [...MODULES, ...extra]
}

/** Обзор всего воркбенча: всего, распределение статусов, распределение рисков, сводки модулей, задачи на контроле. */
export function overview(projects, today = todayISO()) {
  const items = Array.isArray(projects) ? projects : []
  const sorted = sortByRisk(items, today)
  const risks = sorted.map((item) => item.risk)
  const byStatus = {}
  for (const project of items) {
    const status = project?.status || 'В работе'
    byStatus[status] = (byStatus[status] ?? 0) + 1
  }
  const byRisk = {}
  for (const risk of risks) byRisk[risk.level] = (byRisk[risk.level] ?? 0) + 1
  const followUps = []
  for (const project of sorted) {
    for (const todo of openTodos(project.project)) {
      followUps.push({ projectId: project.project.id, projectName: project.project.name, module: project.project.module, ...todo })
    }
  }
  followUps.sort((a, b) => {
    const left = dayStart(a.dueDate)
    const right = dayStart(b.dueDate)
    if (left === null && right === null) return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN')
    if (left === null) return 1
    if (right === null) return -1
    return left - right
  })
  return {
    today,
    total: items.length,
    byStatus,
    byRisk,
    attention: sorted.map((item) => ({ project: item.project, risk: item.risk })),
    modules: moduleNames(items).map((module) => moduleRollup(items, module, today)),
    followUps,
    dueSoon: sorted.filter((item) => ['overdue', 'urgent', 'soon'].includes(item.risk.level))
      .map((item) => ({ project: item.project, risk: item.risk }))
  }
}

/** Найти проект по id. */
export function findProject(projects, id) {
  return (Array.isArray(projects) ? projects : []).find((project) => project?.id === id) ?? null
}
