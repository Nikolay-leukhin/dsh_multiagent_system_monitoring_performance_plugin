import test from 'node:test'
import assert from 'node:assert/strict'
import { QUESTION_EXAMPLES, answerQuestion } from '../src/shared/query.js'

const TODAY = '2026-10-08'

const project = (over = {}) => ({
  id: over.id ?? 'p1',
  name: over.name ?? 'Клиентская система расчётов',
  module: over.module ?? 'Рабочие проекты',
  status: over.status ?? 'В работе',
  dueDate: over.dueDate ?? '2026-10-30',
  startedOn: over.startedOn ?? '2026-10-01',
  progress: over.progress ?? 50,
  owner: over.owner ?? 'Я',
  summary: over.summary ?? '',
  tags: [],
  updates: over.updates ?? [],
  todos: over.todos ?? [],
  ...over
})

const POOL = [
  project({ id: 'a', name: 'Система расчётов', dueDate: '2026-10-01', todos: [{ id: 't1', title: 'сверка', dueDate: '2026-10-06', done: false }] }),
  project({ id: 'b', name: 'Редизайн сайта', module: 'Текущие задачи', dueDate: '2026-10-09' }),
  project({ id: 'c', name: 'мини-приложение', module: 'Другие проекты', status: 'Блокер', dueDate: '2026-11-20' }),
  project({ id: 'd', name: 'Материалы внутреннего обучения', module: 'Текущие задачи', dueDate: '2026-12-31', status: 'Завершён' })
]

test('Пустой вопрос и пустые данные дают читаемый ответ', () => {
  assert.match(answerQuestion('', POOL, TODAY).text, /Спросите/)
  assert.match(answerQuestion('где риски', [], TODAY).text, /пока нет проектов/)
})

test('Вопрос-обзор даёт общее распределение', () => {
  const answer = answerQuestion('как дела в целом?', POOL, TODAY)
  assert.match(answer.text, /Всего проектов: 4/)
  assert.match(answer.text, /По модулям/)
  assert.ok(answer.projectIds.length > 0)
})

test('Вопрос о рисках перечисляет только требующие внимания', () => {
  const answer = answerQuestion('где риски?', POOL, TODAY)
  assert.match(answer.text, /Проекты, требующие внимания/)
  assert.match(answer.text, /Система расчётов/)
  assert.ok(!answer.text.includes('Материалы внутреннего обучения'), 'Завершённые проекты не попадают в список рисков')
  assert.ok(answer.projectIds.includes('a'))
})

test('Вопрос про период фильтрует по дедлайну', () => {
  assert.match(answerQuestion('что сдаём на этой неделе?', POOL, TODAY).text, /Редизайн сайта/)
  assert.match(answerQuestion('Проекты со сроком сегодня', POOL, TODAY).text, /проектов с таким сроком нет/)
  assert.match(answerQuestion('что уже просрочено', POOL, TODAY).text, /Система расчётов/)
  assert.match(answerQuestion('что сдаём в этом месяце', POOL, TODAY).text, /Система расчётов/)
})

test('Вопрос о задачах перечисляет открытые, с фильтром по просрочке', () => {
  const all = answerQuestion('что у меня на контроле?', POOL, TODAY)
  assert.match(all.text, /сверка/)
  assert.equal(all.projectIds[0], 'a')
  const overdue = answerQuestion('какие задачи просрочены', POOL, TODAY)
  assert.match(overdue.text, /сверка/)
})

test('Упоминание проекта фокусирует ответ на нём', () => {
  const answer = answerQuestion('как сейчас мини-приложение?', POOL, TODAY)
  assert.match(answer.text, /мини-приложение/)
  assert.match(answer.text, /Блокер/)
  assert.deepEqual(answer.projectIds, ['c'])
})

test('Непонятный вопрос откатывается к списку «требуют внимания» и подсказке', () => {
  const answer = answerQuestion('посмотри ту штуку', POOL, TODAY)
  assert.match(answer.text, /Не понял/)
  assert.match(answer.text, /на неделе/)
})

test('Все примеры вопросов дают непустой ответ', () => {
  for (const example of QUESTION_EXAMPLES) {
    const answer = answerQuestion(example, POOL, TODAY)
    assert.ok(answer.text.length > 4, `слишком короткий ответ на ${example}`)
  }
})
