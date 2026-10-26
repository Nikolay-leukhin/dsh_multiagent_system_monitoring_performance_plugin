/**
 * AI-заполнение: превращает команду на естественном языке в «план изменений», сначала показывает его пользователю, потом пишет одним разом.
 *
 * Этот слой — чистые функции: модель только выдаёт JSON-план, а **проверка, сопоставление, предпросмотр, применение** делаются здесь,
 * поэтому ошибка модели не меняет данные; если модель недоступна — локальный разбор правилами.
 */
import { MODULES, STATUSES, clampProgress, todayISO } from './analysis.js'
import { answerQuestion } from './query.js'
export const AI_INTENTS = ['add', 'update', 'delete', 'todo', 'log', 'query']
export const AI_OPS = ['add', 'update', 'delete', 'addTodo', 'doneTodo', 'addLog']
const LOG_KINDS = ['note', 'progress', 'blocker', 'decision']
const EDITABLE = ['name', 'module', 'status', 'owner', 'dueDate', 'startedOn', 'progress', 'summary', 'link']
const FIELD_LABELS = {
  name: 'Название', module: 'Модуль', status: 'Статус', owner: 'Ответственный', dueDate: 'Дедлайн', startedOn: 'Начало',
  progress: 'Прогресс', summary: 'Описание', link: 'Ссылка'
}
const KIND_LABELS = { note: 'Запись', progress: 'Прогресс', blocker: 'Блокер', decision: 'Решение' }

const pad = (value) => String(value).padStart(2, '0')
const dayOf = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim())
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}
const iso = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const shift = (today, days) => {
  const date = dayOf(today) ?? new Date()
  date.setDate(date.getDate() + days)
  return iso(date)
}

/** Разбирает дату из текста модели или пользователя в YYYY-MM-DD; если не вышло — пустая строка. */
export function resolveDate(value, today = todayISO()) {
  const raw = String(value ?? '').trim()
  if (raw === '') return ''
  const absolute = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw)
  if (absolute) return `${absolute[1]}-${pad(absolute[2])}-${pad(absolute[3])}`
  const MONTHS = { янв: 1, фев: 2, мар: 3, апр: 4, май: 5, мая: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12 }
  const monthWord = /(\d{1,2})\s*(?:-?(?:го|е))?\s+(янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)[а-яё]*/i.exec(raw)
  if (monthWord) {
    const year = Number(today.slice(0, 4))
    return `${year}-${pad(MONTHS[monthWord[2].toLowerCase()])}-${pad(monthWord[1])}`
  }
  const dayMonth = /(?:^|\s)(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?:\s|$)/.exec(raw)
  if (dayMonth) {
    const year = dayMonth[3] ? Number(dayMonth[3].length === 2 ? '20' + dayMonth[3] : dayMonth[3]) : Number(today.slice(0, 4))
    return `${year}-${pad(dayMonth[2])}-${pad(dayMonth[1])}`
  }
  if (/сегодня|нынче/i.test(raw)) return today
  if (/послезавтра/i.test(raw)) return shift(today, 2)
  if (/завтра/i.test(raw)) return shift(today, 1)
  const longWeekday = /(следующ[а-яё]*|ближайш[а-яё]*|эту|этот)?\s*(воскресень[а-яё]*|понедельник[а-яё]*|вторник[а-яё]*|сред[ауы]|четверг[а-яё]*|пятниц[ауы]|суббот[ауы])/i.exec(raw)
  const shortWeekday = longWeekday ? null : /(?:^|[\s,;.(])(пн|вт|ср|чт|пт|сб|вс)(?=$|[\s,;.)])/i.exec(raw)
  const weekday = longWeekday
    ? { modifier: longWeekday[1], day: longWeekday[2] }
    : shortWeekday ? { modifier: '', day: shortWeekday[1] } : null
  if (weekday) {
    const base = dayOf(today) ?? new Date()
    const key = weekday.day.toLowerCase()
    const map = {
      понедельник: 1, вторник: 2, среда: 3, среду: 3, среды: 3, четверг: 4,
      пятница: 5, пятницу: 5, пятницы: 5, суббота: 6, субботу: 6, субботы: 6,
      воскресенье: 7, воскресенья: 7, пн: 1, вт: 2, ср: 3, чт: 4, пт: 5, сб: 6, вс: 7
    }
    const target = map[key]
    if (!target) return ''
    const current = base.getDay() === 0 ? 7 : base.getDay()
    let delta = target - current
    if (weekday.modifier && /следующ|ближайш/i.test(weekday.modifier)) delta += 7
    else if (delta < 0) delta += 7
    return shift(today, delta)
  }
  if (/конец месяца|конце месяца|концу месяца/i.test(raw)) {
    const date = dayOf(today) ?? new Date()
    return iso(new Date(date.getFullYear(), date.getMonth() + 1, 0))
  }
  if (/следующ[а-яё]* месяц|через месяц/i.test(raw)) {
    const date = dayOf(today) ?? new Date()
    return iso(new Date(date.getFullYear(), date.getMonth() + 1, 1))
  }
  const plusDays = /\+?\s*(\d+)\s*(?:дн|день|дня|дней)/i.exec(raw)
  if (plusDays) return shift(today, Number(plusDays[1]))
  const plusWeeks = /\+?\s*(\d+)\s*(?:нед|неделю|недели|недель)/i.exec(raw)
  if (plusWeeks) return shift(today, Number(plusWeeks[1]) * 7)
  return ''
}

