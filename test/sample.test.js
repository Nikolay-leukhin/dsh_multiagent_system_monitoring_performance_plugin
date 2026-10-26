import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSampleProjects, sampleSummary } from '../src/shared/sample.js'
import { MODULES, openTodos, projectRisk } from '../src/shared/analysis.js'
import { railModules, summarize } from '../src/shared/views.js'
import { sanitizeState } from '../dsh/store.js'

const TODAY = '2026-10-08'

test('В каждом модуле создано минимум 3 демо-проекта', () => {
  const projects = buildSampleProjects(TODAY)
  assert.ok(projects.length >= 9, `демо-проектов слишком мало: ${projects.length}`)
  for (const module of MODULES) {
    const count = projects.filter((project) => project.module === module).length
    assert.ok(count >= 3, `${module}: всего ${count} демо`)
  }
  // Используем только три модуля из спецификации
  assert.deepEqual([...new Set(projects.map((project) => project.module))].sort(), [...MODULES].sort())
})

test('Поля демо-проектов полны, типы верны, id уникальны', () => {
  const projects = buildSampleProjects(TODAY)
  const ids = new Set()
  for (const project of projects) {
    assert.equal(typeof project.id, 'string')
    assert.ok(project.id.length > 0)
    assert.ok(!ids.has(project.id), `дубль id: ${project.id}`)
    ids.add(project.id)
    assert.ok(project.name.length > 0)
    assert.match(project.dueDate, /^\d{4}-\d{2}-\d{2}$/)
    assert.match(project.startedOn, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(project.progress >= 0 && project.progress <= 100)
    assert.ok(Array.isArray(project.updates))
    assert.ok(Array.isArray(project.todos))
    assert.ok(project.tags.includes('Пример'), 'У демо-проекта должен быть тег «Пример»')
    for (const todo of project.todos) {
      assert.equal(typeof todo.title, 'string')
      assert.equal(typeof todo.done, 'boolean')
      assert.match(todo.dueDate, /^\d{4}-\d{2}-\d{2}$/)
    }
    for (const item of project.updates) {
      assert.ok(['note', 'progress', 'blocker', 'decision'].includes(item.kind))
      assert.ok(item.text.length > 0)
    }
  }
})

test('В «Текущие задачи» должны быть доклад и квартальный отчёт', () => {
  const daily = buildSampleProjects(TODAY).filter((project) => project.module === 'Текущие задачи')
  assert.ok(daily.length >= 3)
  assert.ok(daily.some((project) => /доклад/i.test(project.name)), 'нет подготовки доклада')
  assert.ok(daily.some((project) => /техотчёт/i.test(project.name)), 'нет квартального отчёта')
  assert.ok(daily.every((project) => project.summary.length > 0), 'У каждого демо-проекта есть краткое описание')
})

test('Содержание демо близко к работе разработчика', () => {
  const projects = buildSampleProjects(TODAY)
  const text = projects
    .map((project) => [project.name, project.summary, ...(project.tags ?? []), ...(project.todos ?? []).map((todo) => todo.title)].join(' '))
    .join(' ')
  for (const needle of ['сервис', 'API', 'Зависимости', 'алерт', 'Производительность', 'Open-source', 'тест', 'код']) {
    assert.ok(text.includes(needle), `в демо-тексте должно быть слово: ${needle}`)
  }
  // Не должно оставаться старых кейсов, не связанных с разработкой
  for (const stale of ['возмещение', 'сравнение поставщиков', 'материалы для визита', 'Материалы внутреннего обучения']) {
    assert.ok(!text.includes(stale), `в демо не должно остаться старого: ${stale}`)
  }
})

test('Демо-данные покрывают разные уровни риска, разница видна сразу', () => {
  const projects = buildSampleProjects(TODAY)
  const levels = new Set(projects.map((project) => projectRisk(project, TODAY).level))
  for (const level of ['overdue', 'urgent', 'slipping', 'blocked', 'done', 'normal']) {
    assert.ok(levels.has(level), `нет демо-проекта с уровнем ${level}`)
  }
  const stats = summarize(projects, TODAY)
  assert.ok(stats.overdue >= 1)
  assert.ok(stats.openTodos >= 5, 'Слишком мало демо-задач')
})

test('Демо-данные строятся относительно даты, поэтому работают и в другой день', () => {
  const other = '2027-03-15'
  const projects = buildSampleProjects(other)
  const overdue = projects.filter((project) => projectRisk(project, other).level === 'overdue')
  assert.ok(overdue.length >= 1)
  for (const project of overdue) assert.ok(project.dueDate < other)
  const levels = new Set(projects.map((project) => projectRisk(project, other).level))
  assert.ok(levels.has('urgent') && levels.has('done'))
})

test('Одна и та же дата даёт один и тот же результат (повторяемо)', () => {
  assert.deepEqual(buildSampleProjects(TODAY), buildSampleProjects(TODAY))
})

test('Демо-данные проходят схлопывание структуры на слое хранилища', () => {
  const projects = buildSampleProjects(TODAY)
  const sanitized = sanitizeState({ version: 1, projects })
  assert.equal(sanitized.projects.length, projects.length, 'Ни один демо-проект не должен отбрасываться sanitize')
  assert.deepEqual(sanitized.projects.map((project) => project.id), projects.map((project) => project.id))
  assert.ok(sanitized.projects.every((project) => project.tags.includes('Пример')))
})

test('Боковая панель считает демо-данные по модулям', () => {
  const rail = railModules(buildSampleProjects(TODAY), TODAY)
  assert.deepEqual(rail.map((item) => item.name), MODULES)
  assert.ok(rail.every((item) => item.total >= 3))
})

test('sampleSummary описывает количество и распределение по модулям', () => {
  const summary = sampleSummary(buildSampleProjects(TODAY))
  assert.match(summary, /^демо-проектов: 12/)
  for (const module of MODULES) assert.ok(summary.includes(module), `${module} должен быть в описании`)
})
