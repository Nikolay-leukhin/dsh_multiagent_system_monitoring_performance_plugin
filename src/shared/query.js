/**
 * «Спросить»: правило-ориентированные ответы по уже сохранённым локальным данным.
 * Не нужны ни сессия, ни модель: открыл воркбенч и пользуйся; для глубокого анализа панель собирает промпт для Agent.
 */
import { DANGER_LEVELS, WATCH_LEVELS, clampProgress, daysLeft, endOfWeek, formatRemaining, latestUpdate, openTodos, overview, projectRisk, sortByRisk, todayISO } from './analysis.js'
const RISKY = [...DANGER_LEVELS, ...WATCH_LEVELS]

const line = (project, risk) => `· ${project.name} (${project.module || 'Другие проекты'} · ${project.status || 'В работе'} · ${formatRemaining(project.dueDate, risk.today)})${risk.detail ? ' — ' + risk.detail : ''}`

function projectLine(project, today) {
  const risk = projectRisk(project, today)
  return { text: line(project, { ...risk, today }), id: project.id }
}

function header(title, count) {
  return count === 0 ? `${title}: подходящих проектов нет.` : `${title} (${count})`
}

function answerRisky(projects, today) {
  const risky = sortByRisk(projects, today).filter((item) => RISKY.includes(item.risk.level))
  if (risky.length === 0) return { text: 'Сейчас нет проектов, требующих особого внимания: дедлайны и прогресс в норме.', projectIds: [] }
  const body = risky.map((item) => line(item.project, { ...item.risk, today })).join('\n')
  return {
    text: `${header('Проекты, требующие внимания', risky.length)}\n${body}`,
    projectIds: risky.map((item) => item.project.id)
  }
}

function answerDueWithin(projects, today, label, predicate) {
  const hits = sortByRisk(projects, today).filter((item) => predicate(item.project, today))
  if (hits.length === 0) return { text: `${label}: проектов с таким сроком нет.`, projectIds: [] }
  return {
    text: `${header(label, hits.length)}\n${hits.map((item) => line(item.project, { ...item.risk, today })).join('\n')}`,
    projectIds: hits.map((item) => item.project.id)
  }
}

function answerFollowUps(projects, today, filter) {
  const items = []
  for (const project of projects) {
    for (const todo of openTodos(project)) {
      if (filter && !filter(todo, today)) continue
      items.push({ project, todo })
    }
  }
  if (items.length === 0) return { text: 'Список на контроле пуст.', projectIds: [] }
  items.sort((a, b) => String(a.todo.dueDate || '9999').localeCompare(String(b.todo.dueDate || '9999')))
  const body = items.slice(0, 30).map(({ project, todo }) =>
    `· [${todo.done ? 'x' : ' '}] ${todo.title} · ${project.name}${todo.dueDate ? (' · срок ' + todo.dueDate) : ''}${todo.owner ? (' · ' + todo.owner) : ''}`).join('\n')
  return {
    text: `${header('Задачи на контроле', items.length)}\n${body}`,
    projectIds: [...new Set(items.map(({ project }) => project.id))]
  }
}

function answerProject(project, today) {
  const risk = projectRisk(project, today)
  const latest = latestUpdate(project)
  const todos = openTodos(project)
  const lines = [
    `${project.name} (${project.module || 'Другие проекты'})`,
    `Статус: ${project.status || 'В работе'} · прогресс: ${clampProgress(project)}% · ${formatRemaining(project.dueDate, today)}`,
    `Риск: ${risk.label} — ${risk.detail}`,
    project.owner ? `Ответственный: ${project.owner}` : '',
    project.summary ? `Описание: ${project.summary}` : '',
    latest ? `Последнее (${String(latest.at).slice(0, 10)}): ${latest.text}` : 'Записей о прогрессе пока нет',
    todos.length > 0 ? `Задач на контроле: ${todos.length}: ${todos.slice(0, 5).map((todo) => todo.title).join(', ')}` : 'Открытых задач нет'
  ]
  return { text: lines.filter(Boolean).join('\n'), projectIds: [project.id] }
}

