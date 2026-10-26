import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_FILE, StateError, createProjectStore, emptyState, sanitizeState } from '../dsh/store.js'

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), 'project-console-'))
  try {
    return await run(createProjectStore(root), root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const sample = {
  version: 1,
  projects: [{
    id: 'p1',
    name: 'Система расчётов',
    module: 'Рабочие проекты',
    status: 'В работе',
    dueDate: '2026-10-20',
    startedOn: '2026-10-01',
    progress: 40,
    updates: [{ id: 'u1', at: '2026-10-07T09:00:00.000Z', kind: 'progress', text: 'Доделать API сверки' }],
    todos: [{ id: 't1', title: 'Интеграция платежей', dueDate: '2026-10-15', done: false }]
  }]
}

test('Пустой каталог читается как пустой документ с версией 0', async () => {
  await withStore(async (store, root) => {
    const document = await store.read()
    assert.equal(document.revision, 0)
    assert.deepEqual(document.state.projects, [])
    const files = await readdir(root)
    assert.deepEqual(files, [], 'Чтение не должно создавать файлы')
  })
})

test('После записи версия растёт, данные читаются обратно как есть', async () => {
  await withStore(async (store, root) => {
    const first = await store.write({ revision: 0, state: sample })
    assert.equal(first.revision, 1)
    assert.equal(first.projectCount, 1)
    const document = await store.read()
    assert.equal(document.revision, 1)
    assert.equal(document.state.projects[0].name, 'Система расчётов')
    assert.equal(document.state.projects[0].todos[0].title, 'Интеграция платежей')
    const onDisk = JSON.parse(await readFile(join(root, STATE_FILE), 'utf8'))
    assert.equal(onDisk.revision, 1)
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), [])
  })
})

test('Устаревшая версия отвергается с 409', async () => {
  await withStore(async (store) => {
    await store.write({ revision: 0, state: sample })
    await assert.rejects(() => store.write({ revision: 0, state: sample }), (error) => {
      assert.ok(error instanceof StateError)
      assert.equal(error.status, 409)
      return true
    })
  })
})

test('Запись чистит грязные данные: без имени — отбрасывает, прогресс зажимает, дубли id правит', async () => {
  await withStore(async (store) => {
    await store.write({
      revision: 0,
      state: {
        projects: [
          { id: 'dup', name: 'A', progress: 180, todos: [{ title: '' }, { title: 'валидный', done: true }] },
          { id: 'dup', name: 'B', progress: -5 },
          { name: '   ' },
          null,
          'nope'
        ]
      }
    })
    const { state } = await store.read()
    assert.equal(state.projects.length, 2)
    assert.equal(state.projects[0].progress, 100)
    assert.equal(state.projects[0].todos.length, 1)
    assert.equal(state.projects[1].progress, 0)
    assert.notEqual(state.projects[0].id, state.projects[1].id)
    assert.equal(state.version, 1)
  })
})

test('seededAt сохраняется, но тоже нормализуется', async () => {
  await withStore(async (store) => {
    await store.write({ revision: 0, state: { seededAt: '2026-10-08T00:00:00.000Z', projects: [] } })
    const { state } = await store.read()
    assert.equal(state.seededAt, '2026-10-08T00:00:00.000Z')
    await store.write({ revision: 1, state: { seededAt: 'not-a-date', projects: [] } })
    assert.equal((await store.read()).state.seededAt, '', 'Некорректная метка времени должна вычищаться')
  })
})

test('sanitizeState отвергает не-объект', () => {
  for (const bad of [null, undefined, [], 'x', 3]) {
    assert.throws(() => sanitizeState(bad), StateError)
  }
  assert.deepEqual(sanitizeState(emptyState()), emptyState())
})

test('Повреждённый файл данных не перезаписывается молча', async () => {
  await withStore(async (store, root) => {
    await writeFile(join(root, STATE_FILE), '{ это не JSON', 'utf8')
    await assert.rejects(() => store.read(), (error) => {
      assert.ok(error instanceof StateError)
      assert.equal(error.status, 500)
      return true
    })
    await assert.rejects(() => store.write({ revision: 0, state: sample }), StateError)
    assert.equal(await readFile(join(root, STATE_FILE), 'utf8'), '{ это не JSON')
  })
})

test('meta отдаёт каталог, файл и счётчики для проверки живости', async () => {
  await withStore(async (store, root) => {
    await store.write({ revision: 0, state: sample })
    const meta = await store.meta()
    assert.equal(meta.root, root)
    assert.equal(meta.file, join(root, STATE_FILE))
    assert.equal(meta.projectCount, 1)
  })
})

test('Параллельные записи сериализуются, успешна только одна', async () => {
  await withStore(async (store) => {
    const results = await Promise.allSettled([
      store.write({ revision: 0, state: sample }),
      store.write({ revision: 0, state: sample })
    ])
    assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1)
    assert.equal(results.filter((item) => item.status === 'rejected').length, 1)
    assert.equal((await store.read()).revision, 1)
  })
})

test('Без каталога данных — ошибка, а не запись куда-то ещё', () => {
  assert.throws(() => createProjectStore(''), /каталог данных не настроен/)
})