const normalizeName = (value) => String(value ?? '').replace(/[\s«»"'()\[\],.;:!?—–]/g, '').toLowerCase()

/** Найти проект по id → точному имени → вхождению; при неоднозначности или отсутствии возвращает причину. */
export function matchProject(target, projects) {
  const raw = String(target ?? '').trim()
  if (raw === '') return { reason: 'Не указано, о каком проекте речь' }
  const list = Array.isArray(projects) ? projects : []
  const byId = list.find((project) => project.id === raw)
  if (byId) return { project: byId }
  const wanted = normalizeName(raw)
  const exact = list.filter((project) => normalizeName(project.name) === wanted)
  if (exact.length === 1) return { project: exact[0] }
  if (exact.length > 1) return { reason: `«${raw}» — несколько проектов, уточните название` }
  const partial = list.filter((project) => normalizeName(project.name).includes(wanted) || wanted.includes(normalizeName(project.name)))
  if (partial.length === 1) return { project: partial[0] }
  if (partial.length > 1) return { reason: `«${raw}» совпадает с несколькими проектами (${partial.slice(0, 3).map((p) => p.name).join(', ')}), уточните название` }
  return { reason: `Проект «${raw}» не найден` }
}

function cleanTags(value) {
  if (!Array.isArray(value)) return []
  return value.map((tag) => String(tag ?? '').trim()).filter(Boolean).slice(0, 8)
}

function cleanProgress(value) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').replace('%', '').trim())
  if (!Number.isFinite(number)) return null
  return clampProgress({ progress: number })
}

function normalizeAdd(raw, today, issues) {
  const name = String(raw?.name ?? raw?.title ?? '').trim()
  if (!name) {
    issues.push('В добавлении нет названия проекта — пропущено')
    return null
  }
  const status = STATUSES.includes(raw?.status) ? raw.status : 'В работе'
  const progress = cleanProgress(raw?.progress)
  return {
    op: 'add',
    project: {
      name,
      module: String(raw?.module ?? '').trim() || 'Другие проекты',
      status,
      owner: String(raw?.owner ?? '').trim(),
      startedOn: resolveDate(raw?.startedOn, today),
      dueDate: resolveDate(raw?.dueDate, today),
      progress: progress === null ? 0 : progress,
      summary: String(raw?.summary ?? '').trim(),
      link: String(raw?.link ?? '').trim(),
      tags: cleanTags(raw?.tags)
    }
  }
}

function normalizeUpdate(raw, projects, today, issues) {
  const found = matchProject(raw?.target ?? raw?.name, projects)
  if (!found.project) {
    issues.push(`${found.reason} — изменение пропущено`)
    return null
  }
  const source = raw?.changes && typeof raw.changes === 'object' ? raw.changes : raw
  const changes = {}
  for (const key of EDITABLE) {
    if (source?.[key] === undefined || source?.[key] === null || source?.[key] === '') continue
    if (key === 'progress') {
      const progress = cleanProgress(source[key])
      if (progress === null) { issues.push(`Значение прогресса не распознано — пропущено`); continue }
      changes.progress = progress
      continue
    }
    if (key === 'status') {
      if (!STATUSES.includes(source[key])) { issues.push(`Статус «${source[key]}» вне допустимых — пропущено`); continue }
      changes.status = source[key]
      continue
    }
    if (key === 'dueDate' || key === 'startedOn') {
      const date = resolveDate(source[key], today)
      if (!date) { issues.push(`Дата «${source[key]}» не распознана — пропущено`); continue }
      changes[key] = date
      continue
    }
    changes[key] = String(source[key]).trim()
  }
  if (Object.keys(changes).length === 0) {
    issues.push(`Не понято, что менять в «${found.project.name}» — пропущено`)
    return null
  }
  return { op: 'update', projectId: found.project.id, name: found.project.name, changes }
}

function normalizeSimple(op, raw, projects, today, issues) {
  const found = matchProject(raw?.target ?? raw?.project ?? raw?.name, projects)
  if (!found.project) {
    issues.push(`${found.reason} — ${op === 'delete' ? 'удаление' : op === 'addTodo' ? 'новая задача' : op === 'doneTodo' ? 'закрытие задачи' : 'запись'} пропущено`)
    return null
  }
  const project = found.project
  if (op === 'delete') return { op, projectId: project.id, name: project.name }
  if (op === 'addTodo') {
    const title = String(raw?.title ?? raw?.todo ?? raw?.text ?? '').trim()
    if (!title) { issues.push('В задаче нет текста — пропущено'); return null }
    return { op, projectId: project.id, name: project.name, title, owner: String(raw?.owner ?? '').trim(), dueDate: resolveDate(raw?.dueDate, today) }
  }
  if (op === 'doneTodo') {
    const wanted = normalizeName(raw?.title ?? raw?.todo ?? raw?.text ?? '')
    const open = (project.todos ?? []).filter((todo) => todo.done !== true)
    let todo = null
    if (wanted) todo = open.find((item) => normalizeName(item.title).includes(wanted)) ?? null
    else if (open.length === 1) todo = open[0]
    if (!todo) { issues.push(`В «${project.name}» не найдена задача для закрытия — пропущено`); return null }
    return { op, projectId: project.id, name: project.name, todoId: todo.id, title: todo.title }
  }
  const text = String(raw?.text ?? raw?.content ?? raw?.summary ?? '').trim()
  if (!text) { issues.push('Пустая запись о прогрессе — пропущено'); return null }
  const kind = LOG_KINDS.includes(raw?.kind) ? raw.kind : 'note'
  return { op, projectId: project.id, name: project.name, kind, text }
}

/**
 * Проверить и нормализовать сырой план, полученный от модели.
 * @returns { intent, reply, actions, issues }
 */
export function normalizePlan(raw, projects, today = todayISO()) {
  const issues = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { intent: 'query', reply: '', actions: [], issues: ['Модель не вернула пригодный план'] }
  }
  const actions = []
  for (const action of Array.isArray(raw.actions) ? raw.actions.slice(0, 20) : []) {
    const op = String(action?.op ?? '').trim()
    if (!AI_OPS.includes(op)) {
      if (op) issues.push(`Неизвестное действие «${op}» — пропущено`)
      continue
    }
    const normalized = op === 'add' ? normalizeAdd(action, today, issues)
      : op === 'update' ? normalizeUpdate(action, projects, today, issues)
        : normalizeSimple(op, action, projects, today, issues)
    if (normalized) actions.push(normalized)
  }
  const intent = AI_INTENTS.includes(raw.intent) ? raw.intent : ''
  const inferred = actions.length === 0
    ? (intent || 'query')
    : actions.some((action) => action.op === 'add') ? 'add'
      : actions.some((action) => action.op === 'delete') ? 'delete'
        : actions.some((action) => action.op === 'update') ? 'update'
          : actions.some((action) => action.op === 'addTodo' || action.op === 'doneTodo') ? 'todo' : 'log'
  return {
    intent: intent && actions.length > 0 && intent !== 'query' ? intent : inferred,
    reply: String(raw.reply ?? '').trim(),
    actions,
    issues
  }
}

