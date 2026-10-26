/**
 * Панель пульта проектов.
 *
 * Верхняя панель (бренд / поиск / обновить / создать) + вкладки видов (обзор · по модулям · по статусам · список · календарь ·
 * таймлайн · на контроле) + навигация по модулям слева (ось модулей + умные виды) + основная область + карточка справа.
 * Все слои живут в основной области, выделенной хостом, и не перекрывают сайдбар Desktop, переключатель режимов и вход «Управление воркбенчами».
 *
 * Действия, зависящие от сессии (передать промпт Agent), пользователь выполняет копированием в соседнюю нативную сессию: панель не создаёт сессии,
 * не переписывает их принадлежность и не трогает рабочие области.
 */
import React from 'react'
import { ApiError, askAi, newId, readState, writeState } from './api.js'
import { CSS, STYLE_ID } from './styles.js'
import { Badge, Btn, Empty, Field, Icon, IconBtn, Modal, Notice, Progress, RiskBadge, SearchBox, Sheet, Toast, useToast } from './ui.js'
import { BoardScreen, CalendarScreen, FollowUpsScreen, KanbanScreen, ListScreen, OverviewScreen, TimelineScreen } from './screens.js'
import { MODULES, STATUSES, clampProgress, daysLeft, formatRemaining, moduleNames, openTodos, projectRisk, sortByRisk, todayISO } from '../shared/analysis.js'
import { QUESTION_EXAMPLES, answerQuestion } from '../shared/query.js'
import { buildAnalysisPrompt, buildDocDraft, docKinds, deliveryHint } from '../shared/prompt.js'
import { groupByModule, railModules, railViews, selectProjects, smartView, summarize } from '../shared/views.js'
import { buildSampleProjects, sampleSummary } from '../shared/sample.js'
import { applyPlan, planSummary, previewPlan, revalidatePlan } from '../shared/aiplan.js'
import { calendarMonth, followUpBuckets, kpis, moduleAccentMap, moduleWorkload, monthKeyOf, ownerWorkload, progressBuckets, riskBreakdown, shiftMonth, statusColumns, timelineModel } from '../shared/insights.js'
const h = React.createElement
const { useCallback, useEffect, useMemo, useRef, useState } = React
const DOCS = docKinds()
const KIND_LABELS = { note: 'Запись', progress: 'Прогресс', blocker: 'Блокер', decision: 'Решение' }
const PROGRESS_TONE = { overdue: 'danger', blocked: 'danger', urgent: 'danger', slipping: 'warn', soon: 'warn', done: 'ok' }
const ATTENTION = ['overdue', 'blocked', 'urgent', 'slipping', 'soon']

const AI_EXAMPLES = [
  'Перенеси дедлайн проекта «Переработка сервиса расчётов» на следующую пятницу, прогресс — 80%',
  'Новый проект: пилот service mesh, в «Рабочие проекты», дедлайн — конец месяца',
  'К докладу «Разбор инцидентов на проде» добавь задачу: до пятницы провести прогон',
  'Удали прототип мини-приложения',
  'Что сдаём на этой неделе?'
]

const TABS = [
  { id: 'overview', label: 'Обзор', icon: 'target' },
  { id: 'board', label: 'По модулям', icon: 'grid' },
  { id: 'kanban', label: 'По статусам', icon: 'inbox' },
  { id: 'list', label: 'Список', icon: 'list' },
  { id: 'calendar', label: 'Календарь', icon: 'calendar' },
  { id: 'timeline', label: 'Таймлайн', icon: 'clock' },
  { id: 'todos', label: 'На контроле', icon: 'check' }
]

function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}
ensureStyles()

/* ------------------------------------------------------------------ Данные */

