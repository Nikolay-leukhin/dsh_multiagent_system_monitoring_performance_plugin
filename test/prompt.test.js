import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAnalysisPrompt, buildDocDraft, deliveryHint, docKinds, portfolioBrief, projectBrief } from '../src/shared/prompt.js'

const TODAY = '2026-10-08'

const project = (over = {}) => ({
  id: 'p1',
  name: 'Система расчётов',
  module: 'Рабочие проекты',
  status: 'В работе',
  dueDate: '2026-10-20',
  startedOn: '2026-10-01',
  progress: 40,
  owner: 'Я',
  summary: 'Перевести расчёты в онлайн',
  tags: ['Бэкенд', 'Финансы'],
  updates: [
    { id: 'u1', at: '2026-10-07T09:00:00.000Z', kind: 'progress', text: 'Доделать API сверки' },
    { id: 'u2', at: '2026-10-02T09:00:00.000Z', kind: 'blocker', text: 'Ждём подтверждения формата от финансов' }
  ],
  todos: [
    { id: 't1', title: 'Интеграция платежей', dueDate: '2026-10-15', done: false, owner: 'Я' },
    { id: 't2', title: 'Написать приёмочные кейсы', dueDate: '2026-10-01', done: true, doneAt: '2026-10-01T00:00:00.000Z' }
  ],
  ...over
})

test('projectBrief выдаёт ключевые поля, прогресс и задачи', () => {
  const text = projectBrief(project(), TODAY)
  assert.match(text, /### Система расчётов/)
  assert.match(text, /Прогресс: 40%/)
  assert.match(text, /Доделать API сверки/)
  assert.match(text, /Интеграция платежей/)
  assert.match(text, /Ждём подтверждения формата от финансов/)
  assert.match(text, /Написать приёмочные кейсы/)
})

test('projectBrief не падает на пустом проекте', () => {
  const text = projectBrief({ name: 'Пустой проект' }, TODAY)
  assert.match(text, /### Пустой проект/)
  assert.match(text, /Записи о прогрессе \(новые → старые, всего 0\)/)
})

test('portfolioBrief склеивает проекты в порядке риска', () => {
  const text = portfolioBrief([
    project({ id: 'n', name: 'Нормальный проект', dueDate: '2026-12-01' }),
    project({ id: 'o', name: 'Просроченный проект', dueDate: '2026-10-01' })
  ], TODAY)
  assert.ok(text.indexOf('Просроченный проект') < text.indexOf('Нормальный проект'))
  assert.match(portfolioBrief([], TODAY), /пока нет проектов/)
})

test('buildAnalysisPrompt содержит дату, диапазон и структуру вывода', () => {
  const text = buildAnalysisPrompt({ projects: [project()], today: TODAY })
  assert.match(text, /Сегодня 2026-10-08/)
  assert.match(text, /не выдумывай фактов/)
  assert.match(text, /Риск по срокам/)
  assert.match(text, /Следующие шаги/)
  assert.match(text, /Система расчётов/)
  const single = buildAnalysisPrompt({ projects: [project()], project: project({ name: 'Один проект' }), today: TODAY })
  assert.match(single, /этот проект/)
  assert.match(single, /Один проект/)
})

test('docKinds отдаёт четыре типа документов, deliveryHint — пояснение', () => {
  const kinds = docKinds().map((item) => item.value)
  assert.deepEqual(kinds, ['weekly', 'status', 'risk', 'meeting'])
  assert.match(deliveryHint('risk'), /Список рисков/)
})

test('buildDocDraft собирает черновики четырёх типов', () => {
  const options = { projects: [project()], today: TODAY }
  const weekly = buildDocDraft('weekly', options)
  assert.match(weekly, /# Недельный отчёт/)
  assert.match(weekly, /Прогресс за неделю/)
  assert.match(weekly, /План на следующую неделю/)

  const risk = buildDocDraft('risk', options)
  assert.match(risk, /# Список рисков/)
  assert.match(risk, /\| Проект \| Модуль \| Статус \| Прогресс \| Дедлайн \| Риск \| На контроле \|/)
  assert.match(risk, /Система расчётов/)

  const meeting = buildDocDraft('meeting', options)
  assert.match(meeting, /# Протокол встречи/)
  assert.match(meeting, /Действия/)

  const status = buildDocDraft('status', options)
  assert.match(status, /# Отчёт о статусе проектов/)
  assert.match(status, /Последнее:/)
})

test('Черновик по проекту содержит только этот проект', () => {
  const text = buildDocDraft('risk', {
    projects: [project({ id: 'x', name: 'Другой проект' }), project()],
    project: project(),
    today: TODAY
  })
  assert.match(text, /Система расчётов/)
  assert.ok(!text.includes('Другой проект'))
})