/** Перед применением на клиенте сверить ещё раз: за время разбора проекты могли измениться. */
export function revalidatePlan(plan, projects) {
  const ids = new Set((Array.isArray(projects) ? projects : []).map((project) => project.id))
  const actions = []
  const issues = [...(plan?.issues ?? [])]
  let dropped = 0
  for (const action of plan?.actions ?? []) {
    if (action.op === 'add' || ids.has(action.projectId)) actions.push(action)
    else dropped += 1
  }
  if (dropped > 0) issues.push(`пропущено из-за изменений в проектах: ${dropped}`)
  return { ...plan, actions, issues }
}

/** Читаемый предпросмотр изменений: окно подтверждения рисуется именно по нему. */
export function previewPlan(plan, projects = [], today = todayISO()) {
  const find = (id) => projects.find((project) => project.id === id)
  const groups = []
  const push = (key, title, lines) => { if (lines.length > 0) groups.push({ key, title, lines }) }

  push('add', 'Новый проект', (plan.actions ?? []).filter((action) => action.op === 'add').map((action) => {
    const project = action.project
    const bits = [project.module, project.status, project.dueDate ? `DDL ${project.dueDate}` : 'Без срока']
    if (project.owner) bits.push(project.owner)
    return `«${project.name}» (${bits.join(' · ')})${project.summary ? ' — ' + project.summary : ''}`
  }))

  push('update', 'Изменение проекта', (plan.actions ?? []).filter((action) => action.op === 'update').map((action) => {
    const project = find(action.projectId)
    const changes = Object.entries(action.changes).map(([key, value]) => {
      const before = key === 'progress' ? `${clampProgress(project ?? {})}%` : String(project?.[key] ?? 'пусто') || 'пусто'
      const after = key === 'progress' ? `${value}%` : String(value)
      return `${FIELD_LABELS[key] ?? key} ${before} → ${after}`
    })
    return `«${action.name}»: ${changes.join('; ')}`
  }))

  push('delete', 'Удалить проект', (plan.actions ?? []).filter((action) => action.op === 'delete').map((action) => {
    const project = find(action.projectId)
    return `«${action.name}»${project ? ' (' + (project.module || 'Другие проекты') + ' · ' + (project.status || 'В работе') + ' · ' + clampProgress(project) + '%)' : ''}`
  }))

  push('todo', 'На контроле', (plan.actions ?? []).filter((action) => action.op === 'addTodo' || action.op === 'doneTodo').map((action) => (action.op === 'addTodo'
    ? `В «${action.name}» добавлено: ${action.title}${action.dueDate ? ' (срок ' + action.dueDate + ')' : ''}`
    : `Задача «${action.title}» в «${action.name}» закрыта`)))

  push('log', 'Запись о прогрессе', (plan.actions ?? []).filter((action) => action.op === 'addLog').map((action) =>
    `Дописано в «${action.name}» (${KIND_LABELS[action.kind] ?? 'запись'}): ${action.text}`))

  const total = (plan.actions ?? []).length
  return { groups, total, issues: plan.issues ?? [] }
}

