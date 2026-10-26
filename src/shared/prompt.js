/**
 * Превращает данные проектов в промпты для Agent и в частые черновики документов.
 * Панель только генерирует текст, копирует и экспортирует; отправку пользователь делает в соседней нативной сессии.
 */
import { clampProgress, formatRemaining, latestUpdate, openTodos, overview, projectRisk, sortByRisk } from './analysis.js'
const KIND_LABELS = { note: 'Запись', progress: 'Прогресс', blocker: 'Блокер', decision: 'Решение' }

function bullets(items, empty = '(пока нет)') {
  if (!items || items.length === 0) return empty
  return items.map((item) => `- ${item}`).join('\n')
}

/** Markdown-сводка одного проекта — общая для промптов и черновиков. */
export function projectBrief(project, today) {
  const risk = projectRisk(project, today)
  const updates = (Array.isArray(project?.updates) ? project.updates : [])
    .slice()
    .sort((a, b) => String(b?.at ?? '').localeCompare(String(a?.at ?? '')))
  const todos = openTodos(project)
  const doneTodos = (Array.isArray(project?.todos) ? project.todos : []).filter((todo) => todo?.done === true)
  return [
    `### ${project?.name ?? 'Без названия'}`,
    `- Модуль: ${project?.module || 'Другие проекты'}`,
    `- Статус: ${project?.status || 'В работе'}`,
    `- Прогресс: ${clampProgress(project)}%`,
    `- Ответственный: ${project?.owner || 'не указан'}`,
    `- Сроки: ${project?.startedOn || 'не задано'} → ${project?.dueDate || 'без срока'} (${formatRemaining(project?.dueDate, today)})`,
    `- Риск по срокам: ${risk.label} — ${risk.detail}`,
    project?.link ? `- Ссылка: ${project.link}` : '',
    project?.summary ? `- Кратко: ${project.summary}` : '',
    project?.tags?.length ? `- Теги: ${project.tags.join(', ')}` : '',
    '',
    `**Записи о прогрессе (новые → старые, всего ${updates.length})**`,
    bullets(updates.slice(0, 20).map((item) => `${String(item.at).slice(0, 10)} [${KIND_LABELS[item.kind] ?? 'запись'}] ${item.text}`)),
    '',
    `**Открытые задачи (${todos.length})**`,
    bullets(todos.map((todo) => `${todo.title}${todo.dueDate ? ' (срок ' + todo.dueDate + ')' : ''}${todo.owner ? ' — ' + todo.owner : ''}`)),
    '',
    `**Закрытые задачи (${doneTodos.length})**`,
    bullets(doneTodos.slice(0, 10).map((todo) => todo.title))
  ].filter((row) => row !== '').join('\n')
}

/** Markdown-сводка всех проектов в порядке риска. */
export function portfolioBrief(projects, today) {
  const sorted = sortByRisk(projects, today)
  if (sorted.length === 0) return '(в воркбенче пока нет проектов)'
  return sorted.map((item) => projectBrief(item.project, today)).join('\n\n')
}

function portfolioNumbers(projects, today) {
  const data = overview(projects, today)
  const modules = data.modules.filter((item) => item.total > 0)
    .map((item) => `- ${item.module}: проектов ${item.total} (в работе ${item.active}, критично ${item.danger}, на контроле ${item.openTodos})`)
  return [
    `- Всего проектов: ${data.total}`,
    `- Статусы: ${Object.entries(data.byStatus).map(([key, value]) => (key + ' ' + value)).join(', ') || 'нет'}`,
    `- Риски: ${Object.entries(data.byRisk).map(([key, value]) => (key + ' ' + value)).join(', ') || 'нет'}`,
    '- По модулям:',
    bullets(modules)
  ].join('\n')
}

/**
 * Промпт «пусть Agent проанализирует прогресс».
 * @param options — projects (все проекты), project (необязательно, фокус на одном), today.
 */
export function buildAnalysisPrompt({ projects = [], project = null, today }) {
  const scope = project ? 'этот проект' : 'эти проекты'
  const body = project ? projectBrief(project, today) : portfolioBrief(projects, today)
  return [
    `Ты — мой помощник по продвижению проектов. Сегодня ${today}.`,
    `Сделай анализ прогресса: ${scope}. Опирайся только на зарегистрированные данные, не выдумывай фактов, которых в них нет; если информации мало — прямо скажи «данных недостаточно».`,
    '',
    'Выведи по такой структуре:',
    '1. Текущий статус: что в графике, что уже поехало — вывод в одну-две фразы.',
    '2. Риски по срокам: по каждому проекту сопоставь оставшееся время и прогресс, отметь самые вероятные срывы и обоснуй.',
    '3. Блокеры и зависимости: найди в записях о прогрессе места, где мешают люди или внешние условия.',
    '4. Следующие шаги: 3–5 конкретных выполнимых действий, по каждому — проект и желаемый срок.',
    '5. Чего мне не хватает: перечисли данные, которые нужны для выводов, но не зарегистрированы.',
    '',
    '---',
    '',
    body
  ].join('\n')
}

