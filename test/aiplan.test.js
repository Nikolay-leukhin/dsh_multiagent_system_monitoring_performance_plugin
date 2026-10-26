import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AI_INTENTS, AI_OPS, applyPlan, matchProject, normalizePlan, planFromRules, planSchemaDoc,
  planSummary, previewPlan, projectSnapshot, resolveDate
} from '../src/shared/aiplan.js'

const TODAY = '2026-10-08' // четверг

const project = (over = {}) => ({
  id: over.id ?? 'p1',
  name: over.name ?? 'Переработка сервиса расчётов',
  module: over.module ?? 'Рабочие проекты',
  status: over.status ?? 'В работе',
  owner: over.owner ?? 'Я',
  dueDate: over.dueDate ?? '2026-10-06',
  startedOn: over.startedOn ?? '2026-09-08',
  progress: over.progress ?? 55,
  summary: over.summary ?? 'Разнести расчёты в отдельный сервис',
  tags: over.tags ?? ['Бэкенд'],
  updates: over.updates ?? [],
  todos: over.todos ?? [{ id: 't1', title: 'Дописать контрактные тесты', dueDate: '2026-10-05', done: false, doneAt: '' }],
  ...over
})

const POOL = [
  project(),
  project({ id: 'p2', name: 'Подключение домена заказов к платформе данных', module: 'Рабочие проекты' }),
  project({ id: 'p3', name: 'Квартальный техотчёт Q3', module: 'Текущие задачи', status: 'В работе', todos: [] })
]

const makeId = (() => { let n = 0; return (prefix) => `${prefix}-${++n}` })()

test('Экспортируемые константы покрывают шесть интентов и шесть действий', () => {
  assert.deepEqual(AI_INTENTS, ['add', 'update', 'delete', 'todo', 'log', 'query'])
  assert.deepEqual(AI_OPS, ['add', 'update', 'delete', 'addTodo', 'doneTodo', 'addLog'])
})

test('resolveDate разбирает абсолютные даты и частые относительные выражения', () => {
  assert.equal(resolveDate('2026-11-03', TODAY), '2026-11-03')
  assert.equal(resolveDate('2026-3-5', TODAY), '2026-03-05')
  assert.equal(resolveDate('Сегодня', TODAY), '2026-10-08')
  assert.equal(resolveDate('завтра', TODAY), '2026-10-09')
  assert.equal(resolveDate('послезавтра', TODAY), '2026-10-10')
  assert.equal(resolveDate('в следующую пятницу', TODAY), '2026-10-16')
  assert.equal(resolveDate('в эту пятницу', TODAY), '2026-10-09')
  assert.equal(resolveDate('конец месяца', TODAY), '2026-10-31')
  assert.equal(resolveDate('3 ноября', TODAY), '2026-11-03')
  assert.equal(resolveDate('+3 дня', TODAY), '2026-10-11')
  assert.equal(resolveDate('абы что', TODAY), '')
  assert.equal(resolveDate('', TODAY), '')
})

test('matchProject понимает id, полное имя, вхождение и ловит неоднозначность', () => {
  assert.equal(matchProject('p2', POOL).project.name, 'Подключение домена заказов к платформе данных')
  assert.equal(matchProject('Переработка сервиса расчётов', POOL).project.id, 'p1')
  assert.equal(matchProject('сервиса расчётов', POOL).project.id, 'p1')
  assert.match(matchProject('Несуществующий проект', POOL).reason, /не найден/)
  assert.match(matchProject('', POOL).reason, /Не указано/)
  assert.match(matchProject('сервис', [POOL[0], project({ id: 'p9', name: 'экспорт сервисов' })]).reason, /несколькими проектами/)
})

test('normalizePlan отбрасывает ненайденные проекты и пишет причину', () => {
  const plan = normalizePlan({
    intent: 'update',
    reply: 'поменяй',
    actions: [
      { op: 'update', target: 'Переработка сервиса расчётов', changes: { dueDate: 'в следующую пятницу', progress: 80 } },
      { op: 'delete', target: 'Совсем несуществующий проект' },
      { op: 'frobnicate', target: 'Переработка сервиса расчётов' }
    ]
  }, POOL, TODAY)
  assert.equal(plan.actions.length, 1)
  assert.deepEqual(plan.actions[0].changes, { dueDate: '2026-10-16', progress: 80 })
  assert.equal(plan.issues.length, 2)
  assert.ok(plan.issues.some((issue) => /не найден/.test(issue)))
  assert.ok(plan.issues.some((issue) => /Неизвестное действие/.test(issue)))
})

