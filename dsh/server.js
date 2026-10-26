/**
 * Серверная точка входа пульта проектов.
 *
 * Две задачи:
 * 1. Хранить данные проектов воркбенча в каталоге данных DSH (`/api/project-console/state`);
 * 2. «AI-заполнение»: отдавать команду на естественном языке LLM, зарегистрированной хостом,
 *    чтобы получить план изменений (`/api/project-console/ai`). Модель только выдаёт JSON,
 *    а проверка, сопоставление и применение идут в чистых функциях клиента и сервера; если модель недоступна — локальные правила.
 */
import Schema from '@deepseek-ai/schemastery'
import { createProjectStore, MAX_STATE_BYTES, StateError } from './store.js'
import { normalizePlan, planFromRules, planSchemaDoc, projectSnapshot } from '../src/shared/aiplan.js'
import { todayISO } from '../src/shared/analysis.js'
import { answerQuestion } from '../src/shared/query.js'

export const name = 'dsh-workbench-project-console'
export const inject = ['connection']
export const Config = Schema.object({
  root: Schema.string().required()
})

const PREFIX = '/api/project-console'
const AI_TIMEOUT_MS = 40_000
const MAX_INSTRUCTION = 2000

async function readJsonBody(request) {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_STATE_BYTES) {
    throw new StateError('Тело запроса слишком большое.', 413)
  }
  const reader = request.body?.getReader()
  if (!reader) throw new StateError('Запросу нужно тело в формате JSON.')
  const chunks = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > MAX_STATE_BYTES) {
        await reader.cancel()
        throw new StateError('Тело запроса слишком большое.', 413)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new StateError('Тело запроса — не корректный JSON.')
  }
}

/** Вытащить JSON из вывода модели (терпит блок ```json и лишний текст вокруг). */
export function extractJson(text) {
  const raw = String(text ?? '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Модель не вернула план в JSON')
  return JSON.parse(body.slice(start, end + 1))
}

/** Склеить пачку блоков вывода модели в обычный текст. */
export function assemblyText(assembler) {
  return assembler.blocks()
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('')
}

/**
 * Вызвать LLM, зарегистрированную хостом, чтобы разобрать команду. Любой сбой шага — исключение, вызывающий откатывается к локальным правилам.
 */
async function askModel(ctx, { instruction, projects, today }) {
  const get = (service) => (typeof ctx.get === 'function' ? ctx.get(service) : undefined)
  const llm = get('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('Хост не предоставил доступный сервис llm')
  const defaults = get('agentDefaultModel')
  const route = typeof defaults?.currentSelection === 'function' ? defaults.currentSelection() : undefined
  if (!route?.provider || !route?.model) throw new Error('Не удалось определить модель по умолчанию')

  const { BlockAssembler, createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const system = [
    'Ты — ассистент по управлению проектами: переводишь команды пользователя на русском в план операций над данными воркбенча.',
    'Выведи только один JSON-объект, без пояснений и без текста вне блока кода.',
    planSchemaDoc(today)
  ].join('\n\n')
  const userText = [
    'Текущий снимок проектов (JSON, ссылаться можно только на имена или id из него):',
    JSON.stringify(projectSnapshot(projects, today)),
    '',
    `Команда пользователя: ${instruction}`
  ].join('\n')

  const assembler = new BlockAssembler()
  const signal = AbortSignal.timeout(AI_TIMEOUT_MS)
  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'dsh-workbench-project-console' } })],
    system,
    maxTokens: 1500,
    purpose: 'project-console-ai',
    signal
  })) {
    assembler.push(chunk)
  }
  const finish = assembler.finish
  if (finish && finish.kind !== 'stop') {
    const detail = finish.failure?.message ?? finish.reason?.kind ?? finish.kind
    throw new Error(`Вызов модели завершился некорректно: ${detail}`)
  }
  return { raw: extractJson(assemblyText(assembler)), model: `${route.provider}/${route.model}` }
}

export function apply(ctx, config) {
  const store = createProjectStore(config.root)
  const noStore = { 'cache-control': 'no-store' }
  const json = (payload, status = 200) => Response.json(payload, { status, headers: noStore })
  const fail = (error, fallback) =>
    json({ error: error instanceof StateError ? error.message : fallback },
      error instanceof StateError ? error.status : 500)

  ctx.connection.fetch.register({
    path: `${PREFIX}/meta`,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      try {
        return json({ plugin: name, ...(await store.meta()) })
      } catch (error) {
        return fail(error, 'Не удалось прочитать данные проектов.')
      }
    }
  })

  // На один путь можно зарегистрировать только один маршрут, поэтому чтение и запись делят путь и различаются по методу.
  ctx.connection.fetch.register({
    path: `${PREFIX}/state`,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        if (request?.method === 'POST') {
          return json(await store.write(await readJsonBody(request)))
        }
        const { revision, state } = await store.read()
        return json({ revision, state })
      } catch (error) {
        return fail(error, 'Не удалось обработать запрос к данным проектов.')
      }
    }
  })

  // AI-заполнение: естественный язык → план изменений (без записи; запись делает клиент после подтверждения через /state).
  ctx.connection.fetch.register({
    path: `${PREFIX}/ai`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const payload = await readJsonBody(request)
        const instruction = String(payload?.instruction ?? '').trim().slice(0, MAX_INSTRUCTION)
        if (!instruction) throw new StateError('Сначала введите команду.')
        const projects = Array.isArray(payload?.projects) ? payload.projects : []
        const today = /^\d{4}-\d{2}-\d{2}$/.test(String(payload?.today ?? '')) ? String(payload.today) : todayISO()

        try {
          const { raw, model } = await askModel(ctx, { instruction, projects, today })
          const plan = normalizePlan(raw, projects, today)
          if (plan.intent === 'query' && !plan.reply) plan.reply = answerQuestion(instruction, projects, today).text
          return json({ source: 'llm', model, today, plan })
        } catch (error) {
          const plan = planFromRules(instruction, projects, today)
          return json({
            source: 'rules',
            reason: error instanceof Error ? error.message : String(error),
            today,
            plan
          })
        }
      } catch (error) {
        return fail(error, 'Не удалось разобрать эту фразу.')
      }
    }
  })
}