const DOC_KINDS = {
  weekly: 'Недельный отчёт',
  status: 'Отчёт о статусе проектов',
  risk: 'Список рисков',
  meeting: 'Каркас протокола встречи'
}

export function docKinds() {
  return Object.entries(DOC_KINDS).map(([value, label]) => ({ value, label }))
}

/**
 * Собрать черновик документа (Markdown).
 * @param kind — weekly | status | risk | meeting.
 * @param options — projects, project (необязательно), today.
 */
export function buildDocDraft(kind, { projects = [], project = null, today }) {
  const only = project ? [project] : projects
  const label = DOC_KINDS[kind] ?? DOC_KINDS.status
  const title = project ? project.name : 'Все проекты'

  if (kind === 'risk') {
    const rows = sortByRisk(only, today).map((item) => {
      const risk = item.risk
      const todo = openTodos(item.project)
      return `| ${item.project.name} | ${item.project.module || 'Другие проекты'} | ${item.project.status || 'В работе'} | ${clampProgress(item.project)}% | ${item.project.dueDate || 'без срока'} | ${risk.label} — ${risk.detail} | ${todo.length} |`
    })
    return [
      `# Список рисков · ${title}`,
      '',
      `Сформировано: ${today}`,
      '',
      '| Проект | Модуль | Статус | Прогресс | Дедлайн | Риск | На контроле |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      rows.length > 0 ? rows.join('\n') : '| (проектов нет) |  |  |  |  |  |  |',
      '',
      '## Что делать',
      bullets(sortByRisk(only, today).filter((item) => item.risk.rank <= 4)
        .map((item) => `${item.project.name}: ${item.risk.detail}. Стоит сначала назначить ответственного и назвать новый срок.`), '(сейчас нет рисков, требующих эскалации)')
    ].join('\n')
  }

  if (kind === 'weekly') {
    return [
      `# Недельный отчёт · движение проектов (${today})`,
      '',
      '## 1. Общая картина',
      portfolioNumbers(only, today),
      '',
      '## 2. Прогресс за неделю',
      portfolioBrief(only, today),
      '',
      '## 3. План на следующую неделю',
      bullets(only.flatMap((item) => openTodos(item).slice(0, 3).map((todo) =>
        `${item.name}: ${todo.title}${todo.dueDate ? (' — до ' + todo.dueDate) : ''}`)), '(список задач пуст — допишите план на неделю)'),
      '',
      '## 4. Нужна помощь',
      bullets(sortByRisk(only, today).filter((item) => ['overdue', 'blocked', 'urgent', 'slipping'].includes(item.risk.level))
        .map((item) => `${item.project.name}: ${item.risk.detail}`), '(пока нет)')
    ].join('\n')
  }

  if (kind === 'meeting') {
    return [
      `# Протокол встречи · ${title} (${today})`,
      '',
      'Участники:',
      '',
      '## 1. Текущее состояние проектов',
      portfolioBrief(only, today),
      '',
      '## 2. Обсуждение и решения',
      '- (дополнить)',
      '',
      '## 3. Действия',
      '| Что | Ответственный | Срок | Статус |',
      '| --- | --- | --- | --- |',
      bullets(only.flatMap((item) => openTodos(item).map((todo) =>
        `| ${item.name}: ${todo.title} | ${todo.owner || 'не назначен'} | ${todo.dueDate || 'не назначен'} | Не начато |`)), '| (дополнить) |  |  |  |')
    ].join('\n')
  }

  const rows = sortByRisk(only, today).map((item) => {
    const latest = latestUpdate(item.project)
    return [
      `### ${item.project.name}`,
      `- Модуль / статус: ${item.project.module || 'Другие проекты'} / ${item.project.status || 'В работе'}`,
      `- Прогресс: ${clampProgress(item.project)}%, ${formatRemaining(item.project.dueDate, today)}`,
      `- Риск по срокам: ${item.risk.label} — ${item.risk.detail}`,
      `- Последнее: ${latest ? (String(latest.at).slice(0, 10) + ' ' + latest.text) : 'записей нет'}`,
      `- Далее: ${openTodos(item.project).map((todo) => todo.title).slice(0, 3).join('; ') || 'дополнить'}`
    ].join('\n')
  })
  return [
    `# Отчёт о статусе проектов · ${title} (${today})`,
    '',
    '## Кратко',
    portfolioNumbers(only, today),
    '',
    '## По проектам',
    rows.length > 0 ? rows.join('\n\n') : '(проектов нет)'
  ].join('\n')
}

/** Подсказка «кому отдавать» на панели; общая для черновиков и интерфейса. */
export function deliveryHint(kind) {
  return `Черновик «${DOC_KINDS[kind] ?? 'документ'}» готов: можно скопировать в соседнюю сессию и попросить Agent дополнить, либо скачать как Markdown.`
}
