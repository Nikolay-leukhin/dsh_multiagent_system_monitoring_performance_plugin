import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, apply, inject, name } from '../dsh/server.js'

const PREFIX = '/api/project-console'

async function withServer(run) {
  const root = await mkdtemp(join(tmpdir(), 'project-console-api-'))
  const routes = []
  const ctx = { connection: { fetch: { register: (route) => routes.push(route) } } }
  try {
    apply(ctx, { root })
    await run({ routes, root })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const routeFor = (routes, path, method) => {
  const route = routes.find((item) => item.path === path && item.methods.includes(method))
  assert.ok(route, `нет маршрута ${method} ${path}`)
  return route
}

test('Серверная точка входа должна быть такой, как требует спецификация', () => {
  assert.equal(name, 'dsh-workbench-project-console')
  assert.deepEqual(inject, ['connection'])
  assert.equal(typeof Config, 'function', 'Config должен быть Schemastery-схемой, а не обычным объектом')
  assert.deepEqual(Config({ root: '/tmp/project-console' }), { root: '/tmp/project-console' })
  assert.throws(() => Config({}), /root/)
})

test('Все маршруты под своим префиксом, каждый путь регистрируется один раз', async () => {
  await withServer(async ({ routes }) => {
    assert.equal(routes.length, 3)
    for (const route of routes) {
      assert.ok(route.path.startsWith(`${PREFIX}/`), `${route.path} вне префикса воркбенча`)
      assert.equal(route.requestBody, 'buffered')
      assert.equal(typeof route.fetch, 'function')
      assert.ok(route.methods.length > 0)
    }
    // exact Fetch-маршрут у connection уникален по пути, повторная регистрация сразу бросает ошибку (проверено на живом хосте).
    assert.equal(new Set(routes.map((route) => route.path)).size, routes.length)
    assert.deepEqual(routeFor(routes, `${PREFIX}/state`, 'GET').methods, ['GET', 'POST'])
  })
})

test('GET /meta сообщает имя плагина и каталог данных', async () => {
  await withServer(async ({ routes, root }) => {
    const response = await routeFor(routes, `${PREFIX}/meta`, 'GET').fetch(new Request(`http://127.0.0.1${PREFIX}/meta`))
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.plugin, 'dsh-workbench-project-console')
    assert.equal(payload.root, root)
    assert.equal(payload.revision, 0)
    assert.equal(payload.projectCount, 0)
  })
})

test('GET/POST /state делают полный цикл чтения-записи и дают 409 на старую версию', async () => {
  await withServer(async ({ routes }) => {
    const stateRoute = routeFor(routes, `${PREFIX}/state`, 'GET')
    const initial = await (await stateRoute.fetch(new Request(`http://127.0.0.1${PREFIX}/state`))).json()
    assert.deepEqual(initial, { revision: 0, state: { version: 1, seededAt: '', projects: [] } })

    const body = {
      revision: 0,
      state: { version: 1, projects: [{ id: 'p1', name: 'Система расчётов', module: 'Рабочие проекты', dueDate: '2026-10-20', progress: 40 }] }
    }
    const write = routeFor(routes, `${PREFIX}/state`, 'POST')
    const written = await write.fetch(new Request(`http://127.0.0.1${PREFIX}/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }))
    assert.equal(written.status, 200)
    assert.deepEqual(await written.json(), { revision: 1, projectCount: 1 })

    const reread = await (await stateRoute.fetch(new Request(`http://127.0.0.1${PREFIX}/state`))).json()
    assert.equal(reread.revision, 1)
    assert.equal(reread.state.projects[0].name, 'Система расчётов')

    const stale = await write.fetch(new Request(`http://127.0.0.1${PREFIX}/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }))
    assert.equal(stale.status, 409)
    assert.match((await stale.json()).error, /другом окне/)
  })
})

const AI_PROJECT = { id: 'p1', name: 'Переработка сервиса расчётов', module: 'Рабочие проекты', status: 'В работе', dueDate: '2026-10-06', startedOn: '2026-09-08', progress: 55, todos: [], updates: [] }

/** Прогнать серверный AI-путь с фейковым сервисом llm: prompt → поток → сборка → разбор → нормализация. */
async function withAiServer(services, run) {
  const root = await mkdtemp(join(tmpdir(), 'project-console-ai-'))
  const routes = []
  const ctx = {
    connection: { fetch: { register: (route) => routes.push(route) } },
    get: (name) => services[name]
  }
  try {
    apply(ctx, { root })
    await run({ routes })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const streamOf = (chunks) => async function* stream() { for (const chunk of chunks) yield chunk }
const delta = (text) => ({ type: 'text-delta', index: 0, text })
const stop = () => ({ type: 'finish', reason: { kind: 'stop' } })
const defaults = { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
const aiRoute = (routes) => routeFor(routes, `${PREFIX}/ai`, 'POST')
const postAi = (route, body) => route.fetch(new Request(`http://127.0.0.1${PREFIX}/ai`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
}))

test('Когда модель доступна, /ai идёт через модель и сворачивает JSON в план', async () => {
  const calls = []
  await withAiServer({
    llm: { stream(options) { calls.push(options); return streamOf([
      delta('{"intent":"update","reply":"прогресс 80%","actions":['),
      delta('{"op":"update","target":"Переработка сервиса расчётов","changes":{"progress":80,"dueDate":"в следующую пятницу"}},{"op":"delete","target":"Несуществующий проект"}]}'),
      stop()
    ])() } },
    agentDefaultModel: defaults
  }, async ({ routes }) => {
    const response = await postAi(aiRoute(routes), { instruction: 'прогресс 80%, дедлайн — в следующую пятницу', projects: [AI_PROJECT], today: '2026-10-08' })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.source, 'llm')
    assert.equal(payload.model, 'deepseek-official/deepseek-flash')
    assert.equal(payload.today, '2026-10-08')
    assert.equal(payload.plan.intent, 'update')
    assert.equal(payload.plan.actions.length, 1, 'Ненайденные проекты должны отбрасываться')
    assert.deepEqual(payload.plan.actions[0].changes, { progress: 80, dueDate: '2026-10-16' })
    assert.ok(payload.plan.issues.some((issue) => /не найден/.test(issue)))
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'deepseek-official')
  assert.equal(calls[0].model, 'deepseek-flash')
  assert.equal(calls[0].maxTokens, 1500)
  assert.ok(calls[0].system.includes('JSON'))
  assert.match(calls[0].messages[0].content[0].text, /Переработка сервиса расчётов/)
  assert.match(calls[0].messages[0].content[0].text, /прогресс 80%/)
})

test('Вывод модели с блоком кода и лишним текстом тоже разбирается', async () => {
  await withAiServer({
    llm: { stream: () => streamOf([
      delta('Хорошо, вот план:\\n```json\\n{"intent":"add","reply":"добавлен проект","actions":[{"op":"add","name":"Пилот service mesh","module":"Рабочие проекты","dueDate":"конец месяца"}]}\\n```'),
      stop()
    ])() },
    agentDefaultModel: defaults
  }, async ({ routes }) => {
    const payload = await postAi(aiRoute(routes), { instruction: 'добавь пилот service mesh', projects: [AI_PROJECT], today: '2026-10-08' }).then((r) => r.json())
    assert.equal(payload.source, 'llm')
    assert.equal(payload.plan.actions[0].project.name, 'Пилот service mesh')
    assert.equal(payload.plan.actions[0].project.dueDate, '2026-10-31')
  })
})

test('Если модель вернула только query — отвечаем её reply, без reply откатываемся к локальному ответу', async () => {
  await withAiServer({
    llm: { stream: () => streamOf([delta('{"intent":"query","reply":"На этой неделе сдаётся только редизайн сайта.","actions":[]}'), stop()])() },
    agentDefaultModel: defaults
  }, async ({ routes }) => {
    const payload = await postAi(aiRoute(routes), { instruction: 'что сдаём на этой неделе', projects: [AI_PROJECT], today: '2026-10-08' }).then((r) => r.json())
    assert.equal(payload.plan.intent, 'query')
    assert.equal(payload.plan.reply, 'На этой неделе сдаётся только редизайн сайта.')
  })

  await withAiServer({
    llm: { stream: () => streamOf([delta('{"intent":"query","actions":[]}'), stop()])() },
    agentDefaultModel: defaults
  }, async ({ routes }) => {
    const payload = await postAi(aiRoute(routes), { instruction: 'что сдаём на этой неделе', projects: [AI_PROJECT], today: '2026-10-08' }).then((r) => r.json())
    assert.equal(payload.plan.intent, 'query')
    assert.ok(payload.plan.reply.length > 0, 'Если модель не дала reply, его подставляет локальный ответ')
  })
})

test('При ошибке модели, отсутствии JSON или сервиса — откат к локальным правилам', async () => {
  const cases = [
    { name: 'поток завершается ошибкой', services: { llm: { stream: () => streamOf([{ type: 'finish', reason: { kind: 'error', failure: { message: 'квота исчерпана' } } }])() }, agentDefaultModel: defaults }, match: /квота исчерпана/ },
    { name: 'в выводе нет JSON', services: { llm: { stream: () => streamOf([delta('Не знаю, как это менять'), stop()])() }, agentDefaultModel: defaults }, match: /не вернула план в JSON/ },
    { name: 'нет сервиса llm', services: { agentDefaultModel: defaults }, match: /llm/ },
    { name: 'нет модели по умолчанию', services: { llm: { stream: () => streamOf([stop()])() } }, match: /модель по умолчанию/ },
    { name: 'stream сразу бросает ошибку', services: { llm: { stream() { throw new Error('адаптер упал') } }, agentDefaultModel: defaults }, match: /адаптер упал/ }
  ]
  for (const item of cases) {
    await withAiServer(item.services, async ({ routes }) => {
      const response = await postAi(aiRoute(routes), { instruction: 'Поставь «Переработка сервиса расчётов» прогресс 90%', projects: [AI_PROJECT], today: '2026-10-08' })
      assert.equal(response.status, 200, item.name)
      const payload = await response.json()
      assert.equal(payload.source, 'rules', item.name)
      assert.match(payload.reason, item.match, item.name)
      assert.equal(payload.plan.actions[0].changes.progress, 90, item.name)
    })
  }
})

test('Без доступной модели /ai откатывается к локальным правилам и объясняет причину', async () => {
  await withServer(async ({ routes }) => {
    const ai = routeFor(routes, `${PREFIX}/ai`, 'POST')
    const call = (body) => ai.fetch(new Request(`http://127.0.0.1${PREFIX}/ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }))
    const projects = [{ id: 'p1', name: 'Переработка сервиса расчётов', module: 'Рабочие проекты', status: 'В работе', dueDate: '2026-10-06', startedOn: '2026-09-08', progress: 55, todos: [], updates: [] }]

    const update = await call({ instruction: 'Перенеси дедлайн проекта «Переработка сервиса расчётов» на следующую пятницу, прогресс — 80%', projects, today: '2026-10-08' })
    assert.equal(update.status, 200)
    const payload = await update.json()
    assert.equal(payload.source, 'rules', 'В тестовом хосте нет сервиса llm — должен быть откат к правилам')
    assert.match(payload.reason, /llm/)
    assert.equal(payload.plan.actions.length, 1)
    assert.deepEqual(payload.plan.actions[0].changes, { progress: 80, dueDate: '2026-10-16' })

    const query = await call({ instruction: 'Что сдаём на этой неделе?', projects, today: '2026-10-08' })
    const answered = await query.json()
    assert.equal(answered.plan.intent, 'query')
    assert.ok(answered.plan.reply.length > 0)
    assert.equal(answered.plan.actions.length, 0)
  })
})

test('/ai на пустую команду возвращает 4xx', async () => {
  await withServer(async ({ routes }) => {
    const ai = routeFor(routes, `${PREFIX}/ai`, 'POST')
    const response = await ai.fetch(new Request(`http://127.0.0.1${PREFIX}/ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '   ', projects: [] })
    }))
    assert.equal(response.status, 400)
  })
})

test('extractJson терпит блоки кода и лишний текст, assemblyText берёт только текстовые блоки', async () => {
  const { extractJson, assemblyText } = await import('../dsh/server.js')
  assert.deepEqual(extractJson('```json\n{"intent":"query"}\n```'), { intent: 'query' })
  assert.deepEqual(extractJson('Хорошо, вот план: {"intent":"add","actions":[]} всё'), { intent: 'add', actions: [] })
  assert.throws(() => extractJson('нет JSON'), /не вернула план в JSON/)
  const assembler = {
    blocks: () => [
      { type: 'text', text: '{"a"' },
      { type: 'tool-call', text: 'ignored' },
      { type: 'text', text: ':1}' }
    ]
  }
  assert.equal(assemblyText(assembler), '{"a":1}')
})

test('POST /state на некорректный JSON и слишком большое тело возвращает 4xx', async () => {
  await withServer(async ({ routes }) => {
    const write = routeFor(routes, `${PREFIX}/state`, 'POST')
    const broken = await write.fetch(new Request(`http://127.0.0.1${PREFIX}/state`, { method: 'POST', body: '{oops' }))
    assert.equal(broken.status, 400)

    const huge = await write.fetch(new Request(`http://127.0.0.1${PREFIX}/state`, {
      method: 'POST',
      headers: { 'content-length': String(9 * 1024 * 1024) },
      body: '{}'
    }))
    assert.equal(huge.status, 413)
  })
})
