/**
 * Логика «модульного» вида панели: группировка по модулям, фильтр умных видов, поиск по ключевым словам.
 * Чистые функции; в тестах вызываются напрямую.
 */
import { DANGER_LEVELS, WATCH_LEVELS, clampProgress, daysLeft, endOfWeek, latestUpdate, moduleNames, openTodos, projectRisk, sortByRisk, todayISO } from './analysis.js'
export const ATTENTION_LEVELS = [...DANGER_LEVELS, ...WATCH_LEVELS]

/** Умные виды в левой колонке. `view` — для фильтра; «Все проекты» — ось модулей, а не фильтр. */
export const SMART_VIEWS = [
  { id: 'attention', label: 'Требуют внимания', hint: 'Просроченные, заблокированные, срочные или отстающие проекты' },
  { id: 'overdue', label: 'Просрочено', hint: 'Дедлайн уже прошёл' },
  { id: 'week', label: 'Дедлайн на неделе', hint: 'Срок до конца недели' },
  { id: 'todos', label: 'Есть открытые задачи', hint: 'Есть незакрытые задачи на контроле' },
  { id: 'done', label: 'Завершён', hint: 'Сданные проекты' }
]

export function smartView(id) {
  return SMART_VIEWS.find((view) => view.id === id) ?? null
}

/** Попадает ли проект в умный вид. */
export function matchesSmartView(project, viewId, today = todayISO()) {
  const risk = projectRisk(project, today)
  if (viewId === 'attention') return ATTENTION_LEVELS.includes(risk.level)
  if (viewId === 'overdue') return risk.level === 'overdue'
  if (viewId === 'done') return (project?.status || '') === 'Завершён'
  if (viewId === 'todos') return openTodos(project).length > 0
  if (viewId === 'week') {
    const left = daysLeft(project?.dueDate, today)
    return left !== null && left >= 0 && project.dueDate <= endOfWeek(today)
  }
  return true
}

/** Текст проекта для поиска: название, модуль, ответственный, описание, теги и последняя запись. */
export function searchText(project) {
  const latest = latestUpdate(project)
  return [
    project?.name, project?.module, project?.owner, project?.summary, project?.status,
    ...(Array.isArray(project?.tags) ? project.tags : []),
    latest?.text,
    ...openTodos(project).map((todo) => todo.title)
  ].filter(Boolean).join(' ').toLowerCase()
}

/**
 * Фильтрация и сортировка по «модуль + умный вид + ключевое слово».
 * @param state — { module: 'Все'|имя модуля, view: SmartView.id|'', keyword }.
 */
export function selectProjects(projects, state = {}, today = todayISO()) {
  const module = state.module ?? 'Все'
  const view = state.view ?? ''
  const keyword = String(state.keyword ?? '').trim().toLowerCase()
  return sortByRisk(projects, today)
    .map((item) => item.project)
    .filter((project) => module === 'Все' || (project?.module || 'Другие проекты') === module)
    .filter((project) => !view || matchesSmartView(project, view, today))
    .filter((project) => !keyword || searchText(project).includes(keyword))
}

/** Сводка по модулю (или «Все») для заголовка группы и счётчиков в сайдбаре. */
export function summarize(projects, today = todayISO()) {
  const risks = projects.map((project) => projectRisk(project, today))
  return {
    total: projects.length,
    active: projects.filter((project) => (project?.status || 'В работе') === 'В работе').length,
    done: projects.filter((project) => (project?.status || '') === 'Завершён').length,
    danger: risks.filter((risk) => DANGER_LEVELS.includes(risk.level)).length,
    watch: risks.filter((risk) => WATCH_LEVELS.includes(risk.level)).length,
    overdue: risks.filter((risk) => risk.level === 'overdue').length,
    openTodos: projects.reduce((sum, project) => sum + openTodos(project).length, 0),
    avgProgress: projects.length === 0
      ? 0
      : Math.round(projects.reduce((sum, project) => sum + clampProgress(project), 0) / projects.length)
  }
}

/** Список модулей в сайдбаре: три фиксированных + встретившиеся свои, со счётчиками и рисками. */
export function railModules(projects, today = todayISO()) {
  const names = moduleNames(projects)
  return names.map((name) => {
    const items = projects.filter((project) => (project?.module || 'Другие проекты') === name)
    const stats = summarize(items, today)
    return { name, total: stats.total, danger: stats.danger + stats.watch, overdue: stats.overdue }
  })
}

/** Счётчики умных видов для сайдбара. */
export function railViews(projects, today = todayISO()) {
  return SMART_VIEWS.map((view) => ({
    ...view,
    total: projects.filter((project) => matchesSmartView(project, view.id, today)).length
  }))
}

/**
 * Группировка по модулям для секционного показа под «Все проекты».
 * Пустые модули не возвращаются; свои модули идут после фиксированных.
 */
export function groupByModule(projects, today = todayISO()) {
  return railModules(projects, today)
    .filter((entry) => entry.total > 0)
    .map((entry) => ({
      module: entry.name,
      projects: sortByRisk(projects.filter((project) => (project?.module || 'Другие проекты') === entry.name), today)
        .map((item) => item.project),
      stats: summarize(projects.filter((project) => (project?.module || 'Другие проекты') === entry.name), today)
    }))
}