test('normalizePlan проверяет новый проект, статус и дату', () => {
  const plan = normalizePlan({
    intent: 'add',
    actions: [
      { op: 'add', name: 'Свой мини-мониторинг', module: 'Другие проекты', status: 'чепуха', dueDate: 'завтра', progress: 130, tags: ['Инструмент', ''] },
      { op: 'add', name: '   ' }
    ]
  }, POOL, TODAY)
  assert.equal(plan.actions.length, 1)
  const added = plan.actions[0].project
  assert.equal(added.status, 'В работе', 'Недопустимый статус откатывается к значению по умолчанию')
  assert.equal(added.dueDate, '2026-10-09')
  assert.equal(added.progress, 100, 'Прогресс зажимается в 0–100')
  assert.deepEqual(added.tags, ['Инструмент'])
  assert.ok(plan.issues.some((issue) => /нет названия проекта/.test(issue)))
})

test('normalizePlan выводит intent из действий и принимает query как есть', () => {
  const del = normalizePlan({ actions: [{ op: 'delete', target: 'p2' }] }, POOL, TODAY)
  assert.equal(del.intent, 'delete')
  const query = normalizePlan({ intent: 'query', reply: 'На этой неделе ничего не сдаётся.', actions: [] }, POOL, TODAY)
  assert.equal(query.intent, 'query')
  assert.equal(query.reply, 'На этой неделе ничего не сдаётся.')
})

test('normalizePlan обрабатывает некорректный ввод', () => {
  for (const bad of [null, undefined, 'x', []]) {
    const plan = normalizePlan(bad, POOL, TODAY)
    assert.deepEqual(plan.actions, [])
    assert.ok(plan.issues.length > 0)
  }
})

test('normalizePlan умеет задачи, закрытие задач и записи', () => {
  const plan = normalizePlan({
    intent: 'todo',
    actions: [
      { op: 'addTodo', target: 'сервиса расчётов', title: 'написать отчёт по нагрузочному тесту', dueDate: 'послезавтра' },
      { op: 'doneTodo', target: 'сервиса расчётов', title: 'контрактные тесты' },
      { op: 'addLog', target: 'Квартальный техотчёт Q3', kind: 'progress', text: 'Сбор метрик завершён' }
    ]
  }, POOL, TODAY)
  assert.equal(plan.actions.length, 3)
  assert.equal(plan.actions[0].dueDate, '2026-10-10')
  assert.equal(plan.actions[1].todoId, 't1')
  assert.equal(plan.actions[2].kind, 'progress')
})

test('previewPlan строит читабельный предпросмотр с группировкой', () => {
  const plan = normalizePlan({
    intent: 'update',
    actions: [
      { op: 'add', name: 'Новый проект', module: 'Текущие задачи', dueDate: '2026-10-20', summary: 'одна фраза' },
      { op: 'update', target: 'сервиса расчётов', changes: { dueDate: '2026-10-16', progress: 80, status: 'Блокер' } },
      { op: 'delete', target: 'Подключение домена заказов к платформе данных' },
      { op: 'addTodo', target: 'сервиса расчётов', title: 'написать отчёт по нагрузочному тесту' },
      { op: 'addLog', target: 'Квартальный техотчёт Q3', kind: 'note', text: 'Сверили формулировки с руководителем' }
    ]
  }, POOL, TODAY)
  const preview = previewPlan(plan, POOL, TODAY)
  assert.equal(preview.total, 5)
  assert.deepEqual(preview.groups.map((group) => group.key), ['add', 'update', 'delete', 'todo', 'log'])
  const updateLine = preview.groups.find((group) => group.key === 'update').lines[0]
  assert.match(updateLine, /Дедлайн 2026-10-06 → 2026-10-16/)
  assert.match(updateLine, /Прогресс 55% → 80%/)
  assert.match(updateLine, /Статус В работе → Блокер/)
  assert.match(preview.groups.find((group) => group.key === 'todo').lines[0], /добавлено: написать отчёт по нагрузочному тесту/)
  assert.equal(planSummary(plan), 'добавлено: 1, изменено: 1, удалено: 1, задач: 1, записей: 1')
})

