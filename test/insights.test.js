import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MODULE_ACCENTS, calendarMonth, followUpBuckets, headline, kpis, moduleAccentMap, moduleWorkload,
  monthKeyOf, monthLabel, ownerWorkload, progressBuckets, riskBreakdown, shiftMonth, statusColumns,
  statusTone, timelineModel
} from '../src/shared/insights.js'

const TODAY = '2026-10-08' // четверг; воскресенье этой недели = 2026-10-11

const project = (over = {}) => ({
  id: over.id ?? 'p1',
  name: over.name ?? 'Система расчётов',
  module: over.module ?? 'Рабочие проекты',
  status: over.status ?? 'В работе',
  owner: over.owner ?? 'Я',
  dueDate: over.dueDate ?? '2026-10-30',
  startedOn: over.startedOn ?? '2026-10-01',
  progress: over.progress ?? 50,
  tags: over.tags ?? [],
  updates: over.updates ?? [],
  todos: over.todos ?? [],
  ...over
})

const todo = (id, dueDate, done = false) => ({ id, title: `Дело ${id}`, owner: 'Я', dueDate, done, doneAt: '' })

const POOL = [
  project({ id: 'a', name: 'Система расчётов', dueDate: '2026-10-01', progress: 55, todos: [todo('t1', '2026-10-06'), todo('t2', '2026-10-09')] }),
  project({ id: 'b', name: 'Редизайн сайта', module: 'Текущие задачи', owner: 'Аня', dueDate: '2026-10-09', progress: 30, todos: [todo('t3', '2026-10-20')] }),
  project({ id: 'c', name: 'мини-приложение', module: 'Другие проекты', status: 'Блокер', dueDate: '2026-11-20', progress: 15 }),
  project({ id: 'd', name: 'Материалы внутреннего обучения', module: 'Текущие задачи', status: 'Завершён', dueDate: '2026-09-01', progress: 100 }),
  project({ id: 'e', name: 'Проект без срока', module: 'Другие проекты', status: 'Не начат', dueDate: '', progress: 0 }),
  project({ id: 'f', name: 'Отстающий проект', startedOn: '2026-09-01', dueDate: '2026-10-20', progress: 10 })
]

test('moduleAccentMap даёт каждому модулю стабильный цвет', () => {
  const map = moduleAccentMap(POOL)
  assert.deepEqual(Object.keys(map), ['Рабочие проекты', 'Текущие задачи', 'Другие проекты'])
  assert.deepEqual(Object.values(map), MODULE_ACCENTS.slice(0, 3))
  assert.deepEqual(moduleAccentMap(POOL), map, 'Один и тот же вход даёт одну и ту же карту')
})

test('statusTone покрывает фиксированные статусы и даёт запасной для неизвестных', () => {
  assert.equal(statusTone('Блокер'), 'danger')
  assert.equal(statusTone('Завершён'), 'ok')
  assert.equal(statusTone('В работе'), 'info')
  assert.equal(statusTone('что угодно'), 'muted')
})

test('kpis считает все числа за один проход', () => {
  const data = kpis(POOL, TODAY)
  assert.equal(data.total, 6)
  assert.equal(data.overdue, 1)
  assert.equal(data.blocked, 1)
  assert.equal(data.slipping, 1)
  assert.equal(data.unscheduled, 1)
  assert.equal(data.done, 1)
  assert.equal(data.openTodos, 3)
  assert.equal(data.todoOverdue, 1)
  assert.equal(data.weekDue, 1, 'Редизайн сайта 10-09 попадает в эту неделю')
  assert.equal(data.attention, data.danger + data.watch)
  assert.equal(data.danger + data.watch + data.normal + data.done + data.unscheduled, data.total)
})

