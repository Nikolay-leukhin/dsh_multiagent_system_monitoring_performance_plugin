import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DANGER_LEVELS, RISK_ORDER, clampProgress, daysLeft, formatRemaining, moduleNames,
  moduleRollup, openTodos, overview, projectRisk, slippage, sortByRisk, todayISO
} from '../src/shared/analysis.js'

const TODAY = '2026-10-10'

const project = (over = {}) => ({
  id: over.id ?? 'p1',
  name: over.name ?? 'Проект один',
  module: over.module ?? 'Рабочие проекты',
  status: over.status ?? 'В работе',
  dueDate: over.dueDate ?? '2026-10-30',
  startedOn: over.startedOn ?? '2026-10-01',
  progress: over.progress ?? 50,
  owner: over.owner ?? 'Я',
  summary: '',
  tags: [],
  updates: over.updates ?? [],
  todos: over.todos ?? [],
  ...over
})

test('todayISO использует локальный календарный день', () => {
  assert.equal(todayISO(new Date(2026, 0, 5)), '2026-01-05')
})

test('daysLeft / formatRemaining покрывают просрочку, сегодня, завтра и будущее', () => {
  assert.equal(daysLeft('2026-10-10', TODAY), 0)
  assert.equal(daysLeft('2026-10-13', TODAY), 3)
  assert.equal(daysLeft('2026-10-07', TODAY), -3)
  assert.equal(formatRemaining('2026-10-07', TODAY), 'Просрочено на 3 дн.')
  assert.equal(formatRemaining('2026-10-10', TODAY), 'Срок сегодня')
  assert.equal(formatRemaining('2026-10-11', TODAY), 'Срок завтра')
  assert.equal(formatRemaining('2026-10-20', TODAY), 'Осталось 10 дн.')
  assert.equal(formatRemaining('', TODAY), 'Без срока')
})

test('projectRisk определяет уровень риска по приоритету', () => {
  assert.equal(projectRisk(project({ status: 'Завершён', dueDate: '2026-01-01' }), TODAY).level, 'done')
  assert.equal(projectRisk(project({ dueDate: '2026-10-09' }), TODAY).level, 'overdue')
  assert.equal(projectRisk(project({ status: 'Блокер' }), TODAY).level, 'blocked')
  assert.equal(projectRisk(project({ dueDate: '' }), TODAY).level, 'unscheduled')
  assert.equal(projectRisk(project({ dueDate: '2026-10-12' }), TODAY).level, 'urgent')
  assert.equal(projectRisk(project({ dueDate: '2026-10-16' }), TODAY).level, 'soon')
  assert.equal(projectRisk(project({ dueDate: '2026-11-30', progress: 60 }), TODAY).level, 'normal')
})

test('projectRisk ловит проекты, где срок идёт, а прогресс отстаёт', () => {
  const slipping = project({ startedOn: '2026-10-01', dueDate: '2026-10-20', progress: 10 })
  assert.ok(slippage(slipping, TODAY) > 0.3)
  const risk = projectRisk(slipping, TODAY)
  assert.equal(risk.level, 'slipping')
  assert.match(risk.detail, /Прошло/)
})

test('у каждого уровня projectRisk есть label / tone / rank / detail', () => {
  const cases = [
    ['done', { status: 'Завершён' }],
    ['overdue', { dueDate: '2026-10-01' }],
    ['blocked', { status: 'Блокер' }],
    ['unscheduled', { dueDate: '' }],
    ['urgent', { dueDate: '2026-10-12' }],
    ['slipping', { startedOn: '2026-10-01', dueDate: '2026-10-20', progress: 5 }],
    ['soon', { dueDate: '2026-10-16' }],
    ['normal', { dueDate: '2026-11-30' }]
  ]
  for (const [level, over] of cases) {
    const risk = projectRisk(project(over), TODAY)
    assert.equal(risk.level, level, `ожидалось ${level}, получено ${risk.level}`)
    assert.ok(['danger', 'warn', 'ok', 'muted'].includes(risk.tone))
    assert.ok(typeof risk.label === 'string' && risk.label.length > 0)
    assert.ok(typeof risk.detail === 'string' && risk.detail.length > 0)
    assert.ok(Number.isSafeInteger(risk.rank))
  }
  assert.deepEqual(RISK_ORDER.map((level) => RISK_ORDER.indexOf(level)), [0, 1, 2, 3, 4, 5, 6, 7])
})

test('sortByRisk ставит опасные проекты вперёд, внутри уровня — по остатку дней', () => {
  const list = [
    project({ id: 'normal', name: 'В норме', dueDate: '2026-12-01' }),
    project({ id: 'overdue', name: 'Просрочено', dueDate: '2026-10-01' }),
    project({ id: 'urgent2', name: 'После срочных', dueDate: '2026-10-13' }),
    project({ id: 'urgent1', name: 'До срочных', dueDate: '2026-10-11' })
  ]
  const sorted = sortByRisk(list, TODAY).map((item) => item.project.id)
  assert.deepEqual(sorted, ['overdue', 'urgent1', 'urgent2', 'normal'])
})

test('clampProgress и openTodos переживают грязные данные', () => {
  assert.equal(clampProgress({ progress: 150 }), 100)
  assert.equal(clampProgress({ progress: -3 }), 0)
  assert.equal(clampProgress({}), 0)
  assert.equal(openTodos({ todos: [{ done: true }, { done: false }, null] }).length, 1)
})

test('moduleRollup и moduleNames покрывают фиксированные и свои модули', () => {
  const list = [
    project({ id: 'a', module: 'Рабочие проекты', dueDate: '2026-10-01' }),
    project({ id: 'b', module: 'Текущие задачи' }),
    project({ id: 'c', module: 'Пет-эксперимент', todos: [{ id: 't', title: 'x', done: false }] })
  ]
  assert.deepEqual(moduleNames(list).slice(0, 4), ['Рабочие проекты', 'Текущие задачи', 'Другие проекты', 'Пет-эксперимент'])
  const rollup = moduleRollup(list, 'Рабочие проекты', TODAY)
  assert.equal(rollup.total, 1)
  assert.equal(rollup.danger, 1)
  assert.equal(moduleRollup(list, 'Все', TODAY).total, 3)
  assert.equal(moduleRollup(list, 'Пет-эксперимент', TODAY).openTodos, 1)
})

test('overview сводит статусы, риски, задачи и список «требуют внимания»', () => {
  const list = [
    project({ id: 'a', name: 'A', dueDate: '2026-10-01' }),
    project({ id: 'b', name: 'B', status: 'Завершён' }),
    project({ id: 'c', name: 'C', dueDate: '2026-10-12', todos: [{ id: 't1', title: 'найти дизайн', dueDate: '2026-10-11', done: false }] })
  ]
  const data = overview(list, TODAY)
  assert.equal(data.total, 3)
  assert.equal(data.byStatus['Завершён'], 1)
  assert.equal(data.byRisk.overdue, 1)
  assert.equal(data.byRisk.urgent, 1)
  assert.equal(data.followUps.length, 1)
  assert.equal(data.followUps[0].projectName, 'C')
  assert.deepEqual(data.attention.map((item) => item.project.id), ['a', 'c', 'b'])
  assert.ok(data.dueSoon.every((item) => ['overdue', 'urgent', 'soon'].includes(item.risk.level)))
  assert.ok(DANGER_LEVELS.includes(data.attention[0].risk.level))
})

test('overview не падает на пустом списке', () => {
  const data = overview([], TODAY)
  assert.equal(data.total, 0)
  assert.deepEqual(data.followUps, [])
  assert.equal(data.modules.length >= 3, true)
})