/** Короткая сводка изменений предпросмотра — для сообщения после выполнения. */
export function planSummary(plan) {
  const count = (op) => (plan.actions ?? []).filter((action) => action.op === op).length
  const parts = []
  if (count('add')) parts.push(`добавлено: ${count('add')}`)
  if (count('update')) parts.push(`изменено: ${count('update')}`)
  if (count('delete')) parts.push(`удалено: ${count('delete')}`)
  const todos = count('addTodo') + count('doneTodo')
  if (todos) parts.push(`задач: ${todos}`)
  if (count('addLog')) parts.push(`записей: ${count('addLog')}`)
  return parts.join(', ') || 'Изменений нет'
}

/**
 * Применить план к состоянию и вернуть новое состояние. Одна запись, при сбое не остаётся половины.
 * @param makeId — функция генерации id; в тестах можно подставить фиксированное значение.
 */
export function applyPlan(state, plan, today = todayISO(), makeId = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`) {
  let projects = Array.isArray(state?.projects) ? [...state.projects] : []
  let applied = 0
  const now = new Date().toISOString()
  const touch = (project) => ({ ...project, updatedAt: now })

  for (const action of plan?.actions ?? []) {
    if (action.op === 'add') {
      projects = [{
        id: makeId('proj'),
        name: action.project.name,
        module: action.project.module,
        status: action.project.status,
        owner: action.project.owner,
        dueDate: action.project.dueDate,
        startedOn: action.project.startedOn,
        progress: action.project.progress,
        link: action.project.link,
        summary: action.project.summary,
        tags: action.project.tags,
        createdAt: now,
        updatedAt: now,
        updates: [],
        todos: []
      }, ...projects]
      applied += 1
      continue
    }
    const index = projects.findIndex((project) => project.id === action.projectId)
    if (index < 0) continue
    const project = projects[index]
    if (action.op === 'update') {
      projects[index] = touch({ ...project, ...action.changes })
    } else if (action.op === 'delete') {
      projects = projects.filter((item) => item.id !== action.projectId)
    } else if (action.op === 'addTodo') {
      projects[index] = touch({
        ...project,
        todos: [...(project.todos ?? []), {
          id: makeId('todo'), title: action.title, owner: action.owner, dueDate: action.dueDate, done: false, doneAt: ''
        }]
      })
    } else if (action.op === 'doneTodo') {
      projects[index] = touch({
        ...project,
        todos: (project.todos ?? []).map((todo) => (todo.id === action.todoId
          ? { ...todo, done: true, doneAt: now }
          : todo))
      })
    } else if (action.op === 'addLog') {
      projects[index] = touch({
        ...project,
        updates: [...(project.updates ?? []), { id: makeId('upd'), at: now, kind: action.kind, text: action.text }]
      })
    }
    applied += 1
  }
  return { next: { ...state, projects }, applied }
}

/* --------------------------------------------------------- Локальные правила (фолбэк) */

const has = (text, pattern) => pattern.test(text)

function pickProjectName(instruction, projects) {
  const normalized = normalizeName(instruction)
  const candidates = (projects ?? [])
    .map((project) => ({ project, key: normalizeName(project.name) }))
    .filter((item) => item.key.length >= 2 && normalized.includes(item.key))
    .sort((a, b) => b.key.length - a.key.length)
  return candidates[0]?.project ?? null
}

function detectStatus(text) {
  if (/заверш|закончен|готово|сдал|сдано/i.test(text)) return 'Завершён'
  if (/блок|застр|застрял|стопор/i.test(text)) return 'Блокер'
  if (/пауз|приостанов|замороз/i.test(text)) return 'На паузе'
  if (/не начат|не начинали|ещё не|еще не|не стартовал/i.test(text)) return 'Не начат'
  if (/в работе|делаю|работаю|в процессе|взял в работу/i.test(text)) return 'В работе'
  return ''
}

/**
 * Разбор правилами без модели: распознаёт частые формулировки, структура плана та же, что у модели.
 * Используется как фолбэк, когда модель недоступна; интерфейс помечает источник.
 */
export function planFromRules(instruction, projects = [], today = todayISO()) {
  const text = String(instruction ?? '').trim()
  const issues = []
  if (!text) return { intent: 'query', reply: 'Скажите, что сделать, например: «перенеси дедлайн проекта «Переработка сервиса расчётов» на следующую пятницу».', actions: [], issues }

  if (has(text, /^(что|какие|как|где|когда|сколько|кто|покажи|список|обзор|расскажи)(?=\s|$)/i) || /[?]\s*$/.test(text)) {
    return { intent: 'query', reply: answerQuestion(text, projects, today).text, actions: [], issues }
  }

  const target = pickProjectName(text, projects)

  if (has(text, /удали|удалить|убери|убрать|снеси|удаление/i)) {
    if (!target) {
      issues.push('Не понял, какой проект удалить — назовите его точнее')
      return { intent: 'delete', reply: '', actions: [], issues }
    }
    return { intent: 'delete', reply: `Удалить «${target.name}»`, actions: [{ op: 'delete', projectId: target.id, name: target.name }], issues }
  }

  if (has(text, /задач|напомни|напоминание|на контроль/i)) {
    if (!target) {
      issues.push('Не понял, к какому проекту задача — назовите проект')
      return { intent: 'todo', reply: '', actions: [], issues }
    }
    const marker = /задачу|задача|задачи|напомни|напоминание|на контроль/i.exec(text)
    const rest = marker ? text.slice(marker.index + marker[0].length) : ''
    const cleaned = rest.replace(/^[\s:,.;—–-]+/, '').replace(/[.;\s]+$/, '').trim()
    if (!cleaned) {
      issues.push('Не указан текст задачи')
      return { intent: 'todo', reply: '', actions: [], issues }
    }
    return {
      intent: 'todo',
      reply: `Добавить задачу в «${target.name}»`,
      actions: [{ op: 'addTodo', projectId: target.id, name: target.name, title: cleaned, owner: '', dueDate: resolveDate(text, today) }],
      issues
    }
  }

  if (has(text, /закрой|закрыть|закрыта|выполнено|выполнил|готово|сделано/i) && target) {
    const open = (target.todos ?? []).filter((todo) => todo.done !== true)
    if (open.length === 1) {
      return { intent: 'todo', reply: `Закрыть задачу в «${target.name}»`, actions: [{ op: 'doneTodo', projectId: target.id, name: target.name, todoId: open[0].id, title: open[0].title }], issues }
    }
    if (open.length === 0) issues.push(`В «${target.name}» нет открытых задач`)
    else issues.push(`В «${target.name}» открытых задач: ${open.length} — уточните, какая`)
    return { intent: 'todo', reply: '', actions: [], issues }
  }

  if (has(text, /запись|запиши|допиши|отметь|зафиксируй/i)) {
    if (!target) {
      issues.push('Не понял, о каком проекте речь — назовите проект')
      return { intent: 'log', reply: '', actions: [], issues }
    }
    const marker = /запись|запиши|допиши|отметь|зафиксируй/i.exec(text)
    const body = marker ? text.slice(marker.index + marker[0].length) : ''
    const cleaned = body.replace(/^[\s:,.;—–-]+/, '').replace(/[.;\s]+$/, '').trim()
    if (!cleaned) {
      issues.push('Не указано, что записать')
      return { intent: 'log', reply: '', actions: [], issues }
    }
    const kind = /блок|застр/i.test(cleaned) ? 'blocker' : /решил|решение|договорил/i.test(cleaned) ? 'decision' : /готово|сделал|закончил/i.test(cleaned) ? 'progress' : 'note'
    return { intent: 'log', reply: `Дописать запись в «${target.name}»`, actions: [{ op: 'addLog', projectId: target.id, name: target.name, kind, text: cleaned }], issues }
  }

  const progress = /(\d{1,3})\s*%/.exec(text)
  const status = detectStatus(text)
  const dueDate = has(text, /дедлайн|срок|ddl|deadline|перенеси|сдвинь|продли|отложи|до\s+[а-яё]/i) || /\d{1,2}\s*(?:янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)/i.test(text)
    ? resolveDate(text, today)
    : ''
  const owner = /ответственн[а-яё]*\s*[:—-]?\s*([^\s,;.]{1,20})/i.exec(text)?.[1] ?? ''

  if (target && (progress || status || dueDate || owner)) {
    const changes = {}
    if (progress) changes.progress = clampProgress({ progress: Number(progress[1]) })
    if (status) changes.status = status
    if (dueDate) changes.dueDate = dueDate
    if (owner) changes.owner = owner
    return { intent: 'update', reply: `Изменить «${target.name}»`, actions: [{ op: 'update', projectId: target.id, name: target.name, changes }], issues }
  }

  if (has(text, /добавь|добавить|новый проект|создай|создать|заведи|записать/i)) {
    const module = MODULES.find((name) => text.includes(name)) ?? 'Другие проекты'
    const name = text
      .replace(/^(добавь|добавить|создай|создать|заведи|записать|новый проект|проект)?\s*/i, '')
      .replace(/^(проект|задачу)?\s*:?\s*/i, '')
      .split(/[,;.(]/)[0]
      .replace(new RegExp(module, 'g'), '')
      .replace(/в\s+«?\s*$/, '')
      .replace(/^(в|на)\s+/i, '')
      .trim()
    if (!name) {
      issues.push('Не распознано название проекта')
      return { intent: 'add', reply: '', actions: [], issues }
    }
    return {
      intent: 'add',
      reply: `Новый проект «${name}»`,
      actions: [{
        op: 'add',
        project: {
          name, module, status: status || 'В работе', owner,
          startedOn: today, dueDate, progress: progress ? clampProgress({ progress: Number(progress[1]) }) : 0,
          summary: '', link: '', tags: []
        }
      }],
      issues
    }
  }

  issues.push('Не понял фразу. Можно так: «добавь проект X», «перенеси дедлайн X на следующую пятницу», «удали X», «добавь задачу в X: Y» — или спросите «что сдаём на этой неделе».')
  return { intent: 'query', reply: answerQuestion(text, projects, today).text, actions: [], issues }
}

/** Описание JSON-контракта для модели (используется и в подсказке о возможностях). */
export function planSchemaDoc(today = todayISO()) {
  return [
    `Сегодня ${today}. Переведи команду пользователя в один JSON-объект; никаких пояснений и текста вне блока Markdown.`,
    'JSON-структура: { "intent": "add|update|delete|todo|log|query", "reply": "одна фраза для пользователя", "actions": [...] }',
    'Каждый элемент actions — один из вариантов:',
    '- Новый проект: { "op":"add", "name":"название", "module":"Рабочие проекты|Текущие задачи|Другие проекты", "status":"В работе|Не начат|Блокер|На паузе|Завершён", "owner":"", "startedOn":"YYYY-MM-DD", "dueDate":"YYYY-MM-DD", "progress":0, "summary":"одна фраза", "tags":["тег"] }',
    '- Изменение проекта: { "op":"update", "target":"название или id", "changes":{ только изменяемые поля, имена те же } }',
    '- Удаление проекта: { "op":"delete", "target":"название или id" }',
    '- Новая задача: { "op":"addTodo", "target":"название или id", "title":"задача", "dueDate":"YYYY-MM-DD", "owner":"" }',
    '- Закрыть задачу: { "op":"doneTodo", "target":"название или id", "title":"ключевые слова задачи" }',
    '- Дописать запись: { "op":"addLog", "target":"название или id", "kind":"note|progress|blocker|decision", "text":"текст" }',
    'Правила: ссылайся только на реальные названия или id из списка выше; если это только вопрос — intent "query", actions пустой, ответ в reply;',
    'Даты всегда в формате YYYY-MM-DD; не выдумывай неизвестные поля — лучше меньше actions.'
  ].join('\n')
}

/** Снимок проектов для модели (с ограничением длины, чтобы не раздувать контекст). */
export function projectSnapshot(projects, today = todayISO(), limit = 40) {
  return (Array.isArray(projects) ? projects : []).slice(0, limit).map((project) => ({
    id: project.id,
    name: project.name,
    module: project.module || 'Другие проекты',
    status: project.status || 'В работе',
    owner: project.owner || '',
    dueDate: project.dueDate || '',
    progress: clampProgress(project),
    todo: (project.todos ?? []).filter((todo) => todo.done !== true).slice(0, 8).map((todo) => ({ title: todo.title, dueDate: todo.dueDate || '' })),
    lastUpdate: (project.updates ?? []).slice(-2).map((item) => item.text)
  }))
}