function answerOverview(projects, today) {
  const data = overview(projects, today)
  if (data.total === 0) return { text: 'В воркбенче пока нет проектов. Нажмите «Новый проект» справа сверху.', projectIds: [] }
  const moduleLines = data.modules.filter((item) => item.total > 0)
    .map((item) => `· ${item.module}: ${item.total} · в работе ${item.active} · критично ${item.danger} · на контроле ${item.openTodos}`).join('\n')
  const danger = data.attention.filter((item) => RISKY.includes(item.risk.level)).slice(0, 5)
  return {
    text: [
      `Всего проектов: ${data.total}: ${Object.entries(data.byStatus).map(([key, value]) => (key + ' ' + value)).join(', ')}`,
      moduleLines ? `\nПо модулям:\n${moduleLines}` : '',
      `\nТребуют внимания: ${data.attention.filter((item) => RISKY.includes(item.risk.level)).length}, просрочено: ${data.byRisk.overdue ?? 0}.`,
      danger.length > 0 ? `\nВ первую очередь:\n${danger.map((item) => line(item.project, { ...item.risk, today })).join('\n')}` : ''
    ].filter(Boolean).join('\n'),
    projectIds: danger.map((item) => item.project.id)
  }
}

/** Ответить на вопрос на естественном языке; вернуть текст и id связанных проектов. */
export function answerQuestion(question, projects, today = todayISO()) {
  const raw = String(question ?? '').trim()
  const items = Array.isArray(projects) ? projects : []
  if (!raw) return { text: 'Спросите, например: что сдаём на этой неделе? где риски? что у меня на контроле?', projectIds: [] }
  if (items.length === 0) return { text: 'В воркбенче пока нет проектов — добавьте несколько, и я начну следить.', projectIds: [] }

  const named = items.find((project) => project?.name && raw.includes(project.name))
  if (named) return answerProject(named, today)

  if (/риск|опасн|проблем|срыв|авари|горит|под угрозой/i.test(raw)) return answerRisky(items, today)
  // Задачи идут раньше «просрочено»: вопрос «какие задачи просрочены» про задачи, а не про проекты.
  if (/контрол|задач|сделать|не сделано|действи|поручен/i.test(raw)) {
    if (/просроч|просрочен|опозда/i.test(raw)) return answerFollowUps(items, today, (todo, now) => (daysLeft(todo.dueDate, now) ?? 1) < 0)
    return answerFollowUps(items, today)
  }
  if (/просроч|опозда|срок прошёл|дедлайн прошёл|не успева/i.test(raw)) return answerDueWithin(items, today, 'Просроченные проекты', (project, now) => (daysLeft(project.dueDate, now) ?? 1) < 0)
  if (/сегодня/i.test(raw)) return answerDueWithin(items, today, 'Проекты со сроком сегодня', (project, now) => daysLeft(project.dueDate, now) === 0)
  if (/завтра/i.test(raw)) return answerDueWithin(items, today, 'Проекты со сроком завтра', (project, now) => daysLeft(project.dueDate, now) === 1)
  if (/недел|к пятниц|к концу/i.test(raw)) {
    const end = endOfWeek(today)
    return answerDueWithin(items, today, `Проекты со сроком на этой неделе (до ${end})`, (project, now) => {
      const left = daysLeft(project.dueDate, now)
      return left !== null && left >= 0 && project.dueDate <= end
    })
  }
  if (/месяц|месяце/i.test(raw)) {
    const month = today.slice(0, 7)
    return answerDueWithin(items, today, `Проекты со сроком в ${month}`, (project) => String(project.dueDate || '').startsWith(month))
  }
  if (/блок|заблокир|встал/i.test(raw)) {
    const blocked = items.filter((project) => project?.status === 'Блокер')
    if (blocked.length === 0) return { text: 'Заблокированных проектов нет.', projectIds: [] }
    return { text: `${header('Заблокированные проекты', blocked.length)}\n${blocked.map((project) => projectLine(project, today).text).join('\n')}`, projectIds: blocked.map((project) => project.id) }
  }
  if (/обзор|общ|в целом|как дела|статус|сводк|отчёт|отчет|распределен/i.test(raw)) return answerOverview(items, today)

  const risk = answerRisky(items, today)
  return {
    text: `Не понял «${raw}» — вот самое важное сейчас. Можно назвать проект или спросить: что на неделе, просрочено, на контроле, блокеры, обзор.\n${risk.text}`,
    projectIds: risk.projectIds
  }
}

/** Примеры вопросов для панели. */
export const QUESTION_EXAMPLES = ['что сдаём на этой неделе?', 'где риски?', 'что у меня на контроле?', 'как дела в целом?']