test('applyPlan за один раз применяет все добавления, изменения и удаления', () => {
  const plan = normalizePlan({
    actions: [
      { op: 'add', name: 'Новый проект', module: 'Текущие задачи', dueDate: '2026-10-20' },
      { op: 'update', target: 'сервиса расчётов', changes: { dueDate: '2026-10-16', progress: 80 } },
      { op: 'delete', target: 'Подключение домена заказов к платформе данных' },
      { op: 'addTodo', target: 'сервиса расчётов', title: 'написать отчёт по нагрузочному тесту', dueDate: '2026-10-12' },
      { op: 'doneTodo', target: 'сервиса расчётов', title: 'контрактные тесты' },
      { op: 'addLog', target: 'Квартальный техотчёт Q3', kind: 'progress', text: 'Сбор метрик завершён' }
    ]
  }, POOL, TODAY)
  const state = { version: 1, seededAt: '', projects: POOL }
  const { next, applied } = applyPlan(state, plan, TODAY, makeId)
  assert.equal(applied, 6)
  assert.equal(next.projects.length, 3, 'Добавили 1 и удалили 1 — всего не изменилось')
  assert.ok(next.projects.some((item) => item.name === 'Новый проект'))
  assert.ok(!next.projects.some((item) => item.name === 'Подключение домена заказов к платформе данных'))
  const order = next.projects.find((item) => item.id === 'p1')
  assert.equal(order.dueDate, '2026-10-16')
  assert.equal(order.progress, 80)
  assert.equal(order.todos.length, 2)
  assert.equal(order.todos.find((todo) => todo.id === 't1').done, true)
  assert.equal(next.projects.find((item) => item.id === 'p3').updates[0].text, 'Сбор метрик завершён')
  assert.equal(state.projects.length, 3, 'Исходное состояние не мутируется')
  assert.ok(order.updatedAt)
})

test('applyPlan безопасен для неизвестных проектов и пустого плана', () => {
  const state = { version: 1, projects: POOL }
  assert.deepEqual(applyPlan(state, { actions: [] }, TODAY, makeId).next.projects, POOL)
  const orphan = { actions: [{ op: 'update', projectId: 'nope', changes: { progress: 10 } }] }
  const result = applyPlan(state, orphan, TODAY, makeId)
  assert.equal(result.applied, 0)
  assert.deepEqual(result.next.projects, POOL)
})

test('planFromRules распознаёт запрос, добавление, изменение, удаление, задачу и запись', () => {
  const query = planFromRules('Что сдаём на этой неделе?', POOL, TODAY)
  assert.equal(query.intent, 'query')
  assert.ok(query.reply.length > 0)

  const add = planFromRules('Добавь проект: Свой мини-мониторинг, в «Другие проекты»', POOL, TODAY)
  assert.equal(add.intent, 'add')
  assert.equal(add.actions[0].project.name, 'Свой мини-мониторинг')
  assert.equal(add.actions[0].project.module, 'Другие проекты')

  const update = planFromRules('Перенеси дедлайн проекта «Переработка сервиса расчётов» на следующую пятницу, прогресс — 80%', POOL, TODAY)
  assert.equal(update.intent, 'update')
  assert.deepEqual(update.actions[0].changes, { progress: 80, dueDate: '2026-10-16' })

  const del = planFromRules('Удали «Подключение домена заказов к платформе данных»', POOL, TODAY)
  assert.equal(del.intent, 'delete')
  assert.equal(del.actions[0].name, 'Подключение домена заказов к платформе данных')

  const todoAdd = planFromRules('Добавь в «Переработка сервиса расчётов» задачу: написать отчёт по нагрузочному тесту, срок завтра', POOL, TODAY)
  assert.equal(todoAdd.intent, 'todo')
  assert.match(todoAdd.actions[0].title, /написать отчёт по нагрузочному тесту/)
  assert.equal(todoAdd.actions[0].dueDate, '2026-10-09')
})

test('planFromRules при ненайденном проекте даёт понятную подсказку, а не правит наугад', () => {
  const result = planFromRules('Перенеси дедлайн того самого на конец месяца', POOL, TODAY)
  assert.equal(result.actions.length, 0)
  assert.match(result.issues[0], /Не понял/)
})

test('planSchemaDoc и projectSnapshot дают модели стабильный контекст', () => {
  const doc = planSchemaDoc(TODAY)
  assert.match(doc, /Сегодня 2026-10-08/)
  assert.match(doc, /"op":"add"/)
  assert.match(doc, /только на реальные названия или id/)
  const snapshot = projectSnapshot(POOL, TODAY, 2)
  assert.equal(snapshot.length, 2)
  assert.deepEqual(snapshot[0].todo, [{ title: 'Дописать контрактные тесты', dueDate: '2026-10-05' }])
  assert.equal(snapshot[0].progress, 55)
})