function usePortfolio() {
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState({ version: 1, projects: [] })
  const stateRef = useRef(state)
  const revisionRef = useRef(0)
  const queue = useRef(Promise.resolve())

  const load = useCallback(async () => {
    setStatus('loading')
    setError('')
    setConflict(false)
    try {
      const data = await readState()
      stateRef.current = data.state
      revisionRef.current = data.revision
      setState(data.state)
      setRevision(data.revision)
      setStatus('ready')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось прочитать данные проектов.')
      setStatus('error')
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Записи сериализуются: подряд идущие операции не пишут каждая со своей версией.
  const update = useCallback((mutator) => {
    const run = async () => {
      const previous = stateRef.current
      let next
      try {
        next = mutator(previous)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Операция не удалась.')
        return false
      }
      if (!next || next === previous) return true
      stateRef.current = next
      setState(next)
      setSaving(true)
      try {
        const result = await writeState(revisionRef.current, next)
        revisionRef.current = Number(result?.revision) || revisionRef.current + 1
        setRevision(revisionRef.current)
        setConflict(false)
        setError('')
        return true
      } catch (cause) {
        stateRef.current = previous
        setState(previous)
        if (cause instanceof ApiError && cause.status === 409) {
          setConflict(true)
          setError(cause.message)
        } else {
          setError(cause instanceof Error ? cause.message : 'Не удалось сохранить.')
        }
        return false
      } finally {
        setSaving(false)
      }
    }
    const task = queue.current.then(run, run)
    queue.current = task.then(() => undefined, () => undefined)
    return task
  }, [])

  return { status, error, conflict, saving, revision, state, reload: load, update, setError }
}

/* ------------------------------------------------------------- Копирование и скачивание */

async function copyText(value) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch { /* откат на execCommand */ }
  try {
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', 'readonly')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

function downloadMarkdown(filename, value) {
  try {
    const blob = new Blob([value], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return true
  } catch {
    return false
  }
}

/* --------------------------------------------------------------- Модель формы */

function dateAfter(days) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return todayISO(date)
}

function blankDraft() {
  return {
    id: '', name: '', module: MODULES[0], status: 'В работе', owner: '',
    startedOn: todayISO(), dueDate: dateAfter(14), progress: 0, link: '', summary: '', tagText: ''
  }
}

function draftFromProject(project) {
  return {
    id: project.id,
    name: project.name ?? '',
    module: project.module || MODULES[0],
    status: project.status || 'В работе',
    owner: project.owner ?? '',
    startedOn: project.startedOn ?? '',
    dueDate: project.dueDate ?? '',
    progress: clampProgress(project),
    link: project.link ?? '',
    summary: project.summary ?? '',
    tagText: Array.isArray(project.tags) ? project.tags.join(', ') : ''
  }
}

function projectFromDraft(draft, existing) {
  const now = new Date().toISOString()
  const base = existing || { id: newId('proj'), createdAt: now, updates: [], todos: [] }
  return {
    ...base,
    name: draft.name.trim(),
    module: draft.module.trim() || 'Другие проекты',
    status: draft.status,
    owner: draft.owner.trim(),
    startedOn: draft.startedOn,
    dueDate: draft.dueDate,
    progress: clampProgress({ progress: Number(draft.progress) }),
    link: draft.link.trim(),
    summary: draft.summary.trim(),
    tags: draft.tagText.split(/[,;\s]+/).map((tag) => tag.trim()).filter(Boolean).slice(0, 20),
    updatedAt: now
  }
}

const touch = (project) => ({ ...project, updatedAt: new Date().toISOString() })

/* Демо-данные создаются автоматически один раз — при "первом входе и пустом документе". */
const SEED_FLAG = 'dsh-project-console-seeded'
function seedFlagSet() {
  try { return window.localStorage?.getItem(SEED_FLAG) === '1' } catch { return false }
}
function markSeedFlag() {
  try { window.localStorage?.setItem(SEED_FLAG, '1') } catch { /* не сохранилось — ладно */ }
}

/* ------------------------------------------------------------------ Спросить */

function AskCard({ projects, today }) {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState(null)
  const ask = (value) => {
    const asked = typeof value === 'string' ? value : question
    setQuestion(asked)
    setAnswer(answerQuestion(asked, projects, today))
  }
  return h('section', { className: 'pc-panel-block' },
    h('div', { className: 'pc-panel-head' },
      h(Icon, { name: 'sparkle', size: 14 }),
      h('h3', null, 'Спросить'),
      h('span', { className: 'pc-spacer' }),
      h('span', { className: 'pc-muted' }, 'Отвечает по локальным данным')),
    h('div', { className: 'pc-ask' },
      h('div', { className: 'pc-ask-row' },
        h(SearchBox, {
          value: question, onChange: setQuestion, label: 'Спросить о проектах',
          placeholder: 'Спросите: что сдаём на этой неделе? где риски?'
        }),
        h(Btn, { variant: 'primary', onClick: () => ask() }, 'Вопрос')),
      h('div', { className: 'pc-chips' }, QUESTION_EXAMPLES.map((example) => h('button', {
        key: example, type: 'button', className: 'pc-chip-btn', onClick: () => ask(example)
      }, example))),
      answer ? h('div', { className: 'pc-answer' }, h('div', null, answer.text)) : null))
}

/* --------------------------------------------------------------- AI-заполнение */

const AI_SOURCE_LABEL = { llm: 'Разбор моделью', rules: 'Локальный разбор' }

/** Естественный язык → план изменений → запись одним разом после подтверждения. */
function AiFillModal({ projects, today, onClose, onApplied }) {
  const [text, setText] = useState('')
  const [state, setState] = useState({ status: 'idle' })
  const plan = state.plan
  const preview = state.preview
  const pending = state.status === 'loading'
  const changeCount = plan?.actions?.length ?? 0

  const analyze = async (value) => {
    const instruction = (typeof value === 'string' ? value : text).trim()
    if (!instruction || pending) return
    setText(instruction)
    setState({ status: 'loading' })
    try {
      const payload = await askAi(instruction, projects, today)
      const next = revalidatePlan(payload.plan, projects)
      setState({
        status: 'ready',
        source: payload.source,
        model: payload.model,
        reason: payload.reason,
        plan: next,
        preview: previewPlan(next, projects, today)
      })
    } catch (error) {
      setState({ status: 'error', error: error instanceof Error ? error.message : 'Не удалось разобрать.' })
    }
  }

  const confirm = () => {
    if (!plan || changeCount === 0) return
    onApplied(plan)
    onClose()
  }

  const footer = plan && changeCount > 0 && state.status === 'ready'
    ? [
      h(Btn, { key: 'cancel', onClick: onClose }, 'Отмена'),
      h(Btn, { key: 'ok', variant: 'primary', icon: 'check', onClick: confirm }, `Применить изменений: ${changeCount}`)
    ]
    : [h(Btn, { key: 'close', onClick: onClose }, 'Закрыть')]

  return h(Modal, {
    open: true,
    title: 'AI-заполнение',
    icon: 'sparkle',
    onClose,
    footer
  },
  h('div', { className: 'pc-ai' },
    h('div', { className: 'pc-muted' },
      'Опишите одной фразой, что сделать: AI определит — добавить, изменить, удалить или спросить. Добавление, изменение и удаление выполняются только после подтверждения.'),
    h('textarea', {
      className: 'pc-textarea', value: text, 'aria-label': 'Команда для AI-заполнения',
      placeholder: 'Например: перенеси дедлайн проекта «Переработка сервиса расчётов» на следующую пятницу, прогресс — 80%',
      onChange: (event) => setText(event.target.value),
      onKeyDown: (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) analyze()
      }
    }),
    h('div', { className: 'pc-chips' }, AI_EXAMPLES.map((example) => h('button', {
      key: example, type: 'button', className: 'pc-chip-btn', onClick: () => analyze(example)
    }, example))),
    h('div', { className: 'pc-ai-actions' },
      h(Btn, { variant: 'primary', icon: 'sparkle', onClick: () => analyze(), disabled: pending || !text.trim() },
        pending ? 'Разбор…' : 'Разобрать'),
      h('span', { className: 'pc-muted' }, '⌘/Ctrl + Enter')),

    state.status === 'loading' ? h('div', { className: 'pc-skeleton', style: { height: 96 } }) : null,
    state.status === 'error' ? h(Notice, { tone: 'danger' }, state.error) : null,

    state.status === 'ready'
      ? h('div', { className: 'pc-ai-result' },
        h('div', { className: 'pc-ai-source' },
          h(Icon, { name: state.source === 'llm' ? 'sparkle' : 'note', size: 13 }),
          h('span', null, AI_SOURCE_LABEL[state.source] ?? 'Результат разбора'),
          state.model ? h('span', { className: 'pc-mono' }, state.model) : null,
          state.source === 'rules' && state.reason
            ? h('span', { className: 'pc-muted', title: state.reason }, `(${String(state.reason).slice(0, 60)})`)
            : null),
        plan.reply ? h('div', { className: 'pc-answer' }, h('div', null, plan.reply)) : null,
        changeCount > 0 && preview
          ? h('div', { className: 'pc-plan' }, preview.groups.map((group) => h('div', { className: 'pc-plan-group', key: group.key },
            h('div', { className: 'pc-plan-title' }, group.title, h('span', { className: 'pc-pill' }, String(group.lines.length))),
            h('ul', { className: 'pc-plan-lines' }, group.lines.map((line, index) => h('li', { key: `${group.key}-${index}` }, line))))))
          : null,
        changeCount > 0
          ? h('div', { className: 'pc-muted' }, 'Изменения запишутся сразу после нажатия «Применить».')
          : null,
        plan.issues?.length
          ? h(Notice, { tone: 'warn' }, h('div', null, plan.issues.map((issue, index) => h('div', { key: index }, `· ${issue}`))))
          : null)
      : null))
}

/* ------------------------------------------------------------------ Карточка */

function DetailBody({ project, risk, today, onChange, ai, onEdit, onDelete }) {
  const [kind, setKind] = useState('progress')
  const [text, setText] = useState('')
  const [todoTitle, setTodoTitle] = useState('')
  const [todoDue, setTodoDue] = useState('')
  const todos = Array.isArray(project.todos) ? project.todos : []
  const updates = (Array.isArray(project.updates) ? project.updates : [])
    .slice()
    .sort((a, b) => String(b?.at ?? '').localeCompare(String(a?.at ?? '')))
  const open = openTodos(project)

  const addUpdate = () => {
    const body = text.trim()
    if (!body) return
    onChange(touch({
      ...project,
      updates: [...(project.updates || []), { id: newId('upd'), at: new Date().toISOString(), kind, text: body }]
    }))
    setText('')
  }

  const addTodo = () => {
    const title = todoTitle.trim()
    if (!title) return
    onChange(touch({
      ...project,
      todos: [...todos, { id: newId('todo'), title, owner: '', dueDate: todoDue, done: false, doneAt: '' }]
    }))
    setTodoTitle('')
    setTodoDue('')
  }

  const facts = [
    ['Модуль', project.module || 'Другие проекты'],
    ['Статус', project.status || 'В работе'],
    ['Ответственный', project.owner || 'Не указан'],
    ['Прогресс', `${clampProgress(project)}%`],
    ['Начало', project.startedOn || 'Не задано'],
    ['Дедлайн', project.dueDate || 'Без срока'],
    ['Осталось', formatRemaining(project.dueDate, today)],
    ['Обновлено', String(project.updatedAt || '').slice(0, 10) || '—']
  ]

  return h(React.Fragment, null,
    h('div', { className: 'pc-grid2' }, facts.map(([label, value]) => h('div', { className: 'pc-fact', key: label },
      h('span', null, label), h('strong', null, value)))),

    h('div', { className: 'pc-block' },
      h('div', { className: 'pc-block-head' }, h('h3', null, 'Риск по срокам')),
      h(Progress, { value: project.progress, tone: PROGRESS_TONE[risk.level] ?? '' }),
      h('div', { className: 'pc-chips' }, h(Badge, { tone: risk.tone, dot: true }, risk.label), h('span', { className: 'pc-muted' }, risk.detail))),

    project.summary || project.link || project.tags?.length
      ? h('div', { className: 'pc-block' },
        h('div', { className: 'pc-block-head' }, h('h3', null, 'Описание')),
        project.summary ? h('div', null, project.summary) : null,
        project.link
          ? h('div', null, h('a', { className: 'pc-mono', href: project.link, target: '_blank', rel: 'noreferrer noopener' }, project.link))
          : null,
        project.tags?.length
          ? h('div', { className: 'pc-card-tags' }, project.tags.map((tag) => h('span', { key: tag, className: 'pc-tag' }, tag)))
          : null)
      : null,

    h('div', { className: 'pc-block' },
      h('div', { className: 'pc-block-head' }, h('h3', null, `Записи о прогрессе · ${updates.length}`)),
      h('div', { className: 'pc-composer' },
        h('select', {
          className: 'pc-select', style: { maxWidth: '92px' }, value: kind, 'aria-label': 'Тип записи',
          onChange: (event) => setKind(event.target.value)
        }, Object.keys(KIND_LABELS).map((key) => h('option', { key, value: key }, KIND_LABELS[key]))),
        h('input', {
          className: 'pc-input', value: text, placeholder: 'Что сделано / где застряли / что решили',
          'aria-label': 'Новая запись',
          onChange: (event) => setText(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') addUpdate() }
        }),
        h(Btn, { variant: 'primary', icon: 'plus', onClick: addUpdate, disabled: !text.trim() }, 'Дописать')),
      updates.length > 0
        ? h('div', { className: 'pc-timeline' }, updates.slice(0, 40).map((item, index) =>
          h('div', { key: item.id || `${item.at}-${index}`, className: 'pc-timeline-item' },
            h('div', { className: 'pc-timeline-rail' }, h('span', { className: `pc-timeline-dot pc-timeline-dot-${item.kind}` })),
            h('div', { className: 'pc-timeline-body' },
              h('div', { className: 'pc-timeline-meta' },
                h('span', null, String(item.at).slice(0, 10)),
                h(Badge, { tone: item.kind === 'blocker' ? 'danger' : item.kind === 'progress' ? 'ok' : 'muted' }, KIND_LABELS[item.kind] || 'Запись')),
              h('div', { className: 'pc-timeline-text' }, item.text)))))
        : h('div', { className: 'pc-muted' }, 'Записей пока нет.')),

    h('div', { className: 'pc-block' },
      h('div', { className: 'pc-block-head' }, h('h3', null, `На контроле · открыто ${open.length} из ${todos.length}`)),
      h('div', { className: 'pc-composer' },
        h('input', {
          className: 'pc-input', value: todoTitle, placeholder: 'Новая задача на контроль', 'aria-label': 'Новая задача на контроль',
          onChange: (event) => setTodoTitle(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') addTodo() }
        }),
        h('input', {
          className: 'pc-input', style: { maxWidth: '136px' }, type: 'date', value: todoDue,
          'aria-label': 'Срок задачи', onChange: (event) => setTodoDue(event.target.value)
        }),
        h(Btn, { icon: 'plus', onClick: addTodo, disabled: !todoTitle.trim() }, 'Добавить')),
      todos.length > 0
        ? h('div', null, todos.map((todo) => h('div', { key: todo.id, className: `pc-todo${todo.done === true ? ' pc-todo-done' : ''}` },
          h('input', {
            type: 'checkbox', checked: todo.done === true, 'aria-label': `Отметить выполненной: ${todo.title}`,
            onChange: () => onChange(touch({
              ...project,
              todos: todos.map((item) => item.id === todo.id
                ? { ...item, done: item.done !== true, doneAt: item.done !== true ? new Date().toISOString() : '' }
                : item)
            }))
          }),
          h('span', { className: 'pc-todo-title' }, todo.title),
          todo.dueDate
            ? h('span', { className: `pc-todo-due${todo.done !== true && (daysLeft(todo.dueDate, today) ?? 1) < 0 ? ' pc-todo-due-over' : ''}` }, `Срок ${todo.dueDate}`)
            : null,
          h(IconBtn, {
            icon: 'trash', size: 'sm', title: 'Удалить задачу', variant: 'danger',
            onClick: () => onChange(touch({ ...project, todos: todos.filter((item) => item.id !== todo.id) }))
          }))))
        : h('div', { className: 'pc-muted' }, 'Задач на контроле нет.')),

    h('div', { className: 'pc-block' },
      h('div', { className: 'pc-block-head' },
        h('h3', null, 'AI-помощник'),
        h('span', { className: 'pc-spacer' }),
        h('span', { className: 'pc-muted' }, 'Сгенерируйте и отправьте в соседнюю сессию')),
      h('div', { className: 'pc-chips' },
        h(Btn, { size: 'sm', icon: 'sparkle', onClick: () => ai.analysis(project) }, 'Проанализируй прогресс проекта'),
        DOCS.map((doc) => h(Btn, { key: doc.value, size: 'sm', onClick: () => ai.doc(doc.value, project) }, `Сгенерировать ${doc.label}`)))),

    h('div', { className: 'pc-chips' },
      h(Btn, { size: 'sm', icon: 'edit', onClick: onEdit }, 'Редактировать проект'),
      h(Btn, { size: 'sm', icon: 'trash', variant: 'danger', onClick: onDelete }, 'Удалить проект')))
}

/* ------------------------------------------------------------------ Форма */

export function ProjectForm({ draft, existing, moduleOptions, onSubmit, onCancel }) {
  const [form, setForm] = useState(draft)
  const [invalid, setInvalid] = useState('')
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))

  const submit = (event) => {
    if (event) event.preventDefault()
    if (!form.name.trim()) {
      setInvalid('Название проекта не может быть пустым.')
      return
    }
    onSubmit(projectFromDraft(form, existing))
  }

  return h(Modal, {
    open: true,
    title: existing ? 'Редактировать проект' : 'Новый проект',
    icon: existing ? 'edit' : 'plus',
    onClose: onCancel,
    footer: [
      h(Btn, { key: 'cancel', onClick: onCancel }, 'Отмена'),
      h(Btn, { key: 'ok', variant: 'primary', icon: 'check', onClick: submit }, existing ? 'Сохранить' : 'Создать проект')
    ]
  },
  h('form', { className: 'pc-form', onSubmit: submit },
    h(Field, { label: 'Название проекта *', span: true, hint: invalid || undefined },
      h('input', { className: 'pc-input', value: form.name, onChange: set('name'), placeholder: 'Например: Переработка сервиса расчётов', 'aria-label': 'Название проекта' })),
    h(Field, { label: 'Модуль', hint: 'Можно ввести новое имя модуля' },
      h('input', { className: 'pc-input', list: 'pc-module-options', value: form.module, onChange: set('module'), 'aria-label': 'Модуль' })),
    h('datalist', { id: 'pc-module-options' }, moduleOptions.map((name) => h('option', { key: name, value: name }))),
    h(Field, { label: 'Статус' },
      h('select', { className: 'pc-select', value: form.status, onChange: set('status'), 'aria-label': 'Статус' },
        STATUSES.map((name) => h('option', { key: name, value: name }, name)))),
    h(Field, { label: 'Ответственный' },
      h('input', { className: 'pc-input', value: form.owner, onChange: set('owner'), placeholder: 'Я / кто', 'aria-label': 'Ответственный' })),
    h(Field, { label: 'Дата начала' },
      h('input', { className: 'pc-input', type: 'date', value: form.startedOn, onChange: set('startedOn'), 'aria-label': 'Дата начала' })),
    h(Field, { label: 'Дедлайн (DDL)' },
      h('input', { className: 'pc-input', type: 'date', value: form.dueDate, onChange: set('dueDate'), 'aria-label': 'Дедлайн' })),
    h(Field, { label: `Прогресс ${clampProgress({ progress: Number(form.progress) })}%`, span: true },
      h('div', { className: 'pc-range' },
        h('input', { type: 'range', min: 0, max: 100, step: 5, value: form.progress, onChange: set('progress'), 'aria-label': 'Прогресс' }),
        h('b', null, `${clampProgress({ progress: Number(form.progress) })}%`))),
    h(Field, { label: 'Ссылка', span: true },
      h('input', { className: 'pc-input', value: form.link, onChange: set('link'), placeholder: 'Документ / репозиторий / доска', 'aria-label': 'Ссылка' })),
    h(Field, { label: 'Теги', span: true, hint: 'через запятую' },
      h('input', { className: 'pc-input', value: form.tagText, onChange: set('tagText'), placeholder: 'бэкенд, финансы', 'aria-label': 'Теги' })),
    h(Field, { label: 'Одной фразой', span: true },
      h('textarea', { className: 'pc-textarea', value: form.summary, onChange: set('summary'), placeholder: 'Что сдаём по этому проекту', 'aria-label': 'Одной фразой' }))))
}

/* ------------------------------------------------------------------ Оболочка */

export function ConsoleView({ portfolio }) {
  const { status, error, conflict, saving, revision, state, reload, update, setError } = portfolio
  const projects = Array.isArray(state?.projects) ? state.projects : []
  const today = todayISO()
  const toast = useToast()
  const showToast = useRef(() => {})
  showToast.current = toast.show

  const [tab, setTab] = useState('overview')
  const [module, setModule] = useState('Все')
  const [view, setView] = useState('')
  const [keyword, setKeyword] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [editing, setEditing] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiApplied, setAiApplied] = useState(null)
  const [aiOutput, setAiOutput] = useState(null)
  const [month, setMonth] = useState(() => monthKeyOf(today))
  const [day, setDay] = useState(today)

  const totals = useMemo(() => summarize(projects, today), [projects, today])
  const dashboard = useMemo(() => kpis(projects, today), [projects, today])
  const accents = useMemo(() => moduleAccentMap(projects), [projects])
  const rail = useMemo(() => railModules(projects, today), [projects, today])
  const views = useMemo(() => railViews(projects, today), [projects, today])
  const moduleOptions = useMemo(() => moduleNames(projects), [projects])

  const selection = useMemo(
    () => selectProjects(projects, { module, view, keyword }, today),
    [projects, module, view, keyword, today]
  )
  const grouped = module === 'Все' && !view && keyword.trim() === ''
  const groups = useMemo(() => (grouped
    ? groupByModule(selection, today)
    : [{ module: view ? (smartView(view)?.label ?? 'Результат фильтра') : module, projects: selection, stats: summarize(selection, today) }]),
  [grouped, selection, module, view, today])

  const overviewData = useMemo(() => {
    const sorted = sortByRisk(selection, today)
    return {
      kpis: kpis(selection, today),
      risks: riskBreakdown(selection, today),
      modules: moduleWorkload(selection, today),
      progress: progressBuckets(selection),
      owners: ownerWorkload(selection, today),
      attention: sorted.filter((item) => ATTENTION.includes(item.risk.level)),
      dueSoon: sorted.filter((item) => ['overdue', 'urgent', 'soon'].includes(item.risk.level))
    }
  }, [selection, today])

  const columns = useMemo(() => statusColumns(selection, today), [selection, today])
  const calendar = useMemo(() => calendarMonth(selection, today, month), [selection, today, month])
  const timeline = useMemo(() => timelineModel(selection, today), [selection, today])
  const followUps = useMemo(() => followUpBuckets(selection, today), [selection, today])
  const rows = useMemo(() => sortByRisk(selection, today), [selection, today])

  const selected = selectedId ? projects.find((project) => project.id === selectedId) ?? null : null

  const replaceProject = useCallback((project) => update((current) => ({
    ...current,
    projects: current.projects.map((item) => (item.id === project.id ? project : item))
  })), [update])

  const toggleTodo = useCallback((projectId, todoId) => update((current) => ({
    ...current,
    projects: current.projects.map((project) => (project.id !== projectId ? project : touch({
      ...project,
      todos: (project.todos || []).map((todo) => (todo.id === todoId
        ? { ...todo, done: todo.done !== true, doneAt: todo.done !== true ? new Date().toISOString() : '' }
        : todo))
    })))
  })), [update])

  const ai = useMemo(() => ({
    analysis(project) {
      setAiOutput({
        title: project ? `Промпт анализа прогресса · ${project.name}` : 'Промпт анализа прогресса · Все проекты',
        filename: `Анализ-прогресса-${project ? project.name : 'Все проекты'}-${today}.md`,
        kind: 'prompt',
        text: buildAnalysisPrompt({ projects, project: project ?? null, today })
      })
    },
    doc(kind, project) {
      const label = (DOCS.find((doc) => doc.value === kind) || { label: 'Документы' }).label
      setAiOutput({
        title: `${label} · ${project ? project.name : 'Все проекты'}`,
        filename: `${label}-${project ? project.name : 'Все проекты'}-${today}.md`,
        kind,
        text: buildDocDraft(kind, { projects, project: project ?? null, today })
      })
    }
  }), [projects, today])

  const seedSamples = useCallback(async (mode = 'append') => {
    markSeedFlag()
    const samples = buildSampleProjects(today)
    const ok = await update((current) => ({
      ...current,
      seededAt: current.seededAt || new Date().toISOString(),
      projects: mode === 'replace' ? samples : [...samples, ...current.projects]
    }))
    if (ok) showToast.current(`Создано: ${sampleSummary(samples)} — можно удалить или очистить в любой момент`)
    return ok
  }, [today, update])

  // Первый вход: если документ пуст и демо ни разу не генерировались, создаём набор по модулям.
  const autoSeeded = useRef(false)
  useEffect(() => {
    if (autoSeeded.current || status !== 'ready') return
    if (projects.length !== 0 || state?.seededAt || seedFlagSet()) return
    autoSeeded.current = true
    markSeedFlag()
    const samples = buildSampleProjects(today)
    update(() => ({ version: 1, seededAt: new Date().toISOString(), projects: samples }))
      .then((ok) => {
        if (ok) showToast.current(`Первый запуск: создано ${sampleSummary(samples)}; можно удалить или очистить`)
      })
  }, [status, projects.length, state?.seededAt, today, update])

  const openCreate = () => setEditing(blankDraft())
  const openEdit = (project) => setEditing(draftFromProject(project))

  /** После подтверждения пользователем в окне AI: одна запись и один шаг, который можно отменить. */
  const applyAiPlan = useCallback(async (plan) => {
    let before = null
    const ok = await update((current) => {
      before = current
      return applyPlan(current, plan, today).next
    })
    if (!ok) return
    setAiApplied({ summary: planSummary(plan), undo: before })
    showToast.current(`AI-заполнение выполнено: ${planSummary(plan)}`)
  }, [today, update])

  const undoAiPlan = useCallback(() => {
    if (!aiApplied) return
    update(() => aiApplied.undo)
    setAiApplied(null)
    showToast.current('Предыдущее AI-заполнение отменено')
  }, [aiApplied, update])

  const copyOutput = async () => {
    if (!aiOutput) return
    const ok = await copyText(aiOutput.text)
    showToast.current(ok ? 'Скопировано — вставьте в соседнюю сессию' : 'Не удалось скопировать — выделите и скопируйте вручную', ok ? '' : 'danger')
  }

  if (status === 'loading') {
    return h('div', { className: 'pc-root' },
      h('header', { className: 'pc-header' },
        h('div', { className: 'pc-brand' },
          h('div', { className: 'pc-skeleton', style: { width: 32, height: 32, borderRadius: 9 } }),
          h('div', { className: 'pc-brand-text' }, h('div', { className: 'pc-skeleton-line', style: { width: 132 } })))),
      h('nav', { className: 'pc-viewtabs' }, [0, 1, 2, 3, 4].map((index) => h('div', {
        key: index, className: 'pc-skeleton-line', style: { width: 72, height: 26 }
      }))),
      h('div', { className: 'pc-main' },
        h('div', { className: 'pc-content' },
          h('div', { className: 'pc-kpis' }, [0, 1, 2, 3, 4, 5].map((index) => h('div', { key: index, className: 'pc-skeleton', style: { height: 84 } }))),
          h('div', { className: 'pc-dash-grid' }, [0, 1, 2, 3].map((index) => h('div', { key: index, className: 'pc-skeleton', style: { height: 216 } }))))))
  }

  const scopeLabel = [
    module !== 'Все' ? module : 'Все проекты',
    view ? smartView(view)?.label : '',
    keyword.trim() ? `Поиск «${keyword.trim()}»` : ''
  ].filter(Boolean).join(' · ')

  const header = h('header', { className: 'pc-header' },
    h('div', { className: 'pc-brand' },
      h('div', { className: 'pc-brand-mark' }, h(Icon, { name: 'target', size: 17 })),
      h('div', { className: 'pc-brand-text' },
        h('div', { className: 'pc-brand-title' }, 'Пульт проектов'),
        h('div', { className: 'pc-brand-sub' },
          `Проектов: ${dashboard.total} · Модулей: ${rail.filter((item) => item.total > 0).length} · Требуют внимания: ${dashboard.attention}`))),
    h('span', { className: 'pc-header-spacer' }),
    h(SearchBox, { value: keyword, onChange: setKeyword, placeholder: 'Поиск по проектам, ответственным, тегам, задачам…', label: 'Поиск проектов' }),
    h(IconBtn, { icon: 'refresh', title: 'Обновить данные', onClick: reload, disabled: saving }),
    h(Btn, { icon: 'sparkle', onClick: () => setAiOpen(true), title: 'Управление проектами обычным языком' }, 'AI-заполнение'),
    h(Btn, { variant: 'primary', icon: 'plus', onClick: openCreate }, 'Новый проект'))

  const tabs = h('nav', { className: 'pc-viewtabs', role: 'tablist', 'aria-label': 'Разрезы доски' },
    TABS.map((entry) => h('button', {
      key: entry.id, type: 'button', role: 'tab', className: 'pc-viewtab',
      'aria-selected': tab === entry.id,
      onClick: () => setTab(entry.id)
    }, h(Icon, { name: entry.icon, size: 14 }), h('span', null, entry.label))),
    h('span', { className: 'pc-viewtabs-spacer' }),
    h('span', { className: 'pc-scope' }, `${scopeLabel} · ${selection.length} шт.`))

  const content = (() => {
    if (error) return null
    if (tab === 'overview') {
      return h(OverviewScreen, {
        today,
        accents,
        onOpen: setSelectedId,
        ask: h(AskCard, { projects, today }),
        ...overviewData
      })
    }
    if (selection.length === 0) {
      return h(Empty, {
        icon: keyword.trim() ? 'search' : view ? 'filter' : 'inbox',
        title: 'Нет подходящих проектов',
        hint: 'Попробуйте другой модуль, сбросьте умный вид или измените запрос.'
      })
    }
    if (tab === 'board') return h(BoardScreen, { groups, today, accents, onOpen: setSelectedId })
    if (tab === 'kanban') return h(KanbanScreen, { columns, accents, onOpen: setSelectedId })
    if (tab === 'list') return h(ListScreen, { rows, today, accents, onOpen: setSelectedId })
    if (tab === 'calendar') {
      return h(CalendarScreen, {
        model: calendar,
        today,
        selectedIso: day,
        onSelect: setDay,
        onShift: (delta) => setMonth((current) => shiftMonth(current, delta)),
        onToday: () => { setMonth(monthKeyOf(today)); setDay(today) },
        onOpen: setSelectedId,
        onToggleTodo: toggleTodo
      })
    }
    if (tab === 'timeline') return h(TimelineScreen, { model: timeline, today, accents, onOpen: setSelectedId })
    return h(FollowUpsScreen, { buckets: followUps, today, onToggle: toggleTodo, onOpen: setSelectedId })
  })()

  return h('div', { className: 'pc-root' },
    header,
    tabs,
    h('div', { className: 'pc-main' },
      h('nav', { className: 'pc-rail', 'aria-label': 'Модули и умные виды' },
        h('div', { className: 'pc-rail-group' },
          h('div', { className: 'pc-rail-label' }, 'Модуль'),
          h('button', {
            type: 'button', className: 'pc-rail-item', 'aria-current': module === 'Все' && !view,
            onClick: () => { setModule('Все'); setView('') }
          },
          h(Icon, { name: 'grid', size: 14 }),
          h('span', { className: 'pc-rail-item-name' }, 'Все проекты'),
          h('span', { className: 'pc-rail-count' }, String(dashboard.total))),
          rail.map((entry) => h('button', {
            key: entry.name, type: 'button',
            className: `pc-rail-item pc-accent-${accents[entry.name] ?? 'indigo'}`,
            'aria-current': module === entry.name && !view,
            title: `${entry.name} · проектов: ${entry.total}`,
            onClick: () => { setModule(entry.name); setView('') }
          },
          h('span', {
            className: 'pc-dot',
            style: { background: entry.overdue > 0 ? 'var(--pc-danger)' : entry.danger > 0 ? 'var(--pc-warn)' : 'var(--pc-line-3)' }
          }),
          h('span', { className: 'pc-rail-item-name' }, entry.name),
          h('span', { className: 'pc-rail-count' }, String(entry.total))))),
        h('div', { className: 'pc-rail-group' },
          h('div', { className: 'pc-rail-label' }, 'Умные виды'),
          views.map((entry) => h('button', {
            key: entry.id, type: 'button', className: 'pc-rail-item',
            'aria-current': view === entry.id, title: entry.hint,
            onClick: () => { setView(view === entry.id ? '' : entry.id); setModule('Все') }
          },
          h(Icon, { name: entry.id === 'attention' ? 'alert' : entry.id === 'overdue' ? 'clock' : entry.id === 'week' ? 'calendar' : entry.id === 'todos' ? 'check' : 'inbox', size: 14 }),
          h('span', { className: 'pc-rail-item-name' }, entry.label),
          h('span', { className: 'pc-rail-count' }, String(entry.total))))),
        h('div', { className: 'pc-rail-foot' },
          h('div', { className: 'pc-rail-state' },
            saving ? 'Сохранение…' : status === 'error' ? 'Ошибка чтения' : `Сохранено · версия ${revision}`),
          h('div', { className: 'pc-rail-actions' },
            h(Btn, { size: 'sm', icon: 'sparkle', disabled: saving, title: 'Создать демо-проекты по модулям', onClick: () => seedSamples('append') }, 'Демо-данные'),
            projects.length > 0
              ? h(Btn, { size: 'sm', icon: 'trash', variant: 'danger', disabled: saving, onClick: () => setConfirmClear(true) }, 'Очистить')
              : null),
          h('div', { className: 'pc-rail-note' }, 'Данные лежат в каталоге DSH — при удалении воркбенча они не удаляются'))),

      h('main', { className: 'pc-content' },
        error
          ? h(Notice, {
            tone: 'danger',
            action: h('div', { className: 'pc-chips' },
              h(Btn, { size: 'sm', onClick: () => { setError(''); if (conflict) reload() } }, conflict ? 'Перезагрузить' : 'Повторить'))
          }, error)
          : null,

        aiApplied
          ? h('div', { className: 'pc-undobar' },
            h(Icon, { name: 'check', size: 14 }),
            h('span', null, `AI-заполнение выполнено: ${aiApplied.summary}`),
            h('span', { className: 'pc-spacer' }),
            h(Btn, { size: 'sm', onClick: undoAiPlan }, 'Отменить'),
            h(IconBtn, { icon: 'close', size: 'sm', title: 'Закрыть', onClick: () => setAiApplied(null) }))
          : null,

        content,

        aiOutput
          ? h('section', { className: 'pc-panel-block' },
            h('div', { className: 'pc-panel-head' },
              h(Icon, { name: 'sparkle', size: 14 }),
              h('h3', null, aiOutput.title),
              h('span', { className: 'pc-spacer' }),
              h(Btn, { size: 'sm', icon: 'copy', variant: 'primary', onClick: copyOutput }, 'Копировать'),
              h(Btn, {
                size: 'sm', icon: 'download',
                onClick: () => showToast.current(downloadMarkdown(aiOutput.filename, aiOutput.text) ? `Скачано: ${aiOutput.filename}` : 'Ошибка скачивания', 'danger')
              }, 'Скачать .md'),
              h(IconBtn, { icon: 'close', size: 'sm', title: 'Свернуть', onClick: () => setAiOutput(null) })),
            h('div', { className: 'pc-muted' }, aiOutput.kind === 'prompt'
              ? 'Это промпт для Agent: скопируйте и отправьте в соседнюю сессию — он проанализирует зарегистрированные данные.'
              : deliveryHint(aiOutput.kind)),
            h('textarea', {
              className: 'pc-doc', value: aiOutput.text, 'aria-label': aiOutput.title,
              onChange: (event) => setAiOutput({ ...aiOutput, text: event.target.value })
            }))
          : null)),

    selected
      ? h(Sheet, {
        open: true,
        title: selected.name,
        badge: [
          h(Badge, { key: 'module', tone: 'muted' }, selected.module || 'Другие проекты'),
          h(Badge, { key: 'status', tone: 'muted' }, selected.status || 'В работе'),
          h(RiskBadge, { key: 'risk', risk: projectRisk(selected, today) })
        ],
        onClose: () => setSelectedId(''),
        children: h(DetailBody, {
          project: selected,
          risk: projectRisk(selected, today),
          today,
          onChange: replaceProject,
          ai,
          onEdit: () => openEdit(selected),
          onDelete: () => setConfirmDelete(selected)
        })
      })
      : null,

    editing
      ? h(ProjectForm, {
        draft: editing,
        existing: editing.id ? projects.find((project) => project.id === editing.id) ?? null : null,
        moduleOptions,
        onCancel: () => setEditing(null),
        onSubmit: (project) => {
          const isNew = !editing.id
          update((current) => ({
            ...current,
            projects: isNew
              ? [project, ...current.projects]
              : current.projects.map((item) => (item.id === project.id ? project : item))
          }))
          setEditing(null)
          setSelectedId(project.id)
          showToast.current(isNew ? 'Проект создан' : 'Изменения сохранены')
        }
      })
      : null,

    aiOpen
      ? h(AiFillModal, {
        projects,
        today,
        onClose: () => setAiOpen(false),
        onApplied: applyAiPlan
      })
      : null,

    confirmClear
      ? h(Modal, {
        open: true,
        title: 'Очистить все проекты?',
        icon: 'alert',
        onClose: () => setConfirmClear(false),
        footer: [
          h(Btn, { key: 'cancel', onClick: () => setConfirmClear(false) }, 'Отмена'),
          h(Btn, {
            key: 'ok', variant: 'primary', icon: 'trash',
            onClick: () => {
              update((current) => ({
                ...current,
                seededAt: current.seededAt || new Date().toISOString(),
                projects: []
              }))
              setSelectedId('')
              setConfirmClear(false)
              showToast.current('Все проекты удалены')
            }
          }, 'Очистить')
        ]
      }, h('div', null, `Будет удалено записей о проектах: ${projects.length} (включая демо-данные). Файлы и рабочие области не затрагиваются.`))
      : null,

    confirmDelete
      ? h(Modal, {
        open: true,
        title: `Удалить «${confirmDelete.name}»?`,
        icon: 'alert',
        onClose: () => setConfirmDelete(null),
        footer: [
          h(Btn, { key: 'cancel', onClick: () => setConfirmDelete(null) }, 'Отмена'),
          h(Btn, {
            key: 'ok', variant: 'primary', icon: 'trash',
            onClick: () => {
              update((current) => ({ ...current, projects: current.projects.filter((item) => item.id !== confirmDelete.id) }))
              setSelectedId('')
              setConfirmDelete(null)
              showToast.current('Проект удалён')
            }
          }, 'Удалить')
        ]
      }, h('div', null, 'Удаляется только эта запись воркбенча; файлы и рабочие области не затрагиваются.'))
      : null,

    h(Toast, { message: toast.toast?.message, tone: toast.toast?.tone, onDone: toast.clear }))
}

/** Оболочка, подключённая к данным: именно её монтирует хост. */
export function ProjectConsole() {
  const portfolio = usePortfolio()
  return h(ConsoleView, { portfolio })
}
