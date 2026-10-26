import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const CODE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const PACKAGE_NAME = 'dsh-workbench-project-console'

/** Загрузить собранный артефакт по тому же протоколу, что и браузер: window.__ModuleLoader__.load({ id, factory }). */
function loadBundle() {
  let registration
  const stubWindow = { __ModuleLoader__: { load: (value) => { registration = value } } }
  new Function('window', CODE)(stubWindow)
  assert.ok(registration, 'Бандл должен вызывать window.__ModuleLoader__.load')
  return registration
}

/** Клиент может требовать только модули из общей базы хоста. */
const requireStub = (spec) => {
  if (spec === 'react') return React
  throw new Error(`бандл ссылается на модуль вне базовой линии: ${spec}`)
}

const loadPlugin = () => loadBundle().factory(requireStub)

/** Вызвать apply так же, как это делает Desktop, и получить регистрационные данные. */
function registerPlugin() {
  const plugin = loadPlugin()
  const registrations = []
  const effects = []
  const ctx = {
    effect: (callback) => { effects.push(callback()) },
    desktopWorkbenches: {
      register: (descriptor, Component) => {
        registrations.push({ descriptor, Component })
        return () => undefined
      }
    }
  }
  plugin.apply(ctx)
  return { plugin, registrations, effects }
}

const project = (over = {}) => ({
  id: over.id ?? 'p1',
  name: over.name ?? 'Система расчётов',
  module: over.module ?? 'Рабочие проекты',
  status: over.status ?? 'В работе',
  dueDate: over.dueDate ?? '2026-10-30',
  startedOn: over.startedOn ?? '2026-10-01',
  progress: over.progress ?? 40,
  owner: over.owner ?? 'Я',
  summary: over.summary ?? '',
  tags: over.tags ?? [],
  updates: over.updates ?? [{ id: 'u1', at: '2026-10-07T09:00:00.000Z', kind: 'progress', text: 'Интеграция API завершена' }],
  todos: over.todos ?? [{ id: 't1', title: 'Дописать приёмочные кейсы', dueDate: '2026-10-15', done: false }],
  ...over
})

const render = (plugin, portfolio) => renderToStaticMarkup(React.createElement(plugin.ConsoleView, { portfolio }))

const readyPortfolio = (projects) => ({
  status: 'ready', error: '', conflict: false, saving: false, revision: 3,
  state: { version: 1, projects }, reload: () => undefined, update: async () => true, setError: () => undefined
})

const SAMPLE = [
  project({ id: 'p2', name: 'Редизайн сайта', module: 'Текущие задачи', dueDate: '2026-10-10', progress: 30 }),
  project({ id: 'p1', name: 'Система расчётов, этап 2', module: 'Рабочие проекты', dueDate: '2026-10-01', progress: 55 }),
  project({ id: 'p3', name: 'Материалы для визита к клиенту', module: 'Другие проекты', status: 'Блокер', dueDate: '2026-11-20', progress: 15, todos: [] }),
  project({ id: 'p4', name: 'Материалы внутреннего обучения', module: 'Текущие задачи', status: 'Завершён', dueDate: '2026-09-01', progress: 100, todos: [] })
]

test('Бандл регистрируется под именем пакета и требует только общую базовую линию', () => {
  const registration = loadBundle()
  assert.equal(registration.id, PACKAGE_NAME)
  const specs = [...CODE.matchAll(/__require\("([^"]+)"\)/g)].map((match) => match[1])
  const bare = [...new Set(specs.filter((spec) => !spec.includes('/')))]
  assert.deepEqual(bare, ['react'])
  assert.ok(!/^import\s/m.test(CODE), 'В бандле не должно оставаться ESM import')
  assert.ok(!/^export\s/m.test(CODE), 'В бандле не должно оставаться ESM export')
})

test('Плагин экспортирует apply и inject', () => {
  const plugin = loadPlugin()
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['desktopWorkbenches'])
})