test('riskBreakdown идёт от высокого риска к низкому, проценты корректны', () => {
  const rows = riskBreakdown(POOL, TODAY)
  const ranks = rows.map((row) => row.rank)
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b))
  assert.ok(rows.every((row) => row.count > 0))
  assert.equal(rows.reduce((sum, row) => sum + row.count, 0), POOL.length)
  for (const row of rows) assert.ok(row.percent > 0 && row.percent <= 100)
  assert.equal(rows[0].level, 'overdue')
})

test('statusColumns фиксирует порядок статусов, внутри — сортировка по риску', () => {
  const columns = statusColumns(POOL, TODAY)
  assert.deepEqual(columns.map((column) => column.status), ['В работе', 'Не начат', 'Блокер', 'Завершён', 'На паузе'])
  const doing = columns.find((column) => column.status === 'В работе')
  assert.deepEqual(doing.projects.map((item) => item.project.id), ['a', 'b', 'f'])
  assert.equal(columns.find((column) => column.status === 'Блокер').tone, 'danger')
  assert.equal(columns.find((column) => column.status === 'Завершён').stats.total, 1)
})

test('moduleWorkload даёт состав и доли по каждому модулю', () => {
  const rows = moduleWorkload(POOL, TODAY)
  assert.deepEqual(rows.map((row) => row.module), ['Рабочие проекты', 'Текущие задачи', 'Другие проекты'])
  const daily = rows.find((row) => row.module === 'Текущие задачи')
  assert.equal(daily.total, 2)
  assert.equal(daily.normal + daily.watch + daily.danger, 2)
  assert.equal(daily.accent, MODULE_ACCENTS[1])
  assert.ok(!rows.some((row) => row.total === 0))
})

test('progressBuckets покрывает 0–100, сумма сохраняется', () => {
  const buckets = progressBuckets([...POOL, project({ id: 'g', progress: 80 })])
  assert.deepEqual(buckets.map((bucket) => bucket.label), ['0%', '1-25%', '26-50%', '51-75%', '76-99%', '100%'])
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.count, 0), 7)
  assert.equal(buckets.find((bucket) => bucket.label === '100%').count, 1)
  assert.equal(buckets.find((bucket) => bucket.label === '76-99%').count, 1)
})

test('ownerWorkload агрегирует по людям, без ответственного — «Не указан»', () => {
  const rows = ownerWorkload([...POOL, project({ id: 'h', owner: '' })], TODAY)
  assert.equal(rows[0].owner, 'Я')
  assert.ok(rows.some((row) => row.owner === 'Не указан'))
  const li = rows.find((row) => row.owner === 'Аня')
  assert.equal(li.total, 1)
  assert.equal(li.openTodos, 1)
  assert.ok(rows.every((row) => row.total > 0))
})

test('shiftMonth / monthLabel корректны на переходе года', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12')
  assert.equal(shiftMonth('2026-12', 1), '2027-01')
  assert.equal(shiftMonth('мусор', 1), monthKeyOf())
  assert.equal(monthLabel('2026-10'), '10.2026')
  assert.equal(monthKeyOf('2026-10-08'), '2026-10')
})

test('calendarMonth строит сетку на 6 недель и отмечает сегодня и текущий месяц', () => {
  const model = calendarMonth(POOL, TODAY, '2026-10')
  assert.ok(model.weeks.length >= 5 && model.weeks.length <= 6, `неверное число недель: ${model.weeks.length}`)
  assert.equal(model.cells.length % 7, 0)
  assert.ok(model.weeks.every((week) => week.length === 7))
  const today = model.cells.find((cell) => cell.isToday)
  assert.equal(today.day, 8)
  assert.equal(today.inMonth, true)
  const firstWeek = model.weeks[0]
  assert.ok(firstWeek.some((cell) => !cell.inMonth), 'Первая неделя должна содержать дни предыдущего месяца')
  assert.equal(model.cells.filter((cell) => cell.inMonth).length, 31, 'в октябре 31 день')
})

