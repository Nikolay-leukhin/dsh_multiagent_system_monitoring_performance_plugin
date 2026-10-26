import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTENTION_LEVELS, SMART_VIEWS, groupByModule, matchesSmartView, railModules, railViews,
  searchText, selectProjects, smartView, summarize
} from '../src/shared/views.js'

const TODAY = '2026-10-08' // четверг, воскресенье этой недели = 2026-10-11

const project = (over = {}) => ({
  id: over.id ?? 'p1',
  name: over.name ?? 'Система расчётов',
  module: over.module ?? 'Рабочие проекты',
  status: over.status ?? 'В работе',
  dueDate: over.dueDate ?? '2026-10-30',
  startedOn: over.startedOn ?? '2026-10-01',
  progress: over.progress ?? 50,
  owner: over.owner ?? 'Я',
  summary: over.summary ?? '',
  tags: over.tags ?? [],
  updates: over.updates ?? [],
  todos: over.todos ?? [],
  ...over
})

const POOL = [
  project({ id: 'a', name: 'Система расчётов', dueDate: '2026-10-01', todos: [{ id: 't1', title: 'сверка', dueDate: '2026-10-06', done: false }] }),
  project({ id: 'b', name: 'Редизайн сайта', module: 'Текущие задачи', dueDate: '2026-10-09', tags: ['дизайн'] }),
  project({ id: 'c', name: 'мини-приложение', module: 'Другие проекты', status: 'Блокер', dueDate: '2026-11-20' }),
  project({ id: 'd', name: 'Материалы внутреннего обучения', module: 'Текущие задачи', status: 'Завершён', dueDate: '2026-09-01', todos: [] }),
  project({ id: 'e', name: 'прототип пет-проекта', module: 'Пет-эксперимент', dueDate: '2026-12-31' })
]

test('Умные виды покрывают: требуют внимания / просрочено / неделя / на контроле / завершено', () => {
  assert.deepEqual(SMART_VIEWS.map((view) => view.id), ['attention', 'overdue', 'week', 'todos', 'done'])
  assert.equal(smartView('week').label, 'Дедлайн на неделе')
  assert.equal(smartView('nope'), null)
})

test('matchesSmartView фильтрует по условию', () => {
  const overdue = POOL[0]
  const thisWeek = POOL[1]
  const blocked = POOL[2]
  const done = POOL[3]

  assert.equal(matchesSmartView(overdue, 'overdue', TODAY), true)
  assert.equal(matchesSmartView(overdue, 'attention', TODAY), true)
  assert.equal(matchesSmartView(thisWeek, 'week', TODAY), true)
  assert.equal(matchesSmartView(blocked, 'attention', TODAY), true)
  assert.equal(matchesSmartView(blocked, 'overdue', TODAY), false)
  assert.equal(matchesSmartView(done, 'done', TODAY), true)
  assert.equal(matchesSmartView(done, 'attention', TODAY), false)
  assert.equal(matchesSmartView(overdue, 'todos', TODAY), true)
  assert.equal(matchesSmartView(thisWeek, 'todos', TODAY), false)
  assert.equal(matchesSmartView(POOL[4], '', TODAY), true, 'Пустой вид означает «без фильтра»')
})

test('ATTENTION_LEVELS содержит только опасный и наблюдаемый уровни', () => {
  assert.deepEqual(ATTENTION_LEVELS, ['overdue', 'blocked', 'urgent', 'slipping', 'soon'])
})

test('searchText покрывает название, ответственного, теги, задачи и последнюю запись', () => {
  const rich = project({
    name: 'Система расчётов', owner: 'Иван', tags: ['Финансы'],
    updates: [{ id: 'u', at: '2026-10-07T00:00:00.000Z', kind: 'note', text: 'интеграция завершена' }],
    todos: [{ id: 't', title: 'дописать кейсы', done: false }]
  })
  const text = searchText(rich)
  for (const needle of ['Система расчётов', 'Иван', 'Финансы', 'интеграция завершена', 'дописать кейсы']) {
    assert.ok(text.includes(needle.toLowerCase()), `${needle} должен находиться поиском`)
  }
})

test('selectProjects применяет модуль, умный вид и ключевое слово одновременно', () => {
  const byModule = selectProjects(POOL, { module: 'Текущие задачи' }, TODAY).map((item) => item.id)
  assert.deepEqual(byModule, ['b', 'd'])

  const byView = selectProjects(POOL, { view: 'attention' }, TODAY).map((item) => item.id)
  assert.deepEqual(byView, ['a', 'c', 'b'])

  const byKeyword = selectProjects(POOL, { keyword: 'мини-приложение' }, TODAY).map((item) => item.id)
  assert.deepEqual(byKeyword, ['c'])

  const combined = selectProjects(POOL, { module: 'Текущие задачи', view: 'done' }, TODAY).map((item) => item.id)
  assert.deepEqual(combined, ['d'])

  assert.deepEqual(selectProjects(POOL, { keyword: 'несуществующееслово' }, TODAY), [])
})

test('Результат selectProjects всегда отсортирован по риску', () => {
  const ids = selectProjects(POOL, {}, TODAY).map((item) => item.id)
  assert.deepEqual(ids, ['a', 'c', 'b', 'e', 'd'])
})

test('summarize считает итоги и средний прогресс', () => {
  const stats = summarize(POOL, TODAY)
  assert.equal(stats.total, 5)
  assert.equal(stats.done, 1)
  assert.equal(stats.overdue, 1)
  assert.equal(stats.openTodos, 1)
  assert.equal(stats.avgProgress, 50)
  assert.deepEqual(summarize([], TODAY), {
    total: 0, active: 0, done: 0, danger: 0, watch: 0, overdue: 0, openTodos: 0, avgProgress: 0
  })
})

test('railModules: фиксированные модули первыми, свои — после, со счётчиками', () => {
  const rail = railModules(POOL, TODAY)
  assert.deepEqual(rail.map((item) => item.name), ['Рабочие проекты', 'Текущие задачи', 'Другие проекты', 'Пет-эксперимент'])
  assert.equal(rail[0].total, 1)
  assert.equal(rail[1].total, 2)
  assert.equal(rail[0].overdue, 1, 'В «Рабочие проекты» есть один просроченный')
  assert.equal(rail[2].danger, 1, 'Блокер в «Другие проекты» считается требующим внимания')
})

test('railViews даёт счётчик для каждого умного вида', () => {
  const rail = railViews(POOL, TODAY)
  const byId = Object.fromEntries(rail.map((item) => [item.id, item.total]))
  assert.equal(byId.attention, 3)
  assert.equal(byId.overdue, 1)
  assert.equal(byId.week, 1)
  assert.equal(byId.todos, 1)
  assert.equal(byId.done, 1)
})

test('groupByModule отбрасывает пустые модули и сортирует проекты внутри по риску', () => {
  const groups = groupByModule(POOL, TODAY)
  assert.deepEqual(groups.map((group) => group.module), ['Рабочие проекты', 'Текущие задачи', 'Другие проекты', 'Пет-эксперимент'])
  const daily = groups.find((group) => group.module === 'Текущие задачи')
  assert.deepEqual(daily.projects.map((item) => item.id), ['b', 'd'], 'Внутри группы тоже сортировка по риску')
  assert.equal(daily.stats.total, 2)
  assert.ok(!groups.some((group) => group.module === 'Пустой модуль'))
})

test('groupByModule на пустом списке возвращает пустой массив', () => {
  assert.deepEqual(groupByModule([], TODAY), [])
})