test('Дескриптор регистрации: встроенная панель слева, заголовок, репозиторий GitHub, границы раскладки', () => {
  const { registrations, effects } = registerPlugin()
  assert.equal(registrations.length, 1)
  assert.equal(effects.length, 1)
  assert.equal(typeof effects[0], 'function', 'Возврат register должен управляться через ctx.effect')
  const { descriptor, Component } = registrations[0]
  assert.equal(descriptor.title, 'Пульт проектов')
  assert.match(descriptor.repository, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/)
  assert.equal(descriptor.id, undefined, 'Новый пакет не заполняет старый register({ id })')
  assert.equal(descriptor.embedded, true, 'Встроенной панели слева нужен embedded')
  assert.equal(descriptor.layout.businessSide, 'left')
  assert.ok(descriptor.layout.businessWidth >= 0.25 && descriptor.layout.businessWidth <= 0.7)
  assert.equal(typeof Component, 'function')
})

test('Зарегистрированная панель — ProjectConsole, подключённый к данным', () => {
  const { plugin, registrations } = registerPlugin()
  assert.equal(registrations[0].Component, plugin.ProjectConsole)
  assert.equal(typeof plugin.ConsoleView, 'function')
  assert.notEqual(plugin.ProjectConsole, plugin.ConsoleView)
})

test('Без проектов: вкладки, навигация по модулям, KPI и «Спросить» на месте', () => {
  const { plugin } = registerPlugin()
  const html = render(plugin, readyPortfolio([]))
  assert.match(html, /Пульт проектов/)
  for (const label of ['Обзор', 'По модулям', 'По статусам', 'Список', 'Календарь', 'Таймлайн', 'На контроле']) {
    assert.ok(html.includes(label), `нет вкладки: ${label}`)
  }
  assert.match(html, /role="tablist"/)
  assert.match(html, /Умные виды/)
  assert.match(html, /Все проекты/)
  assert.match(html, /Всего проектов/)
  assert.match(html, /Спросить/)
  assert.match(html, /Проектов пока нет/)
  assert.match(html, /Новый проект/)
  assert.match(html, /AI-заполнение/)
  assert.match(html, /Сохранено · версия 3/)
})

test('С данными: обзор рисует KPI и четыре графика', () => {
  const { plugin } = registerPlugin()
  const html = render(plugin, readyPortfolio(SAMPLE))
  assert.match(html, /Проектов: 4 · Модулей: 3/)
  assert.match(html, /Всего проектов/)
  assert.match(html, /Требуют внимания/)
  assert.match(html, /Распределение рисков/)
  assert.match(html, /pc-donut/)
  assert.match(html, /pc-legend/)
  assert.match(html, /Нагрузка по модулям/)
  assert.match(html, /pc-stacked/)
  assert.match(html, /Распределение прогресса/)
  assert.match(html, /pc-hist/)
  assert.match(html, /Нагрузка по ответственным/)
  assert.match(html, /pc-rank/)
  assert.match(html, /Срочно требует внимания/)
  assert.match(html, /Дедлайн на неделе/)
  assert.match(html, /Система расчётов, этап 2/)
  assert.match(html, /Рабочие проекты/)
  assert.match(html, /pc-accent-indigo/)
})

test('Боковая панель считает по модулям, у каждого свой акцентный цвет', () => {
  const { plugin } = registerPlugin()
  const html = render(plugin, readyPortfolio(SAMPLE))
  assert.match(html, /pc-rail-item/)
  assert.match(html, /pc-rail-count/)
  assert.match(html, /Требуют внимания/)
  assert.match(html, /Просрочено/)
  assert.match(html, /Есть открытые задачи/)
  assert.match(html, /Завершён/)
})

test('При ошибке чтения рисуется сообщение и кнопка повтора', () => {
  const { plugin } = registerPlugin()
  const html = render(plugin, {
    status: 'error', error: 'Не удалось прочитать данные проектов.', conflict: false, saving: false, revision: 0,
    state: { version: 1, projects: [] }, reload: () => undefined, update: async () => true, setError: () => undefined
  })
  assert.match(html, /Не удалось прочитать данные проектов./)
  assert.match(html, /Ошибка чтения/)
  assert.match(html, /Повторить/)
})

test('Во время загрузки рисуется скелетон, а не пустота', () => {
  const { plugin } = registerPlugin()
  const html = render(plugin, {
    status: 'loading', error: '', conflict: false, saving: false, revision: 0,
    state: { version: 1, projects: [] }, reload: () => undefined, update: async () => true, setError: () => undefined
  })
  assert.match(html, /pc-skeleton/)
  assert.ok(!html.includes('Проектов пока нет'))
})