test('calendarMonth кладёт дедлайны и задачи в нужные клетки', () => {
  const model = calendarMonth(POOL, TODAY, '2026-10')
  const dueCell = model.cells.find((cell) => cell.iso === '2026-10-09')
  assert.ok(dueCell.items.some((item) => item.kind === 'due' && item.title === 'Редизайн сайта'))
  assert.ok(dueCell.items.some((item) => item.kind === 'todo' && item.title === 'Дело t2'))
  assert.ok(dueCell.items.every((item, index, array) => array.findIndex((x) => x.key === item.key) === index), 'В одной клетке не должно быть дублей')
  const overdueTodo = model.cells.find((cell) => cell.iso === '2026-10-06')
  assert.equal(overdueTodo.items[0].tone, 'danger', 'Просроченные задачи подсвечиваются красным')
  assert.ok(model.monthItems >= 4)
  assert.ok(model.daysWithItems >= 3)
})

test('calendarMonth безопасен для пустых данных и проектов без дат', () => {
  const model = calendarMonth([project({ id: 'x', dueDate: '' })], TODAY, '2026-10')
  assert.equal(model.monthItems, 0)
  assert.equal(model.cells.length % 7, 0)
  assert.ok(model.cells.every((cell) => cell.items.length === 0))
})

test('timelineModel даёт позиции строк и отметку «сегодня»', () => {
  const model = timelineModel(POOL, TODAY)
  assert.ok(model.totalDays >= 7)
  assert.equal(model.rows.length, POOL.length)
  assert.ok(model.ticks.length >= 1)
  for (const row of model.rows) {
    assert.ok(row.leftPercent >= 0 && row.leftPercent <= 100)
    assert.ok(row.widthPercent > 0 && row.widthPercent <= 100)
    assert.ok(row.leftPercent + row.widthPercent <= 100.0001, 'полоса не должна выходить за правую границу')
    assert.ok(row.startIso <= row.endIso)
  }
  assert.ok(model.todayPercent > 0 && model.todayPercent < 100)
  assert.deepEqual(model.rows.map((row) => row.project.id), ['d', 'a', 'b', 'f', 'c', 'e'], 'Сортировка по дедлайну, без срока — в конце')
})

test('timelineModel безопасен для пустых данных и огромных диапазонов', () => {
  const empty = timelineModel([], TODAY)
  assert.deepEqual(empty.rows, [])
  assert.equal(empty.totalDays, 0)
  const long = timelineModel([project({ id: 'long', startedOn: '2024-01-01', dueDate: '2027-01-01' })], TODAY)
  assert.equal(long.totalDays, 210)
  assert.equal(long.padded, true)
  assert.ok(long.rows[0].widthPercent <= 100)
})

test('followUpBuckets раскладывает по срочности и сортирует', () => {
  const buckets = followUpBuckets(POOL, TODAY)
  assert.deepEqual(buckets.map((bucket) => bucket.key), ['overdue', 'today', 'week', 'later', 'none'])
  const byKey = Object.fromEntries(buckets.map((bucket) => [bucket.key, bucket]))
  assert.equal(byKey.overdue.total, 1)
  assert.equal(byKey.overdue.items[0].overdueDays, 2)
  assert.equal(byKey.week.total, 1, '10-09 попадает в эту неделю')
  assert.equal(byKey.later.total, 1, '10-20 — позже')
  const flat = buckets.flatMap((bucket) => bucket.items)
  assert.equal(flat.length, kpis(POOL, TODAY).openTodos)
  assert.ok(flat.every((item) => item.projectId && item.title))
})

test('headline меняет вывод в зависимости от данных', () => {
  assert.match(headline([], TODAY), /Проектов пока нет/)
  assert.match(headline(POOL, TODAY), /просрочено/)
  const calm = [project({ id: 'z', dueDate: '2026-12-01', progress: 50 })]
  assert.match(headline(calm, TODAY), /в графике/)
})
