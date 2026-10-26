// Этот файл собран скриптом scripts/build-client.mjs из src/ — не редактируйте его вручную.
window.__ModuleLoader__.load({
  id: "dsh-workbench-project-console",
  factory: (require) => {
    const __factories = Object.create(null)
    const __cache = Object.create(null)
    function __require(id) {
      if (__factories[id] === undefined) return require(id)
      if (__cache[id] !== undefined) return __cache[id].exports
      const module = { exports: {} }
      __cache[id] = module
      __factories[id](module.exports, module, __require)
      return module.exports
    }
  __factories["client/index.js"] = function (exports, module, __require) {
    /** Клиентская точка входа воркбенча: регистрирует бизнес-панель в Desktop. */
    const React = __require("react")
    const { ConsoleView, ProjectConsole } = __require("client/panel.js")
    const REPOSITORY = 'https://github.com/OliverLiy/projectHub'

    function apply(ctx) {
      ctx.effect(() => ctx.desktopWorkbenches.register({
        title: 'Пульт проектов',
        repository: REPOSITORY,
        description: 'Управление всеми проектами по модулям: статусы, прогресс, задачи на контроле и риски по дедлайнам — на одном экране, с вопросами и генерацией отчётов.',
        panelTitle: 'Пульт проектов',
        category: 'Управление проектами',
        icon: '📋',
        // embedded + businessSide: left — структура «встроенная бизнес-панель слева», поддерживаемая хостом:
        // верхняя панель — первый дочерний элемент корня, и при свёрнутом сайдбаре macOS хост резервирует место под кнопки окна.
        embedded: true,
        layout: { businessSide: 'left', businessWidth: 0.68 }
      }, ProjectConsole), 'project-console: register workbench')
    }

    const inject = ['desktopWorkbenches']

    // Дополнительный экспорт нужен, чтобы рендерить панель в автотестах без Desktop; загрузчик модулей читает только apply/inject.

    module.exports = { apply, inject, ConsoleView, ProjectConsole }
  }
  __factories["client/panel.js"] = function (exports, module, __require) {
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
    const React = __require("react")
    const { ApiError, askAi, newId, readState, writeState } = __require("client/api.js")
    const { CSS, STYLE_ID } = __require("client/styles.js")
    const { Badge, Btn, Empty, Field, Icon, IconBtn, Modal, Notice, Progress, RiskBadge, SearchBox, Sheet, Toast, useToast } = __require("client/ui.js")
    const { BoardScreen, CalendarScreen, FollowUpsScreen, KanbanScreen, ListScreen, OverviewScreen, TimelineScreen } = __require("client/screens.js")
    const { MODULES, STATUSES, clampProgress, daysLeft, formatRemaining, moduleNames, openTodos, projectRisk, sortByRisk, todayISO } = __require("shared/analysis.js")
    const { QUESTION_EXAMPLES, answerQuestion } = __require("shared/query.js")
    const { buildAnalysisPrompt, buildDocDraft, docKinds, deliveryHint } = __require("shared/prompt.js")
    const { groupByModule, railModules, railViews, selectProjects, smartView, summarize } = __require("shared/views.js")
    const { buildSampleProjects, sampleSummary } = __require("shared/sample.js")
    const { applyPlan, planSummary, previewPlan, revalidatePlan } = __require("shared/aiplan.js")
    const { calendarMonth, followUpBuckets, kpis, moduleAccentMap, moduleWorkload, monthKeyOf, ownerWorkload, progressBuckets, riskBreakdown, shiftMonth, statusColumns, timelineModel } = __require("shared/insights.js")
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

    function ProjectForm({ draft, existing, moduleOptions, onSubmit, onCancel }) {
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

    function ConsoleView({ portfolio }) {
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
    function ProjectConsole() {
      const portfolio = usePortfolio()
      return h(ConsoleView, { portfolio })
    }

    module.exports = { ProjectForm, ConsoleView, ProjectConsole }
  }
  __factories["client/api.js"] = function (exports, module, __require) {
    /** Тонкая обёртка клиента над серверными интерфейсами воркбенча. */
    const PREFIX = '/api/project-console'

    class ApiError extends Error {
      constructor(message, status) {
        super(message)
        this.name = 'ApiError'
        this.status = status
      }
    }

    function newId(prefix = 'p') {
      return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    }

    async function parse(response) {
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        throw new ApiError((payload && payload.error) || `Запрос не удался (HTTP ${response.status})`, response.status)
      }
      return payload
    }

    /** Прочитать документ проектов. */
    async function readState() {
      const response = await fetch(`${PREFIX}/state`, { credentials: 'same-origin', cache: 'no-store' })
      const payload = await parse(response)
      if (!payload || typeof payload !== 'object') throw new ApiError('Сервер вернул нераспознанные данные.', 500)
      return { revision: Number(payload.revision) || 0, state: payload.state || { version: 1, projects: [] } }
    }

    /** Попросить AI разобрать команду на естественном языке в план изменений (без записи). */
    async function askAi(instruction, projects, today) {
      const response = await fetch(`${PREFIX}/ai`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction, projects, today })
      })
      if (response.status === 404) {
        throw new ApiError('Сервер ещё не загрузил API AI-разбора (заработает после перезапуска Harness).', 404)
      }
      const payload = await parse(response)
      if (!payload || typeof payload !== 'object' || !payload.plan) {
        throw new ApiError('Сервер не вернул пригодный план изменений.', 500)
      }
      return payload
    }

    /** Полностью заменить документ проектов; при несовпадении версии бросает 409. */
    async function writeState(revision, state) {
      const response = await fetch(`${PREFIX}/state`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision, state })
      })
      return parse(response)
    }

    module.exports = { ApiError, newId, readState, askAi, writeState }
  }
  __factories["client/styles.js"] = function (exports, module, __require) {
    /**
     * Стили панели: сначала переиспользуем дизайн-токены хоста (--dsw-*), если их нет — свои запасные значения,
     * так что в Desktop оформление совпадает с темой, а в Node рендер-тесты тоже работают.
     *
     * Раскладка на container queries, а не media queries: ширину панели задаёт хост, а не вьюпорт.
     * Акцент модуля задаётся одной переменной оттенка --pc-accent-h: за ней идут полоса карточки, точка и вкладки.
     */
    const STYLE_ID = 'dsh-project-console-style'

    const CSS = `
    .pc-root{
      --pc-bg:var(--dsw-alias-bg-base,#ffffff);
      --pc-panel:var(--dsw-alias-bg-layer-2,#ffffff);
      --pc-sunken:color-mix(in srgb,var(--pc-text) 5%,var(--pc-panel));
      --pc-hover:color-mix(in srgb,var(--pc-text) 6%,transparent);
      --pc-text:var(--dsw-alias-label-primary,#16181d);
      --pc-text-2:var(--dsw-alias-label-secondary,#596171);
      --pc-text-3:var(--dsw-alias-label-tertiary,#7b8496);
      --pc-text-4:var(--dsw-alias-label-caption,#9aa2b1);
      --pc-line:var(--dsw-alias-border-l1,rgba(0,0,0,.06));
      --pc-line-2:var(--dsw-alias-border-l2,rgba(0,0,0,.10));
      --pc-line-3:var(--dsw-alias-border-l3,rgba(0,0,0,.16));
      --pc-brand:var(--dsw-alias-brand-primary,#16181d);
      --pc-brand-fill:var(--dsw-alias-button-primary-fill,#16181d);
      --pc-brand-hover:var(--dsw-alias-button-primary-hover,#2b303b);
      --pc-on-brand:var(--dsw-alias-label-primary-foreground,#ffffff);
      --pc-danger:var(--dsw-alias-state-error-primary,#d92d20);
      --pc-warn:var(--dsw-alias-state-warn-primary,#b54708);
      --pc-ok:var(--dsw-alias-state-success-primary,#067647);
      --pc-info:var(--dsw-alias-state-business-primary,#2f6bff);
      --pc-danger-soft:color-mix(in srgb,var(--pc-danger) 13%,transparent);
      --pc-warn-soft:color-mix(in srgb,var(--pc-warn) 15%,transparent);
      --pc-ok-soft:color-mix(in srgb,var(--pc-ok) 13%,transparent);
      --pc-info-soft:color-mix(in srgb,var(--pc-info) 13%,transparent);
      --pc-r-xs:var(--dsw-radius-xs,4px);
      --pc-r-sm:var(--dsw-radius-sm,8px);
      --pc-r-md:var(--dsw-radius-md,12px);
      --pc-r-lg:var(--dsw-radius-lg,16px);
      --pc-shadow-1:0 1px 2px rgba(16,24,40,.05);
      --pc-shadow-2:0 8px 22px rgba(16,24,40,.10);
      --pc-shadow-3:0 20px 48px rgba(16,24,40,.20);
      --pc-accent-h:239;

      position:relative;display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;
      container-type:inline-size;container-name:pc-app;
      background:var(--pc-bg);color:var(--pc-text);
      font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif);
      font-size:13px;line-height:1.55;-webkit-font-smoothing:antialiased;box-sizing:border-box;
    }
    .pc-root *,.pc-root *::before,.pc-root *::after{box-sizing:border-box}
    .pc-root :where(button,input,select,textarea){font:inherit;color:inherit}
    .pc-root ::-webkit-scrollbar{width:10px;height:10px}
    .pc-root ::-webkit-scrollbar-thumb{background:var(--pc-line-3);border:3px solid transparent;background-clip:content-box;border-radius:999px}
    .pc-root ::-webkit-scrollbar-thumb:hover{background:var(--pc-text-4);background-clip:content-box}
    .pc-root ::-webkit-scrollbar-track{background:transparent}
    .pc-root :focus-visible{outline:2px solid var(--pc-info);outline-offset:2px;border-radius:var(--pc-r-xs)}
    @media (prefers-reduced-motion:reduce){.pc-root *{transition:none!important;animation:none!important}}

    /* Акцент модуля */
    .pc-accent-indigo{--pc-accent-h:239}
    .pc-accent-teal{--pc-accent-h:173}
    .pc-accent-amber{--pc-accent-h:32}
    .pc-accent-violet{--pc-accent-h:271}
    .pc-accent-rose{--pc-accent-h:346}
    .pc-accent-cyan{--pc-accent-h:189}
    .pc-root .pc-accent{--pc-accent:hsl(var(--pc-accent-h) 72% 56%)}
    .pc-card,.pc-rail-item,.pc-mini,.pc-module{--pc-accent:hsl(var(--pc-accent-h) 72% 56%)}

    /* Смысловые цвета (в SVG используется currentColor) */
    .pc-c-danger{color:var(--pc-danger)}
    .pc-c-warn{color:var(--pc-warn)}
    .pc-c-ok{color:var(--pc-ok)}
    .pc-c-info{color:var(--pc-info)}
    .pc-c-muted{color:var(--pc-text-4)}
    .pc-dot{width:7px;height:7px;border-radius:999px;background:currentColor;flex:0 0 auto;display:inline-block}
    .pc-accent-dot{width:7px;height:7px;border-radius:2px;background:hsl(var(--pc-accent-h) 72% 56%);flex:0 0 auto;display:inline-block}
    .pc-root .pc-link{border:0;background:transparent;padding:0;cursor:pointer;color:var(--pc-text);text-align:left;text-decoration:underline;text-decoration-color:var(--pc-line-3);text-underline-offset:3px}
    .pc-root .pc-link:hover{text-decoration-color:var(--pc-info);color:var(--pc-info)}

    /* ---------------------------------------------------------------- Верхняя панель */
    .pc-header{
      display:flex;align-items:center;gap:12px;flex:0 0 auto;height:58px;padding:0 16px;
      border-bottom:1px solid var(--pc-line);background:var(--pc-panel);
    }
    .pc-brand{display:flex;align-items:center;gap:10px;min-width:0}
    .pc-brand-mark{
      display:grid;place-items:center;width:32px;height:32px;border-radius:10px;flex:0 0 auto;
      background:linear-gradient(150deg,var(--pc-brand-fill),color-mix(in srgb,var(--pc-brand-fill) 62%,var(--pc-info)));
      color:var(--pc-on-brand);box-shadow:var(--pc-shadow-1)
    }
    .pc-brand-text{display:flex;flex-direction:column;min-width:0}
    .pc-brand-title{font-size:14px;font-weight:600;letter-spacing:.01em;white-space:nowrap}
    .pc-brand-sub{font-size:11px;color:var(--pc-text-3);white-space:nowrap}
    .pc-header-spacer{flex:1 1 auto;min-width:8px}
    .pc-search{position:relative;display:flex;align-items:center;flex:0 1 300px;min-width:120px}
    .pc-search .pc-icon{position:absolute;left:9px;color:var(--pc-text-4);pointer-events:none}
    .pc-search input{
      width:100%;height:32px;padding:0 28px 0 30px;border:1px solid var(--pc-line-2);border-radius:999px;
      background:var(--pc-sunken);transition:border-color .15s,background .15s,box-shadow .15s;
    }
    .pc-search input:hover{border-color:var(--pc-line-3)}
    .pc-search input:focus{outline:none;border-color:var(--pc-info);background:var(--pc-panel);box-shadow:0 0 0 3px var(--pc-info-soft)}
    .pc-search-clear{position:absolute;right:7px;display:grid;place-items:center;width:20px;height:20px;border:0;border-radius:999px;background:transparent;color:var(--pc-text-3);cursor:pointer}
    .pc-search-clear:hover{background:var(--pc-hover);color:var(--pc-text)}

    /* ------------------------------------------------------------ Вкладки видов */
    .pc-viewtabs{
      display:flex;align-items:center;gap:2px;flex:0 0 auto;padding:6px 14px;min-height:44px;
      border-bottom:1px solid var(--pc-line);background:var(--pc-panel);overflow-x:auto;
    }
    .pc-viewtab{
      display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 11px;border:0;border-radius:var(--pc-r-sm);
      background:transparent;color:var(--pc-text-2);cursor:pointer;white-space:nowrap;
      transition:background .15s,color .15s;
    }
    .pc-viewtab:hover{background:var(--pc-hover);color:var(--pc-text)}
    .pc-viewtab[aria-selected=true]{background:color-mix(in srgb,var(--pc-info) 14%,transparent);color:var(--pc-info);font-weight:600}
    .pc-viewtabs-spacer{flex:1 1 auto;min-width:12px}
    .pc-scope{font-size:11px;color:var(--pc-text-3);white-space:nowrap;font-variant-numeric:tabular-nums}

    /* ---------------------------------------------------------------- Кнопки */
    .pc-btn{
      display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;
      border:1px solid transparent;border-radius:var(--pc-r-sm);background:transparent;color:var(--pc-text);
      cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s,box-shadow .15s;
    }
    .pc-btn:hover:not(:disabled){background:var(--pc-hover)}
    .pc-btn:disabled{opacity:.45;cursor:not-allowed}
    .pc-btn-primary{background:var(--pc-brand-fill);color:var(--pc-on-brand);box-shadow:var(--pc-shadow-1)}
    .pc-btn-primary:hover:not(:disabled){background:var(--pc-brand-hover)}
    .pc-btn-outline{border-color:var(--pc-line-2);background:var(--pc-panel)}
    .pc-btn-outline:hover:not(:disabled){border-color:var(--pc-line-3);background:var(--pc-sunken)}
    .pc-btn-danger{color:var(--pc-danger)}
    .pc-btn-danger:hover:not(:disabled){background:var(--pc-danger-soft)}
    .pc-btn-sm{height:26px;padding:0 9px;font-size:12px;border-radius:var(--pc-r-xs)}
    .pc-iconbtn{
      display:inline-grid;place-items:center;width:32px;height:32px;padding:0;border:1px solid transparent;
      border-radius:var(--pc-r-sm);background:transparent;color:var(--pc-text-2);cursor:pointer;transition:background .15s,color .15s;
    }
    .pc-iconbtn:hover:not(:disabled){background:var(--pc-hover);color:var(--pc-text)}
    .pc-iconbtn:disabled{opacity:.45;cursor:not-allowed}
    .pc-iconbtn-sm{width:26px;height:26px;border-radius:var(--pc-r-xs)}
    .pc-iconbtn-danger:hover:not(:disabled){background:var(--pc-danger-soft);color:var(--pc-danger)}
    .pc-seg{display:inline-flex;gap:2px;padding:2px;border-radius:var(--pc-r-sm);background:var(--pc-sunken)}
    .pc-seg button{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border:0;border-radius:var(--pc-r-xs);background:transparent;color:var(--pc-text-2);cursor:pointer}
    .pc-seg button[aria-pressed=true]{background:var(--pc-panel);color:var(--pc-text);box-shadow:var(--pc-shadow-1)}

    /* ---------------------------------------------------------------- Основная часть */
    .pc-main{display:flex;flex:1 1 auto;min-height:0;min-width:0}
    .pc-rail{
      display:flex;flex-direction:column;gap:14px;flex:0 0 208px;min-width:0;padding:14px 10px;
      border-right:1px solid var(--pc-line);background:var(--pc-panel);overflow:auto;
    }
    .pc-rail-group{display:flex;flex-direction:column;gap:2px;min-width:0}
    .pc-rail-label{padding:0 8px 4px;font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--pc-text-4)}
    .pc-rail-item{
      position:relative;display:flex;align-items:center;gap:8px;width:100%;height:30px;padding:0 8px;border:0;
      border-radius:var(--pc-r-sm);background:transparent;color:var(--pc-text-2);cursor:pointer;text-align:left;
      transition:background .15s,color .15s;
    }
    .pc-rail-item:hover{background:var(--pc-hover);color:var(--pc-text)}
    .pc-rail-item[aria-current=true]{background:color-mix(in srgb,var(--pc-accent) 13%,transparent);color:var(--pc-text);font-weight:600}
    .pc-rail-item[aria-current=true]::before{
      content:'';position:absolute;left:0;top:6px;bottom:6px;width:3px;border-radius:999px;background:var(--pc-accent);
    }
    .pc-rail-item-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pc-rail-count{flex:0 0 auto;font-size:11px;color:var(--pc-text-4);font-variant-numeric:tabular-nums}
    .pc-rail-item[aria-current=true] .pc-rail-count{color:var(--pc-text-2)}
    .pc-rail-foot{margin-top:auto;display:flex;flex-direction:column;gap:7px;padding:9px 8px 4px;border-top:1px solid var(--pc-line)}
    .pc-rail-state{font-size:10.5px;color:var(--pc-text-3)}
    .pc-rail-actions{display:flex;gap:6px;flex-wrap:wrap}
    .pc-rail-note{font-size:10px;line-height:1.5;color:var(--pc-text-4)}

    .pc-content{flex:1 1 auto;min-width:0;min-height:0;overflow:auto;padding:16px 18px 30px;display:flex;flex-direction:column;gap:16px}

    /* ------------------------------------------------------------------ KPI */
    .pc-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:10px}
    .pc-kpi{
      position:relative;display:flex;flex-direction:column;gap:2px;padding:11px 13px;border:1px solid var(--pc-line-2);
      border-radius:var(--pc-r-md);background:var(--pc-panel);transition:border-color .15s,box-shadow .15s,transform .15s;
    }
    .pc-kpi:hover{border-color:var(--pc-line-3);box-shadow:var(--pc-shadow-1);transform:translateY(-1px)}
    .pc-kpi-top{display:flex;align-items:center;gap:6px;color:var(--pc-text-3);font-size:11.5px}
    .pc-kpi-value{font-size:25px;font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
    .pc-kpi-foot{font-size:11px;color:var(--pc-text-4)}
    .pc-kpi-danger .pc-kpi-value{color:var(--pc-danger)}
    .pc-kpi-warn .pc-kpi-value{color:var(--pc-warn)}
    .pc-kpi-ok .pc-kpi-value{color:var(--pc-ok)}

    /* -------------------------------------------------------------- Блоки панели */
    .pc-panel-block{
      display:flex;flex-direction:column;gap:12px;padding:14px 15px;border:1px solid var(--pc-line-2);
      border-radius:var(--pc-r-md);background:var(--pc-panel);min-width:0;
    }
    .pc-panel-head{display:flex;align-items:center;gap:8px;color:var(--pc-text-3)}
    .pc-panel-head h3{margin:0;font-size:12.5px;font-weight:600;color:var(--pc-text);letter-spacing:.01em}
    .pc-panel-head .pc-spacer{flex:1 1 auto}
    .pc-dash-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(242px,1fr));gap:14px;align-items:start}
    .pc-hero{flex-direction:row;align-items:center;gap:12px}
    .pc-hero-mark{
      display:grid;place-items:center;width:34px;height:34px;border-radius:10px;flex:0 0 auto;
      background:var(--pc-info-soft);color:var(--pc-info)
    }
    .pc-hero-title{font-size:12.5px;color:var(--pc-text-3)}
    .pc-hero-sub{font-size:14px;font-weight:600;letter-spacing:-.01em}

    /* -------------------------------------------------------------- Графики и таблицы */
    .pc-donut{position:relative;flex:0 0 auto}
    .pc-donut-track{stroke:var(--pc-sunken)}
    .pc-donut-slice{stroke:currentColor;transition:stroke-dasharray .3s ease}
    .pc-donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
    .pc-donut-center b{font-size:22px;font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums}
    .pc-donut-center span{font-size:10.5px;color:var(--pc-text-4)}
    .pc-donut-wrap{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
    .pc-legend{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none;min-width:120px;flex:1 1 auto}
    .pc-legend li{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--pc-text-2)}
    .pc-legend i{width:9px;height:9px;border-radius:3px;background:currentColor;flex:0 0 auto}
    .pc-legend b{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--pc-text)}

    .pc-stacked{display:flex;flex-direction:column;gap:10px}
    .pc-stacked-head{display:flex;align-items:baseline;gap:8px;font-size:12px}
    .pc-stacked-label{color:var(--pc-text);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pc-stacked-meta{margin-left:auto;font-size:11px;color:var(--pc-text-4);white-space:nowrap}
    .pc-stacked-track{display:flex;height:9px;border-radius:999px;background:var(--pc-sunken);overflow:hidden;margin-top:5px}
    .pc-stacked-seg{display:block;height:100%;background:currentColor;transition:width .3s ease}
    .pc-stacked-seg+.pc-stacked-seg{margin-left:1px}

    .pc-hist{display:flex;align-items:flex-end;gap:8px;height:150px;padding-top:6px}
    .pc-hist-col{flex:1 1 0;display:flex;flex-direction:column;align-items:center;gap:5px;height:100%;min-width:0}
    .pc-hist-track{flex:1 1 auto;width:100%;display:flex;align-items:flex-end;justify-content:center}
    .pc-hist-bar{width:70%;max-width:34px;border-radius:6px 6px 3px 3px;background:linear-gradient(180deg,var(--pc-info),color-mix(in srgb,var(--pc-info) 55%,transparent));transition:height .3s ease}
    .pc-hist-empty{background:var(--pc-sunken)}
    .pc-hist-col b{font-size:12px;font-variant-numeric:tabular-nums}
    .pc-hist-col span{font-size:10px;color:var(--pc-text-4);white-space:nowrap}

    .pc-rank{display:flex;flex-direction:column;gap:9px}
    .pc-rank-row{display:grid;grid-template-columns:76px 1fr 26px auto;align-items:center;gap:8px;font-size:12px}
    .pc-rank-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pc-text-2)}
    .pc-rank-track{position:relative;display:flex;height:9px;border-radius:999px;background:var(--pc-sunken);overflow:hidden}
    .pc-rank-fill{display:block;height:100%;background:hsl(var(--pc-accent-h) 72% 56%);opacity:.75}
    .pc-rank-danger{display:block;height:100%;background:var(--pc-danger)}
    .pc-rank-row b{font-variant-numeric:tabular-nums;text-align:right}
    .pc-rank-row small{color:var(--pc-text-4);font-size:10.5px;white-space:nowrap}

    .pc-attn-list{display:flex;flex-direction:column}
    .pc-attn{display:grid;grid-template-columns:auto 1fr auto auto auto;align-items:center;gap:9px;padding:7px 4px;border:0;border-bottom:1px solid var(--pc-line);background:transparent;cursor:pointer;text-align:left;width:100%;border-radius:var(--pc-r-xs)}
    .pc-attn:last-child{border-bottom:0}
    .pc-attn:hover{background:var(--pc-hover)}
    .pc-attn-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}

    /* ---------------------------------------------------------------- Карточки */
    .pc-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(258px,1fr));gap:10px}
    .pc-card{
      position:relative;display:flex;flex-direction:column;gap:9px;padding:12px 13px 12px 15px;
      border:1px solid var(--pc-line-2);border-radius:var(--pc-r-md);background:var(--pc-panel);
      cursor:pointer;text-align:left;overflow:hidden;
      transition:border-color .15s,box-shadow .18s,transform .18s;
    }
    .pc-card:hover{border-color:var(--pc-accent);box-shadow:var(--pc-shadow-2);transform:translateY(-2px)}
    .pc-card-accent{position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--pc-accent);opacity:.85}
    .pc-card-top{display:flex;align-items:flex-start;gap:8px;min-width:0}
    .pc-card-name{flex:1 1 auto;font-size:13.5px;font-weight:600;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
    .pc-card-sum{font-size:11.5px;color:var(--pc-text-3);overflow:hidden;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}
    .pc-card-tags{display:flex;gap:5px;flex-wrap:wrap}
    .pc-tag{display:inline-flex;align-items:center;height:19px;padding:0 7px;border-radius:var(--pc-r-xs);background:var(--pc-sunken);color:var(--pc-text-3);font-size:10.5px;white-space:nowrap}
    .pc-card-foot{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--pc-text-3);flex-wrap:wrap}
    .pc-card-foot b{color:var(--pc-text-2);font-weight:600;font-variant-numeric:tabular-nums}
    .pc-progress{height:4px;border-radius:999px;background:var(--pc-sunken);overflow:hidden}
    .pc-progress>i{display:block;height:100%;border-radius:999px;background:var(--pc-brand-fill);transition:width .25s}
    .pc-progress-danger>i{background:var(--pc-danger)}
    .pc-progress-warn>i{background:var(--pc-warn)}
    .pc-progress-ok>i{background:var(--pc-ok)}
    .pc-badge{display:inline-flex;align-items:center;gap:5px;height:21px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:500;white-space:nowrap;border:1px solid transparent}
    .pc-badge i{width:5px;height:5px;border-radius:999px;background:currentColor}
    .pc-tone-danger{background:var(--pc-danger-soft);color:var(--pc-danger);border-color:color-mix(in srgb,var(--pc-danger) 26%,transparent)}
    .pc-tone-warn{background:var(--pc-warn-soft);color:var(--pc-warn);border-color:color-mix(in srgb,var(--pc-warn) 26%,transparent)}
    .pc-tone-ok{background:var(--pc-ok-soft);color:var(--pc-ok);border-color:color-mix(in srgb,var(--pc-ok) 24%,transparent)}
    .pc-tone-info{background:var(--pc-info-soft);color:var(--pc-info);border-color:color-mix(in srgb,var(--pc-info) 24%,transparent)}
    .pc-tone-muted{background:var(--pc-sunken);color:var(--pc-text-3);border-color:var(--pc-line-2)}
    .pc-pill{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:999px;background:var(--pc-sunken);color:var(--pc-text-3);font-size:11px;font-variant-numeric:tabular-nums}

    /* -------------------------------------------------------------- Группы модулей */
    .pc-module{display:flex;flex-direction:column;gap:10px}
    .pc-module-head{display:flex;align-items:center;gap:9px;padding:0 2px}
    .pc-module-title{font-size:13.5px;font-weight:600;display:flex;align-items:center;gap:8px}
    .pc-module-bar{width:3px;height:15px;border-radius:999px;background:var(--pc-accent)}
    .pc-module-meta{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--pc-text-3);flex-wrap:wrap}

    /* ---------------------------------------------------------------- Доска */
    .pc-kanban{display:flex;gap:12px;align-items:flex-start;overflow-x:auto;padding-bottom:6px}
    .pc-kanban-col{
      flex:1 1 0;min-width:188px;display:flex;flex-direction:column;gap:9px;padding:11px;
      border:1px solid var(--pc-line-2);border-radius:var(--pc-r-md);background:var(--pc-sunken);
    }
    .pc-kanban-head{display:flex;align-items:center;gap:7px;font-size:12.5px}
    .pc-kanban-head b{font-weight:600}
    .pc-kanban-body{display:flex;flex-direction:column;gap:7px}
    .pc-mini{
      position:relative;display:flex;flex-direction:column;gap:5px;padding:9px 10px 9px 12px;border:1px solid var(--pc-line-2);
      border-radius:var(--pc-r-sm);background:var(--pc-panel);cursor:pointer;text-align:left;overflow:hidden;
      transition:border-color .15s,box-shadow .15s,transform .15s;
    }
    .pc-mini::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--pc-accent)}
    .pc-mini:hover{border-color:var(--pc-accent);box-shadow:var(--pc-shadow-1);transform:translateY(-1px)}
    .pc-mini-name{font-size:12.5px;font-weight:600;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    .pc-mini-meta{display:flex;align-items:center;gap:7px;font-size:10.5px;color:var(--pc-text-3);flex-wrap:wrap}

    /* ---------------------------------------------------------------- Список */
    .pc-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px}
    .pc-table th{position:sticky;top:0;z-index:1;padding:9px 10px;text-align:left;font-size:11px;font-weight:600;color:var(--pc-text-3);background:var(--pc-panel);border-bottom:1px solid var(--pc-line-2);white-space:nowrap}
    .pc-table td{padding:10px;border-bottom:1px solid var(--pc-line);vertical-align:middle}
    .pc-table tbody tr{cursor:pointer}
    .pc-table tbody tr:hover td{background:var(--pc-hover)}
    .pc-table .pc-num{font-variant-numeric:tabular-nums;white-space:nowrap}
    .pc-table .pc-name{font-weight:600;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pc-table .pc-name .pc-accent-dot{margin-right:7px;vertical-align:middle}
    .pc-table-wrap{border:1px solid var(--pc-line-2);border-radius:var(--pc-r-md);background:var(--pc-panel);overflow:hidden}

    /* ---------------------------------------------------------------- Календарь */
    .pc-cal{display:flex;flex-direction:column;gap:12px}
    .pc-cal-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .pc-cal-title{display:flex;align-items:baseline;gap:9px}
    .pc-cal-title b{font-size:15px;font-weight:600}
    .pc-cal-actions{margin-left:auto;display:flex;align-items:center;gap:6px}
    .pc-cal-weekdays{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
    .pc-cal-weekdays span{padding:2px 0;text-align:center;font-size:10.5px;color:var(--pc-text-4)}
    .pc-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
    .pc-cal-cell{
      display:flex;flex-direction:column;gap:4px;min-height:84px;padding:6px 7px;border:1px solid var(--pc-line);
      border-radius:var(--pc-r-sm);background:var(--pc-panel);cursor:pointer;text-align:left;overflow:hidden;
      transition:border-color .15s,box-shadow .15s,background .15s;
    }
    .pc-cal-cell:hover{border-color:var(--pc-line-3);box-shadow:var(--pc-shadow-1)}
    .pc-cal-weekend{background:color-mix(in srgb,var(--pc-text) 3%,var(--pc-panel))}
    .pc-cal-out{opacity:.42}
    .pc-cal-today{border-color:var(--pc-info);box-shadow:0 0 0 1px var(--pc-info-soft) inset}
    .pc-cal-selected{border-color:var(--pc-accent);background:color-mix(in srgb,var(--pc-info) 7%,var(--pc-panel))}
    .pc-cal-day{font-size:11px;color:var(--pc-text-2);font-variant-numeric:tabular-nums}
    .pc-cal-today .pc-cal-day{display:inline-grid;place-items:center;min-width:19px;height:19px;padding:0 5px;border-radius:999px;background:var(--pc-info);color:var(--pc-on-brand);font-weight:600}
    .pc-cal-items{display:flex;flex-direction:column;gap:3px;min-width:0}
    .pc-cal-chip{
      display:block;padding:2px 6px;border-radius:var(--pc-r-xs);font-size:10.5px;line-height:1.45;
      background:color-mix(in srgb,currentColor 14%,transparent);
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    .pc-cal-more{font-size:10px;color:var(--pc-text-4)}
    .pc-cal-detail{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--pc-line-2);border-radius:var(--pc-r-md);background:var(--pc-panel)}
    .pc-cal-list{display:flex;flex-direction:column}
    .pc-cal-row{display:grid;grid-template-columns:auto auto 1fr auto auto;align-items:center;gap:9px;padding:7px 2px;border-bottom:1px solid var(--pc-line);font-size:12px}
    .pc-cal-row:last-child{border-bottom:0}

    /* -------------------------------------------------------------- Таймлайн */
    .pc-tl{display:flex;flex-direction:column;gap:8px;border:1px solid var(--pc-line-2);border-radius:var(--pc-r-md);background:var(--pc-panel);padding:12px 14px;overflow:hidden}
    .pc-tl-note{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--pc-text-3)}
    .pc-tl-head{display:grid;grid-template-columns:186px 1fr;gap:10px;padding-bottom:6px;border-bottom:1px solid var(--pc-line)}
    .pc-tl-head-name{font-size:11px;color:var(--pc-text-4)}
    .pc-tl-axis{position:relative;height:18px}
    .pc-tl-axis span{position:absolute;top:0;transform:translateX(-50%);font-size:10.5px;color:var(--pc-text-4);white-space:nowrap}
    .pc-tl-body{position:relative;display:flex;flex-direction:column}
    .pc-tl-todayline{position:absolute;top:0;bottom:0;width:1px;background:var(--pc-info);opacity:.55;pointer-events:none}
    .pc-tl-todayline::after{content:'';position:absolute;top:-3px;left:-2.5px;width:6px;height:6px;border-radius:999px;background:var(--pc-info)}
    .pc-tl-row{display:grid;grid-template-columns:186px 1fr;gap:10px;align-items:center;padding:5px 0;border-bottom:1px solid var(--pc-line)}
    .pc-tl-row:last-child{border-bottom:0}
    .pc-tl-name{display:flex;align-items:center;gap:7px;border:0;background:transparent;padding:0 4px 0 0;cursor:pointer;text-align:left;min-width:0;color:var(--pc-text)}
    .pc-tl-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
    .pc-tl-name:hover{color:var(--pc-info)}
    .pc-tl-track{position:relative;height:26px;border-radius:var(--pc-r-xs);background:var(--pc-sunken)}
    .pc-tl-bar{
      position:absolute;top:4px;height:18px;display:flex;align-items:center;gap:6px;padding:0 8px;border:0;border-radius:999px;
      background:color-mix(in srgb,currentColor 30%,transparent);cursor:pointer;min-width:26px;overflow:hidden;
      transition:filter .15s;
    }
    .pc-tl-bar:hover{filter:brightness(1.06) saturate(1.15)}
    .pc-tl-bar em{font-style:normal;font-size:10px;white-space:nowrap;color:currentColor}
    .pc-tl-bar i{font-style:normal;font-size:10px;color:var(--pc-text-3);white-space:nowrap}

    /* -------------------------------------------------------------- На контроле */
    .pc-follow{display:flex;flex-direction:column;gap:14px}
    .pc-follow-group{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:1px solid var(--pc-line-2);border-radius:var(--pc-r-md);background:var(--pc-panel)}
    .pc-follow-row{display:grid;grid-template-columns:auto 1fr auto auto auto auto;align-items:center;gap:9px;padding:7px 2px;border-bottom:1px solid var(--pc-line);font-size:12.5px}
    .pc-follow-row:last-child{border-bottom:0}
    .pc-follow-row input[type=checkbox]{width:15px;height:15px;accent-color:var(--pc-brand-fill);cursor:pointer}
    .pc-follow-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pc-follow-due{font-size:11px;color:var(--pc-text-4);white-space:nowrap;font-variant-numeric:tabular-nums}

    /* ------------------------------------------------------------------ Пустое состояние */
    .pc-empty{display:flex;flex-direction:column;align-items:center;gap:9px;padding:46px 20px;border:1px dashed var(--pc-line-3);border-radius:var(--pc-r-md);color:var(--pc-text-3);text-align:center}
    .pc-empty-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:999px;background:var(--pc-sunken);color:var(--pc-text-3)}
    .pc-empty-title{font-size:13.5px;font-weight:600;color:var(--pc-text)}
    .pc-empty .pc-btn{margin-top:2px}
    .pc-skeleton{border-radius:var(--pc-r-md);background:var(--pc-sunken);animation:pc-pulse 1.4s ease-in-out infinite}
    .pc-skeleton-line{height:10px;border-radius:999px;background:var(--pc-sunken);animation:pc-pulse 1.4s ease-in-out infinite}
    @keyframes pc-pulse{0%,100%{opacity:1}50%{opacity:.55}}

    /* ---------------------------------------------------------------- AI */
    .pc-ai{display:flex;flex-direction:column;gap:10px}
    .pc-ai-actions{display:flex;align-items:center;gap:10px}
    .pc-ai-result{display:flex;flex-direction:column;gap:10px;padding-top:4px;border-top:1px solid var(--pc-line)}
    .pc-ai-source{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--pc-text-3);flex-wrap:wrap}
    .pc-plan{display:flex;flex-direction:column;gap:10px;padding:11px 12px;border:1px solid var(--pc-line-2);border-radius:var(--pc-r-sm);background:var(--pc-sunken)}
    .pc-plan-group{display:flex;flex-direction:column;gap:5px}
    .pc-plan-title{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--pc-text)}
    .pc-plan-lines{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px}
    .pc-plan-lines li{font-size:12.5px;color:var(--pc-text-2);word-break:break-word}
    .pc-undobar{
      display:flex;align-items:center;gap:9px;padding:9px 12px;border:1px solid color-mix(in srgb,var(--pc-ok) 30%,transparent);
      border-left:3px solid var(--pc-ok);border-radius:var(--pc-r-sm);background:var(--pc-ok-soft);font-size:12.5px;
    }
    .pc-undobar .pc-spacer{flex:1 1 auto}

    /* --------------------------------------------------------- Карточка / окна */
    .pc-scrim{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-2,rgba(16,24,40,.28));z-index:40;animation:pc-fade .16s ease-out}
    @keyframes pc-fade{from{opacity:0}to{opacity:1}}
    .pc-sheet{
      position:absolute;top:0;right:0;bottom:0;z-index:41;display:flex;flex-direction:column;width:min(480px,92%);
      border-left:1px solid var(--pc-line-2);background:var(--pc-panel);box-shadow:var(--pc-shadow-3);
      animation:pc-slide .2s cubic-bezier(.22,.61,.36,1);
    }
    @keyframes pc-slide{from{transform:translateX(18px);opacity:.4}to{transform:none;opacity:1}}
    .pc-sheet-head{display:flex;align-items:flex-start;gap:10px;padding:15px 16px;border-bottom:1px solid var(--pc-line-2)}
    .pc-sheet-title{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:6px}
    .pc-sheet-title h2{margin:0;font-size:16px;font-weight:600;line-height:1.3;word-break:break-word}
    .pc-sheet-body{flex:1 1 auto;min-height:0;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:16px}
    .pc-sheet-foot{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--pc-line-2);background:var(--pc-panel)}
    .pc-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px}
    .pc-fact{display:flex;flex-direction:column;gap:1px;padding:9px 11px;border:1px solid var(--pc-line);border-radius:var(--pc-r-sm);background:var(--pc-sunken)}
    .pc-fact span{font-size:10.5px;color:var(--pc-text-4)}
    .pc-fact strong{font-size:12.5px;font-weight:600;word-break:break-word}
    .pc-block{display:flex;flex-direction:column;gap:9px}
    .pc-block-head{display:flex;align-items:center;gap:8px}
    .pc-block-head h3{margin:0;font-size:11.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--pc-text-3)}
    .pc-block-head .pc-spacer{flex:1 1 auto}

    .pc-composer{display:flex;gap:7px;align-items:center}
    .pc-input,.pc-select,.pc-textarea{width:100%;height:32px;padding:0 10px;border:1px solid var(--pc-line-2);border-radius:var(--pc-r-sm);background:var(--pc-panel);transition:border-color .15s,box-shadow .15s}
    .pc-select{appearance:none;padding-right:26px;background-image:linear-gradient(45deg,transparent 50%,var(--pc-text-4) 50%),linear-gradient(135deg,var(--pc-text-4) 50%,transparent 50%);background-position:calc(100% - 14px) 14px,calc(100% - 9px) 14px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}
    .pc-textarea{height:auto;min-height:78px;padding:9px 10px;resize:vertical;line-height:1.6}
    .pc-input:hover,.pc-select:hover,.pc-textarea:hover{border-color:var(--pc-line-3)}
    .pc-input:focus,.pc-select:focus,.pc-textarea:focus{outline:none;border-color:var(--pc-info);box-shadow:0 0 0 3px var(--pc-info-soft)}

    .pc-timeline{display:flex;flex-direction:column;gap:2px}
    .pc-timeline-item{display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--pc-line)}
    .pc-timeline-item:last-child{border-bottom:0}
    .pc-timeline-rail{display:flex;flex-direction:column;align-items:center;gap:4px;flex:0 0 auto;padding-top:4px}
    .pc-timeline-dot{width:7px;height:7px;border-radius:999px;background:var(--pc-text-4)}
    .pc-timeline-dot-blocker{background:var(--pc-danger)}
    .pc-timeline-dot-progress{background:var(--pc-ok)}
    .pc-timeline-dot-decision{background:var(--pc-info)}
    .pc-timeline-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
    .pc-timeline-meta{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--pc-text-4)}
    .pc-timeline-text{word-break:break-word;font-size:12.5px}

    .pc-todo{display:flex;align-items:center;gap:9px;padding:6px 0;border-bottom:1px solid var(--pc-line)}
    .pc-todo:last-child{border-bottom:0}
    .pc-todo input[type=checkbox]{width:15px;height:15px;accent-color:var(--pc-brand-fill);flex:0 0 auto;cursor:pointer}
    .pc-todo-title{flex:1 1 auto;min-width:0;word-break:break-word}
    .pc-todo-done .pc-todo-title{color:var(--pc-text-4);text-decoration:line-through}
    .pc-todo-due{font-size:11px;color:var(--pc-text-4);white-space:nowrap}
    .pc-todo-due-over{color:var(--pc-danger)}

    .pc-ask{display:flex;flex-direction:column;gap:10px}
    .pc-ask-row{display:flex;align-items:center;gap:8px}
    .pc-ask-row .pc-search{flex:1 1 auto;max-width:none}
    .pc-chips{display:flex;gap:6px;flex-wrap:wrap}
    .pc-chips-center{justify-content:center}
    .pc-chip-btn{height:26px;padding:0 10px;border:1px solid var(--pc-line-2);border-radius:999px;background:var(--pc-panel);color:var(--pc-text-2);cursor:pointer;font-size:12px;transition:background .15s,border-color .15s,color .15s}
    .pc-chip-btn:hover{background:var(--pc-sunken);border-color:var(--pc-line-3);color:var(--pc-text)}
    .pc-answer{padding:11px 13px;border:1px solid var(--pc-line-2);border-left:3px solid var(--pc-info);border-radius:var(--pc-r-sm);background:var(--pc-sunken);white-space:pre-wrap;word-break:break-word}
    .pc-doc{width:100%;min-height:190px;padding:12px 13px;border:1px solid var(--pc-line-2);border-radius:var(--pc-r-sm);background:var(--pc-sunken);resize:vertical;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.7}
    .pc-doc:focus{outline:none;border-color:var(--pc-info);box-shadow:0 0 0 3px var(--pc-info-soft)}

    .pc-modal{
      position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:41;display:flex;flex-direction:column;
      width:min(560px,94%);max-height:88%;border:1px solid var(--pc-line-2);border-radius:var(--pc-r-lg);
      background:var(--pc-panel);box-shadow:var(--pc-shadow-3);animation:pc-pop .18s cubic-bezier(.22,.61,.36,1);
    }
    @keyframes pc-pop{from{opacity:.3;transform:translate(-50%,-48%) scale(.98)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}
    .pc-modal-head{display:flex;align-items:center;gap:10px;padding:15px 18px;border-bottom:1px solid var(--pc-line-2)}
    .pc-modal-head h2{margin:0;font-size:15px;font-weight:600;flex:1 1 auto}
    .pc-modal-body{padding:16px 18px;overflow:auto;display:flex;flex-direction:column;gap:12px}
    .pc-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:13px 18px;border-top:1px solid var(--pc-line-2)}
    .pc-form{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .pc-field{display:flex;flex-direction:column;gap:5px;min-width:0}
    .pc-field>span{font-size:11.5px;font-weight:500;color:var(--pc-text-2)}
    .pc-field>small{font-size:10.5px;color:var(--pc-text-4)}
    .pc-field-span{grid-column:1 / -1}
    .pc-range{display:flex;align-items:center;gap:10px}
    .pc-range input[type=range]{flex:1 1 auto;accent-color:var(--pc-brand-fill)}
    .pc-range b{min-width:38px;text-align:right;font-variant-numeric:tabular-nums}

    .pc-toast{
      position:absolute;left:50%;bottom:20px;transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:8px;
      max-width:80%;padding:9px 14px;border-radius:999px;background:var(--dsw-alias-toast-bg,rgba(22,24,29,.94));
      color:var(--dsw-alias-toast-label,#fff);box-shadow:var(--pc-shadow-2);font-size:12.5px;animation:pc-rise .2s ease-out;
    }
    @keyframes pc-rise{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}
    .pc-toast-danger{background:var(--pc-danger)}
    .pc-notice{display:flex;align-items:flex-start;gap:9px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--pc-warn) 30%,transparent);border-left:3px solid var(--pc-warn);border-radius:var(--pc-r-sm);background:var(--pc-warn-soft)}
    .pc-notice-danger{border-color:color-mix(in srgb,var(--pc-danger) 30%,transparent);border-left-color:var(--pc-danger);background:var(--pc-danger-soft)}
    .pc-notice-body{flex:1 1 auto;display:flex;flex-direction:column;gap:6px}
    .pc-muted{color:var(--pc-text-3);font-size:11.5px}
    .pc-mono{font-family:var(--dsw-font-family-mono,ui-monospace,Menlo,monospace);font-size:11.5px}

    /* --------------------------------------------------------- Узкая панель */
    @container pc-app (max-width:900px){
      .pc-rail{flex-basis:172px}
      .pc-cards{grid-template-columns:repeat(auto-fill,minmax(224px,1fr))}
      .pc-viewtab{padding:0 9px}
    }
    @container pc-app (max-width:760px){
      .pc-main{flex-direction:column}
      .pc-rail{flex:0 0 auto;flex-direction:row;gap:6px;padding:8px 10px;border-right:0;border-bottom:1px solid var(--pc-line);overflow-x:auto;overflow-y:hidden}
      .pc-rail-group{flex-direction:row;gap:6px;align-items:center}
      .pc-rail-label,.pc-rail-foot{display:none}
      .pc-rail-item{width:auto;height:28px;padding:0 10px;border:1px solid var(--pc-line-2);border-radius:999px}
      .pc-rail-item[aria-current=true]{border-color:transparent}
      .pc-rail-item[aria-current=true]::before{display:none}
      .pc-search{flex-basis:150px}
      .pc-brand-sub,.pc-scope{display:none}
      .pc-content{padding:12px}
      .pc-form{grid-template-columns:1fr}
      .pc-cal-cell{min-height:64px}
      .pc-cal-chip{display:none}
      .pc-tl-head,.pc-tl-row{grid-template-columns:120px 1fr}
      .pc-tl-todayline{left:calc(120px + (100% - 120px) * .5)}
    }
    @container pc-app (max-width:560px){
      .pc-search{display:none}
      .pc-kpis{grid-template-columns:repeat(auto-fit,minmax(104px,1fr))}
      .pc-cards{grid-template-columns:1fr}
      .pc-viewtab span{display:none}
    }
    `

    module.exports = { STYLE_ID, CSS }
  }
  __factories["client/ui.js"] = function (exports, module, __require) {
    /** Базовые компоненты панели: иконки, кнопки, бейджи, прогресс, окна, карточка, тосты. */
    const React = __require("react")
    const { RISK_META, clampProgress } = __require("shared/analysis.js")
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    /* ------------------------------------------------------------------ Иконки */

    const PATHS = {
      grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
      list: 'M4 6h16M4 12h16M4 18h16',
      plus: 'M12 5v14M5 12h14',
      refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
      search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
      close: 'M6 6l12 12M18 6L6 18',
      alert: 'M12 3l9 16H3zM12 9v5M12 17h.01',
      clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
      check: 'M4 12l5 5L20 6',
      users: 'M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 6.5a3 3 0 1 0 0 5 3 3 0 0 0 0-5zM21 20v-2a4 4 0 0 0-3-3.9',
      link: 'M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1',
      calendar: 'M4 6h16v14H4zM8 3v4M16 3v4M4 10h16',
      sparkle: 'M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
      chevron: 'M9 6l6 6-6 6',
      arrowLeft: 'M15 6l-6 6 6 6',
      trash: 'M4 7h16M9 7V5h6v2M6 7l1 14h10l1-14M10 11v6M14 11v6',
      edit: 'M4 20h4l11-11-4-4L4 16zM14 5l4 4',
      copy: 'M9 9h10v10H9zM5 15V5h10',
      download: 'M12 4v11M7 12l5 5 5-5M5 20h14',
      note: 'M6 3h9l5 5v13H6zM15 3v5h5M9 13h6M9 17h4',
      filter: 'M4 5h16l-6 7v7l-4-2v-5z',
      inbox: 'M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8v6H4z',
      target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 12h.01'
    }

    function Icon({ name, size = 16, className = 'pc-icon', strokeWidth = 1.7 }) {
      const path = PATHS[name] ?? PATHS.grid
      return h('svg', {
        className, width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false'
      }, h('path', { d: path }))
    }

    /* ---------------------------------------------------------------- Кнопки */

    function Btn({ children, onClick, variant = 'ghost', size = '', icon, disabled = false, title, type = 'button' }) {
      return h('button', {
        type,
        className: `pc-btn${variant === 'ghost' ? '' : ` pc-btn-${variant}`}${size ? ` pc-btn-${size}` : ''}`,
        onClick,
        disabled,
        title: title || undefined
      }, icon ? h(Icon, { name: icon, size: size === 'sm' ? 13 : 15 }) : null, children)
    }

    function IconBtn({ icon, title, onClick, disabled = false, variant = '', size = '' }) {
      return h('button', {
        type: 'button',
        className: `pc-iconbtn${variant ? ` pc-iconbtn-${variant}` : ''}${size ? ` pc-iconbtn-${size}` : ''}`,
        onClick,
        disabled,
        title,
        'aria-label': title
      }, h(Icon, { name: icon, size: size === 'sm' ? 14 : 16 }))
    }

    function Segmented({ value, options, onChange, ariaLabel }) {
      return h('div', { className: 'pc-seg', role: 'group', 'aria-label': ariaLabel },
        options.map((option) => h('button', {
          key: option.value,
          type: 'button',
          'aria-pressed': value === option.value,
          onClick: () => onChange(option.value),
          title: option.title || undefined
        }, option.icon ? h(Icon, { name: option.icon, size: 14 }) : null, option.label)))
    }

    /* ---------------------------------------------------------------- Показ */

    function Badge({ children, tone = 'muted', dot = false }) {
      return h('span', { className: `pc-badge pc-tone-${tone}` }, dot ? h('i') : null, children)
    }

    function RiskBadge({ risk, showDot = true }) {
      const meta = risk || RISK_META.normal
      return h('span', { className: `pc-badge pc-tone-${meta.tone}`, title: meta.detail || meta.label },
        showDot ? h('i') : null, meta.label)
    }

    function Progress({ value, tone = '' }) {
      const percent = clampProgress({ progress: value })
      return h('div', {
        className: `pc-progress${tone ? ` pc-progress-${tone}` : ''}`,
        role: 'progressbar', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100,
        'aria-label': `Прогресс ${percent}%`
      }, h('i', { style: { width: `${percent}%` } }))
    }

    function Stat({ label, value, hint, tone = '', icon }) {
      return h('div', { className: `pc-kpi${tone ? ` pc-kpi-${tone}` : ''}` },
        h('div', { className: 'pc-kpi-top' }, icon ? h(Icon, { name: icon, size: 13 }) : null, label),
        h('div', { className: 'pc-kpi-value' }, String(value)),
        hint ? h('div', { className: 'pc-kpi-foot' }, hint) : null)
    }

    function Empty({ icon = 'inbox', title, hint, action }) {
      return h('div', { className: 'pc-empty' },
        h('div', { className: 'pc-empty-icon' }, h(Icon, { name: icon, size: 18 })),
        h('div', { className: 'pc-empty-title' }, title),
        hint ? h('div', { className: 'pc-muted' }, hint) : null,
        action || null)
    }

    function Notice({ children, tone = 'warn', action }) {
      return h('div', { className: `pc-notice${tone === 'danger' ? ' pc-notice-danger' : ''}`, role: 'status' },
        h(Icon, { name: tone === 'danger' ? 'alert' : 'clock', size: 15 }),
        h('div', { className: 'pc-notice-body' }, h('div', null, children), action || null))
    }

    function Field({ label, hint, span = false, children }) {
      return h('label', { className: `pc-field${span ? ' pc-field-span' : ''}` },
        h('span', null, label), children, hint ? h('small', null, hint) : null)
    }

    /* ------------------------------------------------------- Окна / карточка / тосты */

    function useEscape(active, onEscape) {
      useEffect(() => {
        if (!active) return undefined
        const handler = (event) => { if (event.key === 'Escape') onEscape() }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
      }, [active, onEscape])
    }

    function Modal({ open, title, icon = 'plus', children, footer, onClose, labelledBy = 'pc-modal-title' }) {
      useEscape(open, onClose)
      const bodyRef = useRef(null)
      useEffect(() => {
        if (!open || !bodyRef.current) return
        const focusable = bodyRef.current.querySelector('input, select, textarea, button')
        if (focusable) focusable.focus()
      }, [open])
      if (!open) return null
      return h(React.Fragment, null,
        h('div', { className: 'pc-scrim', onClick: onClose, 'aria-hidden': 'true' }),
        h('div', { className: 'pc-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelledBy },
          h('div', { className: 'pc-modal-head' },
            h(Icon, { name: icon, size: 17 }),
            h('h2', { id: labelledBy }, title),
            h(IconBtn, { icon: 'close', title: 'Закрыть', onClick: onClose })),
          h('div', { className: 'pc-modal-body', ref: bodyRef }, children),
          footer ? h('div', { className: 'pc-modal-foot' }, footer) : null))
    }

    function Sheet({ open, title, icon = 'note', badge, actions, children, footer, onClose }) {
      useEscape(open, onClose)
      if (!open) return null
      return h(React.Fragment, null,
        h('div', { className: 'pc-scrim', onClick: onClose, 'aria-hidden': 'true' }),
        h('div', { className: 'pc-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          h('div', { className: 'pc-sheet-head' },
            h('div', { className: 'pc-sheet-title' },
              h('h2', null, title),
              h('div', { className: 'pc-chips' }, badge)),
            h('div', { className: 'pc-chips' }, actions),
            h(IconBtn, { icon: 'close', title: 'Закрыть карточку', onClick: onClose })),
          h('div', { className: 'pc-sheet-body' }, children),
          footer ? h('div', { className: 'pc-sheet-foot' }, footer) : null))
    }

    function Toast({ message, tone = '', onDone, duration = 2600 }) {
      useEffect(() => {
        if (!message) return undefined
        const timer = setTimeout(onDone, duration)
        return () => clearTimeout(timer)
      }, [message, duration, onDone])
      if (!message) return null
      return h('div', { className: `pc-toast${tone === 'danger' ? ' pc-toast-danger' : ''}`, role: 'status', 'aria-live': 'polite' },
        h(Icon, { name: tone === 'danger' ? 'alert' : 'check', size: 14 }), message)
    }

    /** Управляемый ввод поиска. */
    function SearchBox({ value, onChange, placeholder, label }) {
      return h('div', { className: 'pc-search' },
        h(Icon, { name: 'search', size: 15 }),
        h('input', {
          value,
          placeholder,
          'aria-label': label || placeholder,
          onChange: (event) => onChange(event.target.value)
        }),
        value ? h('button', { type: 'button', className: 'pc-search-clear', 'aria-label': 'Очистить поиск', onClick: () => onChange('') },
          h(Icon, { name: 'close', size: 12 })) : null)
    }

    /** Простое состояние тоста, исчезающего после монтирования. */
    function useToast() {
      const [toast, setToast] = useState(null)
      return {
        toast,
        show(message, tone = '') { setToast({ message, tone }) },
        clear() { setToast(null) }
      }
    }

    module.exports = { Icon, Btn, IconBtn, Segmented, Badge, RiskBadge, Progress, Stat, Empty, Notice, Field, Modal, Sheet, Toast, SearchBox, useToast }
  }
  __factories["shared/analysis.js"] = function (exports, module, __require) {
    /**
     * Анализ портфеля проектов: чистые функции, без DOM и React; общие для серверных тестов и панели.
     * Время всегда сравнивается по локальному календарному дню (YYYY-MM-DD), чтобы часовой пояс не ломал «сколько осталось».
     */

    const MODULES = ['Рабочие проекты', 'Текущие задачи', 'Другие проекты']
    const STATUSES = ['В работе', 'Не начат', 'Блокер', 'Завершён', 'На паузе']
    const RISK_LEVELS = ['overdue', 'blocked', 'urgent', 'slipping', 'soon', 'unscheduled', 'normal', 'done']

    const RISK_META = {
      overdue: { label: 'Просрочено', tone: 'danger', rank: 0 },
      blocked: { label: 'Блокер', tone: 'danger', rank: 1 },
      urgent: { label: 'Срочно', tone: 'danger', rank: 2 },
      slipping: { label: 'Отставание', tone: 'warn', rank: 3 },
      soon: { label: 'Скоро дедлайн', tone: 'warn', rank: 4 },
      unscheduled: { label: 'Без срока', tone: 'muted', rank: 5 },
      normal: { label: 'В норме', tone: 'ok', rank: 6 },
      done: { label: 'Завершён', tone: 'muted', rank: 7 }
    }

    const RISK_ORDER = RISK_LEVELS
    const DANGER_LEVELS = ['overdue', 'blocked', 'urgent']
    const WATCH_LEVELS = ['slipping', 'soon']

    const DAY_MS = 24 * 60 * 60 * 1000

    /** ISO-текст локального календарного дня. */
    function todayISO(now) {
      const date = now instanceof Date ? now : new Date()
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    /** Разобрать YYYY-MM-DD в миллисекунды локальной полуночи; при ошибке — null. */
    function dayStart(value) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim())
      if (!match) return null
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      return Number.isNaN(date.getTime()) ? null : date.getTime()
    }

    /** Целая разница дней от a до b (положительная, если b позже a). */
    function daysBetween(a, b) {
      const from = dayStart(a)
      const to = dayStart(b)
      if (from === null || to === null) return null
      return Math.round((to - from) / DAY_MS)
    }

    /** Остаток дней: отрицательное значение — просрочено. */
    function daysLeft(dueDate, today = todayISO()) {
      const left = daysBetween(today, dueDate)
      return left
    }

    function formatRemaining(dueDate, today = todayISO()) {
      const left = daysLeft(dueDate, today)
      if (left === null) return 'Без срока'
      if (left < 0) return `Просрочено на ${Math.abs(left)} дн.`
      if (left === 0) return 'Срок сегодня'
      if (left === 1) return 'Срок завтра'
      return `Осталось ${left} дн.`
    }

    /** Последний день недели (воскресенье). */
    function endOfWeek(today = todayISO()) {
      const start = dayStart(today)
      if (start === null) return today
      const date = new Date(start)
      const weekday = date.getDay()
      date.setDate(date.getDate() + (weekday === 0 ? 0 : 7 - weekday))
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    function openTodos(project) {
      return (Array.isArray(project?.todos) ? project.todos : []).filter((todo) => todo && todo.done !== true)
    }

    function latestUpdate(project) {
      const updates = Array.isArray(project?.updates) ? project.updates : []
      if (updates.length === 0) return null
      return updates.reduce((latest, item) => {
        if (!latest) return item
        return String(item?.at ?? '') > String(latest?.at ?? '') ? item : latest
      }, null)
    }

    /**
     * Риск по срокам одного проекта.
     * Порядок: завершён → просрочено → блокер → без срока → срочно (≤3 дней) → отставание → скоро (≤7 дней) → в норме.
     */
    function projectRisk(project, today = todayISO()) {
      const status = String(project?.status ?? '')
      if (status === 'Завершён') {
        return { level: 'done', ...RISK_META.done, detail: 'Сдано', remainingDays: daysLeft(project?.dueDate, today) }
      }
      if (status === 'Блокер') {
        return { level: 'blocked', ...RISK_META.blocked, detail: 'Заблокирован — нужно продвинуть', remainingDays: daysLeft(project?.dueDate, today) }
      }
      const left = daysLeft(project?.dueDate, today)
      if (left === null) {
        return { level: 'unscheduled', ...RISK_META.unscheduled, detail: 'Дедлайн не задан', remainingDays: null }
      }
      if (left < 0) {
        return { level: 'overdue', ...RISK_META.overdue, detail: `Срок просрочен на ${Math.abs(left)} дн.`, remainingDays: left }
      }
      if (left <= 3) {
        return { level: 'urgent', ...RISK_META.urgent, detail: left === 0 ? 'Срок сегодня' : `Осталось ${left} дн.`, remainingDays: left }
      }
      const slip = slippage(project, today)
      if (slip !== null && slip >= 0.3) {
        const percent = Math.round(slip * 100)
        return { level: 'slipping', ...RISK_META.slipping, detail: `Прошло ${percent}% срока, а прогресс всего ${clampProgress(project)}%`, remainingDays: left }
      }
      if (left <= 7) {
        return { level: 'soon', ...RISK_META.soon, detail: `Осталось ${left} дн.`, remainingDays: left }
      }
      return { level: 'normal', ...RISK_META.normal, detail: `Осталось ${left} дн. — в графике`, remainingDays: left }
    }

    function clampProgress(project) {
      const value = Number(project?.progress)
      if (!Number.isFinite(value)) return 0
      return Math.min(100, Math.max(0, Math.round(value)))
    }

    /** Доля прошедшего времени минус прогресс; null, если нет даты начала или период нулевой. */
    function slippage(project, today = todayISO()) {
      const start = dayStart(project?.startedOn)
      const due = dayStart(project?.dueDate)
      const now = dayStart(today)
      if (start === null || due === null || now === null || due <= start) return null
      const elapsed = Math.min(1, Math.max(0, (now - start) / (due - start)))
      return elapsed - clampProgress(project) / 100
    }

    /** Отсортировать проекты по риску: опасные впереди, внутри уровня — по остатку дней (меньше первым), затем по названию. */
    function sortByRisk(projects, today = todayISO()) {
      return [...projects].map((project) => ({ project, risk: projectRisk(project, today) }))
        .sort((a, b) => {
          if (a.risk.rank !== b.risk.rank) return a.risk.rank - b.risk.rank
          const leftA = a.risk.remainingDays
          const leftB = b.risk.remainingDays
          if (leftA !== null && leftB !== null && leftA !== leftB) return leftA - leftB
          if (leftA === null && leftB !== null) return 1
          if (leftA !== null && leftB === null) return -1
          return String(a.project.name).localeCompare(String(b.project.name), 'zh-Hans-CN')
        })
    }

    /** Сводка по одному модулю. */
    function moduleRollup(projects, module, today = todayISO()) {
      const items = module === 'Все' ? projects : projects.filter((project) => (project?.module || 'Другие проекты') === module)
      const risks = items.map((project) => projectRisk(project, today))
      return {
        module,
        total: items.length,
        active: items.filter((project) => project?.status === 'В работе').length,
        done: items.filter((project) => project?.status === 'Завершён').length,
        danger: risks.filter((risk) => DANGER_LEVELS.includes(risk.level)).length,
        watch: risks.filter((risk) => WATCH_LEVELS.includes(risk.level)).length,
        openTodos: items.reduce((sum, project) => sum + openTodos(project).length, 0)
      }
    }

    /** Список модулей: три фиксированных впереди, свои дополняются в порядке появления. */
    function moduleNames(projects) {
      const extra = []
      for (const project of projects) {
        const module = project?.module || 'Другие проекты'
        if (!MODULES.includes(module) && !extra.includes(module)) extra.push(module)
      }
      return [...MODULES, ...extra]
    }

    /** Обзор всего воркбенча: всего, распределение статусов, распределение рисков, сводки модулей, задачи на контроле. */
    function overview(projects, today = todayISO()) {
      const items = Array.isArray(projects) ? projects : []
      const sorted = sortByRisk(items, today)
      const risks = sorted.map((item) => item.risk)
      const byStatus = {}
      for (const project of items) {
        const status = project?.status || 'В работе'
        byStatus[status] = (byStatus[status] ?? 0) + 1
      }
      const byRisk = {}
      for (const risk of risks) byRisk[risk.level] = (byRisk[risk.level] ?? 0) + 1
      const followUps = []
      for (const project of sorted) {
        for (const todo of openTodos(project.project)) {
          followUps.push({ projectId: project.project.id, projectName: project.project.name, module: project.project.module, ...todo })
        }
      }
      followUps.sort((a, b) => {
        const left = dayStart(a.dueDate)
        const right = dayStart(b.dueDate)
        if (left === null && right === null) return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN')
        if (left === null) return 1
        if (right === null) return -1
        return left - right
      })
      return {
        today,
        total: items.length,
        byStatus,
        byRisk,
        attention: sorted.map((item) => ({ project: item.project, risk: item.risk })),
        modules: moduleNames(items).map((module) => moduleRollup(items, module, today)),
        followUps,
        dueSoon: sorted.filter((item) => ['overdue', 'urgent', 'soon'].includes(item.risk.level))
          .map((item) => ({ project: item.project, risk: item.risk }))
      }
    }

    /** Найти проект по id. */
    function findProject(projects, id) {
      return (Array.isArray(projects) ? projects : []).find((project) => project?.id === id) ?? null
    }

    module.exports = { MODULES, STATUSES, RISK_LEVELS, RISK_META, RISK_ORDER, DANGER_LEVELS, WATCH_LEVELS, todayISO, dayStart, daysBetween, daysLeft, formatRemaining, endOfWeek, openTodos, latestUpdate, projectRisk, clampProgress, slippage, sortByRisk, moduleRollup, moduleNames, overview, findProject }
  }
  __factories["client/screens.js"] = function (exports, module, __require) {
    /** Компоненты доски по каждому разрезу. */
    const React = __require("react")
    const { Donut, Histogram, Legend, RankBars, StackedBars } = __require("client/charts.js")
    const { Badge, Btn, Empty, Icon, IconBtn, Progress, RiskBadge, Stat } = __require("client/ui.js")
    const { clampProgress, formatRemaining, latestUpdate, openTodos, projectRisk } = __require("shared/analysis.js")
    const h = React.createElement
    const PROGRESS_TONE = { overdue: 'danger', blocked: 'danger', urgent: 'danger', slipping: 'warn', soon: 'warn', done: 'ok' }
    const accentOf = (accents, module) => accents?.[module] ?? 'indigo'

    /* ---------------------------------------------------------------- Карточка проекта */

    function ProjectCard({ project, risk, today, accents, onOpen }) {
      const todos = openTodos(project)
      const latest = latestUpdate(project)
      const accent = accentOf(accents, project.module || 'Другие проекты')
      return h('button', {
        type: 'button', className: `pc-card pc-accent-${accent}`, onClick: onOpen,
        title: `${project.name} · ${risk.label}`
      },
      h('span', { className: 'pc-card-accent', 'aria-hidden': 'true' }),
      h('div', { className: 'pc-card-top' },
        h('span', { className: 'pc-card-name' }, project.name),
        h(RiskBadge, { risk })),
      project.summary
        ? h('div', { className: 'pc-card-sum' }, project.summary)
        : latest ? h('div', { className: 'pc-card-sum' }, latest.text) : null,
      h(Progress, { value: project.progress, tone: PROGRESS_TONE[risk.level] ?? '' }),
      h('div', { className: 'pc-card-foot' },
        h('span', null, 'Прогресс ', h('b', null, `${clampProgress(project)}%`)),
        h('span', null, formatRemaining(project.dueDate, today)),
        todos.length > 0 ? h('span', null, 'На контроле ', h('b', null, String(todos.length))) : null,
        project.owner ? h('span', null, project.owner) : null),
      project.tags?.length
        ? h('div', { className: 'pc-card-tags' }, project.tags.slice(0, 4).map((tag) => h('span', { key: tag, className: 'pc-tag' }, tag)))
        : null)
    }

    /** Компактная карточка-строка (для колонок доски). */
    function MiniCard({ project, risk, accents, onOpen }) {
      const accent = accentOf(accents, project.module || 'Другие проекты')
      return h('button', { type: 'button', className: `pc-mini pc-accent-${accent}`, onClick: onOpen },
        h('span', { className: 'pc-mini-name' }, project.name),
        h('div', { className: 'pc-mini-meta' },
          h('span', { className: `pc-dot pc-c-${risk.tone}` }),
          h('span', null, risk.label),
          h('span', null, `${clampProgress(project)}%`),
          project.dueDate ? h('span', null, project.dueDate.slice(5)) : null))
    }

    /* -------------------------------------------------------------- По модулям */

    function BoardScreen({ groups, today, accents, onOpen }) {
      return groups.map((group) => {
        const accent = accentOf(accents, group.module)
        return h('section', { className: `pc-module pc-accent-${accent}`, key: group.module },
          h('div', { className: 'pc-module-head' },
            h('div', { className: 'pc-module-title' },
              h('span', { className: 'pc-module-bar' }),
              group.module,
              h('span', { className: 'pc-pill' }, `${group.stats.total} шт.`)),
            h('div', { className: 'pc-module-meta' },
              group.stats.danger + group.stats.watch > 0
                ? h(Badge, { tone: 'warn', dot: true }, `требуют внимания: ${group.stats.danger + group.stats.watch}`)
                : h(Badge, { tone: 'ok', dot: true }, 'В графике'),
              h('span', null, `на контроле: ${group.stats.openTodos}`),
              h('span', null, `средний прогресс ${group.stats.avgProgress}%`))),
          h('div', { className: 'pc-cards' }, group.projects.map((project) => h(ProjectCard, {
            key: project.id,
            project,
            risk: projectRisk(project, today),
            today,
            accents,
            onOpen: () => onOpen(project.id)
          }))))
      })
    }

    /* ------------------------------------------------------------------ Список */

    function ListScreen({ rows, today, accents, onOpen }) {
      return h('div', { className: 'pc-table-wrap' },
        h('table', { className: 'pc-table' },
          h('thead', null, h('tr', null,
            ['Проект', 'Модуль', 'Статус', 'Прогресс', 'Дедлайн', 'Осталось', 'Риск', 'На контроле'].map((label) => h('th', { key: label }, label)))),
          h('tbody', null, rows.map(({ project, risk }) => h('tr', {
            key: project.id,
            tabIndex: 0,
            onClick: () => onOpen(project.id),
            onKeyDown: (event) => { if (event.key === 'Enter') onOpen(project.id) }
          },
          h('td', { className: 'pc-name', title: project.name },
            h('i', { className: `pc-accent-dot pc-accent-${accentOf(accents, project.module || 'Другие проекты')}` }),
            project.name),
          h('td', null, h('span', { className: 'pc-tag' }, project.module || 'Другие проекты')),
          h('td', null, project.status || 'В работе'),
          h('td', { className: 'pc-num' }, `${clampProgress(project)}%`),
          h('td', { className: 'pc-num' }, project.dueDate || 'Без срока'),
          h('td', { className: 'pc-num' }, formatRemaining(project.dueDate, today)),
          h('td', null, h(RiskBadge, { risk })),
          h('td', { className: 'pc-num' }, openTodos(project).length > 0 ? String(openTodos(project).length) : '—'))))))
    }

    /* ------------------------------------------------------------------ Доска */

    function KanbanScreen({ columns, accents, onOpen }) {
      const visible = columns.filter((column) => column.projects.length > 0)
      if (visible.length === 0) return h(Empty, { icon: 'grid', title: 'Нет проектов для показа', hint: 'По текущему фильтру проектов нет.' })
      return h('div', { className: 'pc-kanban' }, visible.map((column) => h('section', { className: 'pc-kanban-col', key: column.status },
        h('header', { className: 'pc-kanban-head' },
          h('span', { className: `pc-dot pc-c-${column.tone}` }),
          h('b', null, column.status),
          h('span', { className: 'pc-pill' }, String(column.stats.total)),
          column.stats.danger > 0 ? h(Badge, { tone: 'danger' }, `критично: ${column.stats.danger}`) : null),
        h('div', { className: 'pc-kanban-body' },
          column.projects.map((item) => h(MiniCard, {
            key: item.project.id, project: item.project, risk: item.risk, accents, onOpen: () => onOpen(item.project.id)
          }))))))
    }

    /* ------------------------------------------------------------------ Календарь */

    const WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']

    function CalendarScreen({ model, today, selectedIso, onSelect, onShift, onToday, onOpen, onToggleTodo }) {
      const selected = model.cells.find((cell) => cell.iso === selectedIso)
        ?? model.cells.find((cell) => cell.isToday)
        ?? model.cells.find((cell) => cell.inMonth && cell.items.length > 0)
        ?? model.cells[0]
      return h('div', { className: 'pc-cal' },
        h('div', { className: 'pc-cal-head' },
          h('div', { className: 'pc-cal-title' },
            h('b', null, model.label),
            h('span', { className: 'pc-muted' }, `В этом месяце событий: ${model.monthItems} · дней с делами: ${model.daysWithItems}`)),
          h('div', { className: 'pc-cal-actions' },
            h(IconBtn, { icon: 'arrowLeft', title: 'Прошлый месяц', onClick: () => onShift(-1) }),
            h(Btn, { size: 'sm', onClick: onToday }, 'Сегодня'),
            h(IconBtn, { icon: 'chevron', title: 'Следующий месяц', onClick: () => onShift(1) }))),
        h('div', { className: 'pc-cal-weekdays' }, WEEKDAYS.map((day) => h('span', { key: day }, day))),
        h('div', { className: 'pc-cal-grid' }, model.cells.map((cell) => h('button', {
          key: cell.iso,
          type: 'button',
          className: `pc-cal-cell${cell.inMonth ? '' : ' pc-cal-out'}${cell.isToday ? ' pc-cal-today' : ''}${cell.iso === selected.iso ? ' pc-cal-selected' : ''}${cell.isWeekend ? ' pc-cal-weekend' : ''}`,
          onClick: () => onSelect(cell.iso)
        },
        h('span', { className: 'pc-cal-day' }, String(cell.day)),
        h('div', { className: 'pc-cal-items' }, cell.items.slice(0, 3).map((item) => h('span', {
          key: item.key,
          className: `pc-cal-chip pc-c-${item.tone}`,
          title: `${item.label}: ${item.title}`
        }, item.title))),
        cell.items.length > 3 ? h('span', { className: 'pc-cal-more' }, `+${cell.items.length - 3}`) : null))),
        h('div', { className: 'pc-cal-detail' },
          h('div', { className: 'pc-block-head' },
            h(Icon, { name: 'calendar', size: 14 }),
            h('h3', { style: { textTransform: 'none', letterSpacing: 0, fontSize: '12.5px', color: 'var(--pc-text)' } }, selected.iso),
            h('span', { className: 'pc-spacer' }),
            h('span', { className: 'pc-muted' }, selected.items.length > 0 ? `${selected.items.length} шт.` : 'На этот день ничего не запланировано')),
          selected.items.length === 0
            ? h('div', { className: 'pc-muted' }, 'В этот день нет ни дедлайнов, ни задач на контроле.')
            : h('div', { className: 'pc-cal-list' }, selected.items.map((item) => h('div', { key: item.key, className: 'pc-cal-row' },
              h('span', { className: `pc-dot pc-c-${item.tone}` }),
              h(Badge, { tone: item.kind === 'due' ? item.tone : 'muted' }, item.kind === 'due' ? item.label : 'На контроле'),
              h('button', { type: 'button', className: 'pc-link', onClick: () => onOpen(item.projectId) }, item.title),
              h('span', { className: 'pc-muted' }, item.kind === 'due' ? item.module : item.projectName),
              item.kind === 'todo' && onToggleTodo
                ? h(Btn, { size: 'sm', onClick: () => onToggleTodo(item.projectId, item.todoId) }, 'Выполнено')
                : null)))))
    }

    /* ---------------------------------------------------------------- Таймлайн */

    function TimelineScreen({ model, today, accents, onOpen }) {
      if (model.rows.length === 0) return h(Empty, { icon: 'clock', title: 'Нет проектов с датами', hint: 'Укажите даты начала и дедлайна — и здесь появится таймлайн.' })
      return h('div', { className: 'pc-tl' },
        h('div', { className: 'pc-tl-note' },
          h(Icon, { name: 'clock', size: 13 }),
          h('span', null, `${model.from} → ${model.to} (${model.totalDays} дн.)`),
          model.padded ? h('span', { className: 'pc-muted' }, 'Диапазон большой — показаны первые 210 дней') : null),
        h('div', { className: 'pc-tl-head' },
          h('span', { className: 'pc-tl-head-name' }, 'Проект'),
          h('div', { className: 'pc-tl-axis' }, model.ticks.map((tick) => h('span', {
            key: tick.index, style: { left: `${tick.percent}%` }
          }, tick.label)))),
        h('div', { className: 'pc-tl-body' },
          h('span', {
            className: 'pc-tl-todayline',
            style: { left: `calc(186px + (100% - 186px) * ${(model.todayPercent / 100).toFixed(4)})` },
            title: `Сегодня ${today}`,
            'aria-hidden': 'true'
          }),
          model.rows.map((row) => h('div', { className: 'pc-tl-row', key: row.project.id },
            h('button', { type: 'button', className: 'pc-tl-name', onClick: () => onOpen(row.project.id), title: row.project.name },
              h('i', { className: `pc-accent-dot pc-accent-${accentOf(accents, row.project.module || 'Другие проекты')}` }),
              h('span', null, row.project.name)),
            h('div', { className: 'pc-tl-track' },
              h('button', {
                type: 'button',
                className: `pc-tl-bar pc-c-${row.risk.tone}`,
                style: { left: `${row.leftPercent}%`, width: `${Math.max(row.widthPercent, 1.5)}%` },
                onClick: () => onOpen(row.project.id),
                title: `${row.project.name} · ${row.startIso} → ${row.endIso} · ${row.risk.label}`
              },
              h('em', null, row.risk.label),
              h('i', null, `${clampProgress(row.project)}%`)))))))
    }

    /* -------------------------------------------------------------- На контроле */

    function FollowUpsScreen({ buckets, today, onToggle, onOpen }) {
      const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0)
      if (total === 0) return h(Empty, { icon: 'check', title: 'Список на контроле пуст', hint: 'Все задачи выполнены.' })
      return h('div', { className: 'pc-follow' }, buckets.filter((bucket) => bucket.total > 0).map((bucket) => h('section', {
        className: 'pc-follow-group', key: bucket.key
      },
      h('div', { className: 'pc-block-head' },
        h('span', { className: `pc-dot pc-c-${bucket.tone}` }),
        h('h3', { style: { textTransform: 'none', letterSpacing: 0, fontSize: '12.5px', color: 'var(--pc-text)' } }, bucket.label),
        h('span', { className: 'pc-pill' }, String(bucket.total)),
        h('span', { className: 'pc-spacer' })),
      h('div', null, bucket.items.map((item) => h('div', { className: 'pc-follow-row', key: item.key },
        h('input', {
          type: 'checkbox', checked: false, 'aria-label': `Выполнено: ${item.title}`,
          onChange: () => onToggle(item.projectId, item.todoId)
        }),
        h('span', { className: 'pc-follow-title' }, item.title),
        h('button', { type: 'button', className: 'pc-link', onClick: () => onOpen(item.projectId) }, item.projectName),
        h('span', { className: 'pc-tag' }, item.module),
        item.owner ? h('span', { className: 'pc-muted' }, item.owner) : null,
        h('span', { className: `pc-follow-due${item.overdueDays > 0 ? ' pc-c-danger' : ''}` },
          item.dueDate ? (item.overdueDays > 0 ? `просрочено на ${item.overdueDays} дн.` : item.dueDate) : 'Без срока')))))))
    }

    /* ------------------------------------------------------------------ Обзор */

    function Panel({ title, icon, extra, children, className = '' }) {
      return h('section', { className: `pc-panel-block ${className}` },
        h('div', { className: 'pc-panel-head' },
          icon ? h(Icon, { name: icon, size: 14 }) : null,
          h('h3', null, title),
          h('span', { className: 'pc-spacer' }),
          extra || null),
        children)
    }

    function OverviewScreen({
      today, accents, kpis, risks, modules, progress, owners, attention, dueSoon, onOpen, ask
    }) {
      const riskSlices = risks.map((item) => ({ key: item.level, label: item.label, count: item.count, tone: item.tone }))
      const moduleRows = modules.map((row) => ({
        key: row.module,
        label: row.module,
        meta: `проектов: ${row.total} · средний прогресс ${row.avgProgress}%`,
        total: row.total,
        segments: [
          { label: 'Критично', value: row.danger, tone: 'danger' },
          { label: 'Внимание', value: row.watch, tone: 'warn' },
          { label: 'В норме', value: row.normal, tone: 'ok' }
        ]
      }))
      const ownerRows = owners.map((row) => ({
        key: row.owner,
        label: row.owner,
        total: row.total,
        danger: row.danger,
        meta: `на контроле: ${row.openTodos}`
      }))

      const listRow = (item) => h('button', { type: 'button', className: 'pc-attn', key: item.project.id, onClick: () => onOpen(item.project.id) },
        h('span', { className: `pc-accent-dot pc-accent-${accentOf(accents, item.project.module || 'Другие проекты')}` }),
        h('span', { className: 'pc-attn-name' }, item.project.name),
        h('span', { className: 'pc-muted' }, item.project.module || 'Другие проекты'),
        h(RiskBadge, { risk: item.risk }),
        h('span', { className: 'pc-muted' }, formatRemaining(item.project.dueDate, today)))

      return h(React.Fragment, null,
        h('div', { className: 'pc-kpis' },
          h(Stat, { label: 'Всего проектов', value: kpis.total, hint: `в работе: ${kpis.active}`, icon: 'grid' }),
          h(Stat, { label: 'Требуют внимания', value: kpis.attention, hint: `просрочено ${kpis.overdue} · блокеров ${kpis.blocked}`, tone: 'danger', icon: 'alert' }),
          h(Stat, { label: 'На контроле', value: kpis.openTodos, hint: kpis.todoOverdue > 0 ? `просрочено задач: ${kpis.todoOverdue}` : 'Просроченных задач нет', tone: kpis.todoOverdue > 0 ? 'warn' : '', icon: 'check' }),
          h(Stat, { label: 'Дедлайн на неделе', value: kpis.weekDue, hint: 'До конца недели', icon: 'calendar' }),
          h(Stat, { label: 'Средний прогресс', value: `${kpis.avgProgress}%`, hint: `завершено: ${kpis.done}`, tone: 'ok', icon: 'target' }),
          h(Stat, { label: 'Без срока', value: kpis.unscheduled, hint: 'Без дедлайна', tone: kpis.unscheduled > 0 ? 'warn' : '', icon: 'clock' })),

        h('div', { className: 'pc-panel-block pc-hero' },
          h('div', { className: 'pc-hero-mark' }, h(Icon, { name: 'sparkle', size: 16 })),
          h('div', null,
            h('div', { className: 'pc-hero-title' }, 'На что смотреть сегодня'),
            h('div', { className: 'pc-hero-sub' }, kpis.total === 0
              ? 'Проектов пока нет — добавьте несколько, и доска наполнится.'
              : `требуют внимания: ${kpis.attention} · просрочено: ${kpis.overdue} · критично: ${kpis.danger} · дедлайн на неделе: ${kpis.weekDue}`))),

        ask,

        h('div', { className: 'pc-dash-grid' },
          h(Panel, { title: 'Распределение рисков', icon: 'alert' },
            h('div', { className: 'pc-donut-wrap' },
              h(Donut, { slices: riskSlices, centerValue: kpis.total, centerLabel: 'Проект', label: 'Распределение рисков' }),
              h(Legend, { items: risks.map((item) => ({ key: item.level, label: item.label, count: item.count, tone: item.tone })) }))),
          h(Panel, { title: 'Нагрузка по модулям', icon: 'grid' },
            h(StackedBars, { rows: moduleRows, empty: 'Проектов пока нет' })),

          h(Panel, { title: 'Распределение прогресса', icon: 'target' },
            h(Histogram, { buckets: progress })),
          h(Panel, { title: 'Нагрузка по ответственным', icon: 'users' },
            h(RankBars, { rows: ownerRows, empty: 'Проектов пока нет' })),

          h(Panel, {
            title: 'Срочно требует внимания',
            icon: 'alert',
            extra: h('span', { className: 'pc-muted' }, `${attention.length} шт.`)
          }, attention.length === 0
            ? h('div', { className: 'pc-muted' }, 'Сейчас нет проектов, требующих эскалации.')
            : h('div', { className: 'pc-attn-list' }, attention.slice(0, 6).map(listRow))),

          h(Panel, {
            title: 'Дедлайн на неделе',
            icon: 'calendar',
            extra: h('span', { className: 'pc-muted' }, `${dueSoon.length} шт.`)
          }, dueSoon.length === 0
            ? h('div', { className: 'pc-muted' }, 'На этой неделе ничего не сдаётся.')
            : h('div', { className: 'pc-attn-list' }, dueSoon.slice(0, 6).map(listRow)))))
    }

    module.exports = { ProjectCard, BoardScreen, ListScreen, KanbanScreen, CalendarScreen, TimelineScreen, FollowUpsScreen, OverviewScreen }
  }
  __factories["client/charts.js"] = function (exports, module, __require) {
    /** Лёгкие графики вручную: без сторонних библиотек, только SVG / CSS-переменные, следуют теме хоста. */
    const React = __require("react")

    const h = React.createElement

    const toneClass = (tone) => `pc-c-${tone || 'muted'}`

    /**
     * Кольцевая диаграмма.
     * @param slices - [{ key, count, tone }]
     * @param centerValue / centerLabel — текст в центре.
     */
    function Donut({ slices, centerValue, centerLabel, size = 136, thickness = 15, label = 'Распределение' }) {
      const total = slices.reduce((sum, slice) => sum + slice.count, 0)
      const radius = (size - thickness) / 2
      const circumference = 2 * Math.PI * radius
      let offset = 0
      return h('div', { className: 'pc-donut', style: { width: `${size}px`, height: `${size}px` } },
        h('svg', {
          width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img',
          'aria-label': `${label}: ${slices.map((slice) => ((slice.label ?? slice.key) + ' ' + slice.count)).join(', ') || 'нет данных'}`
        },
        h('circle', {
          cx: size / 2, cy: size / 2, r: radius, fill: 'none',
          className: 'pc-donut-track', strokeWidth: thickness
        }),
        total > 0
          ? slices.map((slice) => {
            const length = (slice.count / total) * circumference
            const gap = circumference - length
            const node = h('circle', {
              key: slice.key,
              cx: size / 2, cy: size / 2, r: radius, fill: 'none',
              className: `pc-donut-slice ${toneClass(slice.tone)}`,
              strokeWidth: thickness,
              strokeDasharray: `${length} ${gap}`,
              strokeDashoffset: -offset,
              transform: `rotate(-90 ${size / 2} ${size / 2})`
            })
            offset += length
            return node
          })
          : null),
        h('div', { className: 'pc-donut-center' },
          h('b', null, String(centerValue ?? total)),
          h('span', null, centerLabel ?? 'Проект')))
    }

    /** Легенда. */
    function Legend({ items }) {
      return h('ul', { className: 'pc-legend' }, items.map((item) => h('li', { key: item.key },
        h('i', { className: toneClass(item.tone) }),
        h('span', null, item.label),
        h('b', null, String(item.count)))))
    }

    /**
     * Стековая полоса: одна строка на разрез, внутри — сегменты по составу.
     * @param rows - [{ key, label, meta, segments: [{ value, tone, label }], total }]
     */
    function StackedBars({ rows, max, empty = 'Нет данных' }) {
      if (!rows || rows.length === 0) return h('div', { className: 'pc-muted' }, empty)
      const ceiling = max ?? Math.max(...rows.map((row) => row.total), 1)
      return h('div', { className: 'pc-stacked' }, rows.map((row) => h('div', { className: 'pc-stacked-row', key: row.key },
        h('div', { className: 'pc-stacked-head' },
          h('span', { className: 'pc-stacked-label', title: row.label }, row.label),
          h('span', { className: 'pc-stacked-meta' }, row.meta ?? String(row.total))),
        h('div', {
          className: 'pc-stacked-track',
          role: 'img',
          'aria-label': `${row.label}: ${row.segments.map((segment) => (segment.label + ' ' + segment.value)).join(', ')}`
        },
        row.segments.filter((segment) => segment.value > 0).map((segment) => h('span', {
          key: segment.label,
          className: `pc-stacked-seg ${toneClass(segment.tone)}`,
          style: { width: `${(segment.value / ceiling) * 100}%` },
          title: `${segment.label} ${segment.value}`
        }))))))
    }

    /** Вертикальная гистограмма. */
    function Histogram({ buckets }) {
      const max = Math.max(...buckets.map((bucket) => bucket.count), 1)
      return h('div', { className: 'pc-hist' }, buckets.map((bucket) => h('div', { className: 'pc-hist-col', key: bucket.label },
        h('div', { className: 'pc-hist-track' },
          h('div', {
            className: `pc-hist-bar${bucket.count === 0 ? ' pc-hist-empty' : ''}`,
            style: { height: `${Math.max(3, (bucket.count / max) * 100)}%` },
            title: `${bucket.label}: ${bucket.count} шт.`
          })),
        h('b', null, String(bucket.count)),
        h('span', null, bucket.label))))
    }

    /** Одна строка рейтинга (нагрузка ответственных и т.п.). */
    function RankBars({ rows, empty = 'Нет данных' }) {
      if (!rows || rows.length === 0) return h('div', { className: 'pc-muted' }, empty)
      const max = Math.max(...rows.map((row) => row.total), 1)
      return h('div', { className: 'pc-rank' }, rows.map((row) => h('div', { className: 'pc-rank-row', key: row.key },
        h('span', { className: 'pc-rank-label', title: row.label }, row.label),
        h('div', { className: 'pc-rank-track' },
          h('span', { className: 'pc-rank-fill', style: { width: `${(row.total / max) * 100}%` } }),
          row.danger > 0
            ? h('span', { className: 'pc-rank-danger', style: { width: `${(row.danger / max) * 100}%` }, title: `из них требуют внимания: ${row.danger}` })
            : null),
        h('b', null, String(row.total)),
        h('small', null, row.meta ?? ''))))
    }

    module.exports = { Donut, Legend, StackedBars, Histogram, RankBars }
  }
  __factories["shared/query.js"] = function (exports, module, __require) {
    /**
     * «Спросить»: правило-ориентированные ответы по уже сохранённым локальным данным.
     * Не нужны ни сессия, ни модель: открыл воркбенч и пользуйся; для глубокого анализа панель собирает промпт для Agent.
     */
    const { DANGER_LEVELS, WATCH_LEVELS, clampProgress, daysLeft, endOfWeek, formatRemaining, latestUpdate, openTodos, overview, projectRisk, sortByRisk, todayISO } = __require("shared/analysis.js")
    const RISKY = [...DANGER_LEVELS, ...WATCH_LEVELS]

    const line = (project, risk) => `· ${project.name} (${project.module || 'Другие проекты'} · ${project.status || 'В работе'} · ${formatRemaining(project.dueDate, risk.today)})${risk.detail ? ' — ' + risk.detail : ''}`

    function projectLine(project, today) {
      const risk = projectRisk(project, today)
      return { text: line(project, { ...risk, today }), id: project.id }
    }

    function header(title, count) {
      return count === 0 ? `${title}: подходящих проектов нет.` : `${title} (${count})`
    }

    function answerRisky(projects, today) {
      const risky = sortByRisk(projects, today).filter((item) => RISKY.includes(item.risk.level))
      if (risky.length === 0) return { text: 'Сейчас нет проектов, требующих особого внимания: дедлайны и прогресс в норме.', projectIds: [] }
      const body = risky.map((item) => line(item.project, { ...item.risk, today })).join('\n')
      return {
        text: `${header('Проекты, требующие внимания', risky.length)}\n${body}`,
        projectIds: risky.map((item) => item.project.id)
      }
    }

    function answerDueWithin(projects, today, label, predicate) {
      const hits = sortByRisk(projects, today).filter((item) => predicate(item.project, today))
      if (hits.length === 0) return { text: `${label}: проектов с таким сроком нет.`, projectIds: [] }
      return {
        text: `${header(label, hits.length)}\n${hits.map((item) => line(item.project, { ...item.risk, today })).join('\n')}`,
        projectIds: hits.map((item) => item.project.id)
      }
    }

    function answerFollowUps(projects, today, filter) {
      const items = []
      for (const project of projects) {
        for (const todo of openTodos(project)) {
          if (filter && !filter(todo, today)) continue
          items.push({ project, todo })
        }
      }
      if (items.length === 0) return { text: 'Список на контроле пуст.', projectIds: [] }
      items.sort((a, b) => String(a.todo.dueDate || '9999').localeCompare(String(b.todo.dueDate || '9999')))
      const body = items.slice(0, 30).map(({ project, todo }) =>
        `· [${todo.done ? 'x' : ' '}] ${todo.title} · ${project.name}${todo.dueDate ? (' · срок ' + todo.dueDate) : ''}${todo.owner ? (' · ' + todo.owner) : ''}`).join('\n')
      return {
        text: `${header('Задачи на контроле', items.length)}\n${body}`,
        projectIds: [...new Set(items.map(({ project }) => project.id))]
      }
    }

    function answerProject(project, today) {
      const risk = projectRisk(project, today)
      const latest = latestUpdate(project)
      const todos = openTodos(project)
      const lines = [
        `${project.name} (${project.module || 'Другие проекты'})`,
        `Статус: ${project.status || 'В работе'} · прогресс: ${clampProgress(project)}% · ${formatRemaining(project.dueDate, today)}`,
        `Риск: ${risk.label} — ${risk.detail}`,
        project.owner ? `Ответственный: ${project.owner}` : '',
        project.summary ? `Описание: ${project.summary}` : '',
        latest ? `Последнее (${String(latest.at).slice(0, 10)}): ${latest.text}` : 'Записей о прогрессе пока нет',
        todos.length > 0 ? `Задач на контроле: ${todos.length}: ${todos.slice(0, 5).map((todo) => todo.title).join(', ')}` : 'Открытых задач нет'
      ]
      return { text: lines.filter(Boolean).join('\n'), projectIds: [project.id] }
    }

    function answerOverview(projects, today) {
      const data = overview(projects, today)
      if (data.total === 0) return { text: 'В воркбенче пока нет проектов. Нажмите «Новый проект» справа сверху.', projectIds: [] }
      const moduleLines = data.modules.filter((item) => item.total > 0)
        .map((item) => `· ${item.module}: ${item.total} · в работе ${item.active} · критично ${item.danger} · на контроле ${item.openTodos}`).join('\n')
      const danger = data.attention.filter((item) => RISKY.includes(item.risk.level)).slice(0, 5)
      return {
        text: [
          `Всего проектов: ${data.total}: ${Object.entries(data.byStatus).map(([key, value]) => (key + ' ' + value)).join(', ')}`,
          moduleLines ? `\nПо модулям:\n${moduleLines}` : '',
          `\nТребуют внимания: ${data.attention.filter((item) => RISKY.includes(item.risk.level)).length}, просрочено: ${data.byRisk.overdue ?? 0}.`,
          danger.length > 0 ? `\nВ первую очередь:\n${danger.map((item) => line(item.project, { ...item.risk, today })).join('\n')}` : ''
        ].filter(Boolean).join('\n'),
        projectIds: danger.map((item) => item.project.id)
      }
    }

    /** Ответить на вопрос на естественном языке; вернуть текст и id связанных проектов. */
    function answerQuestion(question, projects, today = todayISO()) {
      const raw = String(question ?? '').trim()
      const items = Array.isArray(projects) ? projects : []
      if (!raw) return { text: 'Спросите, например: что сдаём на этой неделе? где риски? что у меня на контроле?', projectIds: [] }
      if (items.length === 0) return { text: 'В воркбенче пока нет проектов — добавьте несколько, и я начну следить.', projectIds: [] }

      const named = items.find((project) => project?.name && raw.includes(project.name))
      if (named) return answerProject(named, today)

      if (/риск|опасн|проблем|срыв|авари|горит|под угрозой/i.test(raw)) return answerRisky(items, today)
      // Задачи идут раньше «просрочено»: вопрос «какие задачи просрочены» про задачи, а не про проекты.
      if (/контрол|задач|сделать|не сделано|действи|поручен/i.test(raw)) {
        if (/просроч|просрочен|опозда/i.test(raw)) return answerFollowUps(items, today, (todo, now) => (daysLeft(todo.dueDate, now) ?? 1) < 0)
        return answerFollowUps(items, today)
      }
      if (/просроч|опозда|срок прошёл|дедлайн прошёл|не успева/i.test(raw)) return answerDueWithin(items, today, 'Просроченные проекты', (project, now) => (daysLeft(project.dueDate, now) ?? 1) < 0)
      if (/сегодня/i.test(raw)) return answerDueWithin(items, today, 'Проекты со сроком сегодня', (project, now) => daysLeft(project.dueDate, now) === 0)
      if (/завтра/i.test(raw)) return answerDueWithin(items, today, 'Проекты со сроком завтра', (project, now) => daysLeft(project.dueDate, now) === 1)
      if (/недел|к пятниц|к концу/i.test(raw)) {
        const end = endOfWeek(today)
        return answerDueWithin(items, today, `Проекты со сроком на этой неделе (до ${end})`, (project, now) => {
          const left = daysLeft(project.dueDate, now)
          return left !== null && left >= 0 && project.dueDate <= end
        })
      }
      if (/месяц|месяце/i.test(raw)) {
        const month = today.slice(0, 7)
        return answerDueWithin(items, today, `Проекты со сроком в ${month}`, (project) => String(project.dueDate || '').startsWith(month))
      }
      if (/блок|заблокир|встал/i.test(raw)) {
        const blocked = items.filter((project) => project?.status === 'Блокер')
        if (blocked.length === 0) return { text: 'Заблокированных проектов нет.', projectIds: [] }
        return { text: `${header('Заблокированные проекты', blocked.length)}\n${blocked.map((project) => projectLine(project, today).text).join('\n')}`, projectIds: blocked.map((project) => project.id) }
      }
      if (/обзор|общ|в целом|как дела|статус|сводк|отчёт|отчет|распределен/i.test(raw)) return answerOverview(items, today)

      const risk = answerRisky(items, today)
      return {
        text: `Не понял «${raw}» — вот самое важное сейчас. Можно назвать проект или спросить: что на неделе, просрочено, на контроле, блокеры, обзор.\n${risk.text}`,
        projectIds: risk.projectIds
      }
    }

    /** Примеры вопросов для панели. */
    const QUESTION_EXAMPLES = ['что сдаём на этой неделе?', 'где риски?', 'что у меня на контроле?', 'как дела в целом?']

    module.exports = { answerQuestion, QUESTION_EXAMPLES }
  }
  __factories["shared/prompt.js"] = function (exports, module, __require) {
    /**
     * Превращает данные проектов в промпты для Agent и в частые черновики документов.
     * Панель только генерирует текст, копирует и экспортирует; отправку пользователь делает в соседней нативной сессии.
     */
    const { clampProgress, formatRemaining, latestUpdate, openTodos, overview, projectRisk, sortByRisk } = __require("shared/analysis.js")
    const KIND_LABELS = { note: 'Запись', progress: 'Прогресс', blocker: 'Блокер', decision: 'Решение' }

    function bullets(items, empty = '(пока нет)') {
      if (!items || items.length === 0) return empty
      return items.map((item) => `- ${item}`).join('\n')
    }

    /** Markdown-сводка одного проекта — общая для промптов и черновиков. */
    function projectBrief(project, today) {
      const risk = projectRisk(project, today)
      const updates = (Array.isArray(project?.updates) ? project.updates : [])
        .slice()
        .sort((a, b) => String(b?.at ?? '').localeCompare(String(a?.at ?? '')))
      const todos = openTodos(project)
      const doneTodos = (Array.isArray(project?.todos) ? project.todos : []).filter((todo) => todo?.done === true)
      return [
        `### ${project?.name ?? 'Без названия'}`,
        `- Модуль: ${project?.module || 'Другие проекты'}`,
        `- Статус: ${project?.status || 'В работе'}`,
        `- Прогресс: ${clampProgress(project)}%`,
        `- Ответственный: ${project?.owner || 'не указан'}`,
        `- Сроки: ${project?.startedOn || 'не задано'} → ${project?.dueDate || 'без срока'} (${formatRemaining(project?.dueDate, today)})`,
        `- Риск по срокам: ${risk.label} — ${risk.detail}`,
        project?.link ? `- Ссылка: ${project.link}` : '',
        project?.summary ? `- Кратко: ${project.summary}` : '',
        project?.tags?.length ? `- Теги: ${project.tags.join(', ')}` : '',
        '',
        `**Записи о прогрессе (новые → старые, всего ${updates.length})**`,
        bullets(updates.slice(0, 20).map((item) => `${String(item.at).slice(0, 10)} [${KIND_LABELS[item.kind] ?? 'запись'}] ${item.text}`)),
        '',
        `**Открытые задачи (${todos.length})**`,
        bullets(todos.map((todo) => `${todo.title}${todo.dueDate ? ' (срок ' + todo.dueDate + ')' : ''}${todo.owner ? ' — ' + todo.owner : ''}`)),
        '',
        `**Закрытые задачи (${doneTodos.length})**`,
        bullets(doneTodos.slice(0, 10).map((todo) => todo.title))
      ].filter((row) => row !== '').join('\n')
    }

    /** Markdown-сводка всех проектов в порядке риска. */
    function portfolioBrief(projects, today) {
      const sorted = sortByRisk(projects, today)
      if (sorted.length === 0) return '(в воркбенче пока нет проектов)'
      return sorted.map((item) => projectBrief(item.project, today)).join('\n\n')
    }

    function portfolioNumbers(projects, today) {
      const data = overview(projects, today)
      const modules = data.modules.filter((item) => item.total > 0)
        .map((item) => `- ${item.module}: проектов ${item.total} (в работе ${item.active}, критично ${item.danger}, на контроле ${item.openTodos})`)
      return [
        `- Всего проектов: ${data.total}`,
        `- Статусы: ${Object.entries(data.byStatus).map(([key, value]) => (key + ' ' + value)).join(', ') || 'нет'}`,
        `- Риски: ${Object.entries(data.byRisk).map(([key, value]) => (key + ' ' + value)).join(', ') || 'нет'}`,
        '- По модулям:',
        bullets(modules)
      ].join('\n')
    }

    /**
     * Промпт «пусть Agent проанализирует прогресс».
     * @param options — projects (все проекты), project (необязательно, фокус на одном), today.
     */
    function buildAnalysisPrompt({ projects = [], project = null, today }) {
      const scope = project ? 'этот проект' : 'эти проекты'
      const body = project ? projectBrief(project, today) : portfolioBrief(projects, today)
      return [
        `Ты — мой помощник по продвижению проектов. Сегодня ${today}.`,
        `Сделай анализ прогресса: ${scope}. Опирайся только на зарегистрированные данные, не выдумывай фактов, которых в них нет; если информации мало — прямо скажи «данных недостаточно».`,
        '',
        'Выведи по такой структуре:',
        '1. Текущий статус: что в графике, что уже поехало — вывод в одну-две фразы.',
        '2. Риски по срокам: по каждому проекту сопоставь оставшееся время и прогресс, отметь самые вероятные срывы и обоснуй.',
        '3. Блокеры и зависимости: найди в записях о прогрессе места, где мешают люди или внешние условия.',
        '4. Следующие шаги: 3–5 конкретных выполнимых действий, по каждому — проект и желаемый срок.',
        '5. Чего мне не хватает: перечисли данные, которые нужны для выводов, но не зарегистрированы.',
        '',
        '---',
        '',
        body
      ].join('\n')
    }

    const DOC_KINDS = {
      weekly: 'Недельный отчёт',
      status: 'Отчёт о статусе проектов',
      risk: 'Список рисков',
      meeting: 'Каркас протокола встречи'
    }

    function docKinds() {
      return Object.entries(DOC_KINDS).map(([value, label]) => ({ value, label }))
    }

    /**
     * Собрать черновик документа (Markdown).
     * @param kind — weekly | status | risk | meeting.
     * @param options — projects, project (необязательно), today.
     */
    function buildDocDraft(kind, { projects = [], project = null, today }) {
      const only = project ? [project] : projects
      const label = DOC_KINDS[kind] ?? DOC_KINDS.status
      const title = project ? project.name : 'Все проекты'

      if (kind === 'risk') {
        const rows = sortByRisk(only, today).map((item) => {
          const risk = item.risk
          const todo = openTodos(item.project)
          return `| ${item.project.name} | ${item.project.module || 'Другие проекты'} | ${item.project.status || 'В работе'} | ${clampProgress(item.project)}% | ${item.project.dueDate || 'без срока'} | ${risk.label} — ${risk.detail} | ${todo.length} |`
        })
        return [
          `# Список рисков · ${title}`,
          '',
          `Сформировано: ${today}`,
          '',
          '| Проект | Модуль | Статус | Прогресс | Дедлайн | Риск | На контроле |',
          '| --- | --- | --- | --- | --- | --- | --- |',
          rows.length > 0 ? rows.join('\n') : '| (проектов нет) |  |  |  |  |  |  |',
          '',
          '## Что делать',
          bullets(sortByRisk(only, today).filter((item) => item.risk.rank <= 4)
            .map((item) => `${item.project.name}: ${item.risk.detail}. Стоит сначала назначить ответственного и назвать новый срок.`), '(сейчас нет рисков, требующих эскалации)')
        ].join('\n')
      }

      if (kind === 'weekly') {
        return [
          `# Недельный отчёт · движение проектов (${today})`,
          '',
          '## 1. Общая картина',
          portfolioNumbers(only, today),
          '',
          '## 2. Прогресс за неделю',
          portfolioBrief(only, today),
          '',
          '## 3. План на следующую неделю',
          bullets(only.flatMap((item) => openTodos(item).slice(0, 3).map((todo) =>
            `${item.name}: ${todo.title}${todo.dueDate ? (' — до ' + todo.dueDate) : ''}`)), '(список задач пуст — допишите план на неделю)'),
          '',
          '## 4. Нужна помощь',
          bullets(sortByRisk(only, today).filter((item) => ['overdue', 'blocked', 'urgent', 'slipping'].includes(item.risk.level))
            .map((item) => `${item.project.name}: ${item.risk.detail}`), '(пока нет)')
        ].join('\n')
      }

      if (kind === 'meeting') {
        return [
          `# Протокол встречи · ${title} (${today})`,
          '',
          'Участники:',
          '',
          '## 1. Текущее состояние проектов',
          portfolioBrief(only, today),
          '',
          '## 2. Обсуждение и решения',
          '- (дополнить)',
          '',
          '## 3. Действия',
          '| Что | Ответственный | Срок | Статус |',
          '| --- | --- | --- | --- |',
          bullets(only.flatMap((item) => openTodos(item).map((todo) =>
            `| ${item.name}: ${todo.title} | ${todo.owner || 'не назначен'} | ${todo.dueDate || 'не назначен'} | Не начато |`)), '| (дополнить) |  |  |  |')
        ].join('\n')
      }

      const rows = sortByRisk(only, today).map((item) => {
        const latest = latestUpdate(item.project)
        return [
          `### ${item.project.name}`,
          `- Модуль / статус: ${item.project.module || 'Другие проекты'} / ${item.project.status || 'В работе'}`,
          `- Прогресс: ${clampProgress(item.project)}%, ${formatRemaining(item.project.dueDate, today)}`,
          `- Риск по срокам: ${item.risk.label} — ${item.risk.detail}`,
          `- Последнее: ${latest ? (String(latest.at).slice(0, 10) + ' ' + latest.text) : 'записей нет'}`,
          `- Далее: ${openTodos(item.project).map((todo) => todo.title).slice(0, 3).join('; ') || 'дополнить'}`
        ].join('\n')
      })
      return [
        `# Отчёт о статусе проектов · ${title} (${today})`,
        '',
        '## Кратко',
        portfolioNumbers(only, today),
        '',
        '## По проектам',
        rows.length > 0 ? rows.join('\n\n') : '(проектов нет)'
      ].join('\n')
    }

    /** Подсказка «кому отдавать» на панели; общая для черновиков и интерфейса. */
    function deliveryHint(kind) {
      return `Черновик «${DOC_KINDS[kind] ?? 'документ'}» готов: можно скопировать в соседнюю сессию и попросить Agent дополнить, либо скачать как Markdown.`
    }

    module.exports = { projectBrief, portfolioBrief, buildAnalysisPrompt, docKinds, buildDocDraft, deliveryHint }
  }
  __factories["shared/views.js"] = function (exports, module, __require) {
    /**
     * Логика «модульного» вида панели: группировка по модулям, фильтр умных видов, поиск по ключевым словам.
     * Чистые функции; в тестах вызываются напрямую.
     */
    const { DANGER_LEVELS, WATCH_LEVELS, clampProgress, daysLeft, endOfWeek, latestUpdate, moduleNames, openTodos, projectRisk, sortByRisk, todayISO } = __require("shared/analysis.js")
    const ATTENTION_LEVELS = [...DANGER_LEVELS, ...WATCH_LEVELS]

    /** Умные виды в левой колонке. `view` — для фильтра; «Все проекты» — ось модулей, а не фильтр. */
    const SMART_VIEWS = [
      { id: 'attention', label: 'Требуют внимания', hint: 'Просроченные, заблокированные, срочные или отстающие проекты' },
      { id: 'overdue', label: 'Просрочено', hint: 'Дедлайн уже прошёл' },
      { id: 'week', label: 'Дедлайн на неделе', hint: 'Срок до конца недели' },
      { id: 'todos', label: 'Есть открытые задачи', hint: 'Есть незакрытые задачи на контроле' },
      { id: 'done', label: 'Завершён', hint: 'Сданные проекты' }
    ]

    function smartView(id) {
      return SMART_VIEWS.find((view) => view.id === id) ?? null
    }

    /** Попадает ли проект в умный вид. */
    function matchesSmartView(project, viewId, today = todayISO()) {
      const risk = projectRisk(project, today)
      if (viewId === 'attention') return ATTENTION_LEVELS.includes(risk.level)
      if (viewId === 'overdue') return risk.level === 'overdue'
      if (viewId === 'done') return (project?.status || '') === 'Завершён'
      if (viewId === 'todos') return openTodos(project).length > 0
      if (viewId === 'week') {
        const left = daysLeft(project?.dueDate, today)
        return left !== null && left >= 0 && project.dueDate <= endOfWeek(today)
      }
      return true
    }

    /** Текст проекта для поиска: название, модуль, ответственный, описание, теги и последняя запись. */
    function searchText(project) {
      const latest = latestUpdate(project)
      return [
        project?.name, project?.module, project?.owner, project?.summary, project?.status,
        ...(Array.isArray(project?.tags) ? project.tags : []),
        latest?.text,
        ...openTodos(project).map((todo) => todo.title)
      ].filter(Boolean).join(' ').toLowerCase()
    }

    /**
     * Фильтрация и сортировка по «модуль + умный вид + ключевое слово».
     * @param state — { module: 'Все'|имя модуля, view: SmartView.id|'', keyword }.
     */
    function selectProjects(projects, state = {}, today = todayISO()) {
      const module = state.module ?? 'Все'
      const view = state.view ?? ''
      const keyword = String(state.keyword ?? '').trim().toLowerCase()
      return sortByRisk(projects, today)
        .map((item) => item.project)
        .filter((project) => module === 'Все' || (project?.module || 'Другие проекты') === module)
        .filter((project) => !view || matchesSmartView(project, view, today))
        .filter((project) => !keyword || searchText(project).includes(keyword))
    }

    /** Сводка по модулю (или «Все») для заголовка группы и счётчиков в сайдбаре. */
    function summarize(projects, today = todayISO()) {
      const risks = projects.map((project) => projectRisk(project, today))
      return {
        total: projects.length,
        active: projects.filter((project) => (project?.status || 'В работе') === 'В работе').length,
        done: projects.filter((project) => (project?.status || '') === 'Завершён').length,
        danger: risks.filter((risk) => DANGER_LEVELS.includes(risk.level)).length,
        watch: risks.filter((risk) => WATCH_LEVELS.includes(risk.level)).length,
        overdue: risks.filter((risk) => risk.level === 'overdue').length,
        openTodos: projects.reduce((sum, project) => sum + openTodos(project).length, 0),
        avgProgress: projects.length === 0
          ? 0
          : Math.round(projects.reduce((sum, project) => sum + clampProgress(project), 0) / projects.length)
      }
    }

    /** Список модулей в сайдбаре: три фиксированных + встретившиеся свои, со счётчиками и рисками. */
    function railModules(projects, today = todayISO()) {
      const names = moduleNames(projects)
      return names.map((name) => {
        const items = projects.filter((project) => (project?.module || 'Другие проекты') === name)
        const stats = summarize(items, today)
        return { name, total: stats.total, danger: stats.danger + stats.watch, overdue: stats.overdue }
      })
    }

    /** Счётчики умных видов для сайдбара. */
    function railViews(projects, today = todayISO()) {
      return SMART_VIEWS.map((view) => ({
        ...view,
        total: projects.filter((project) => matchesSmartView(project, view.id, today)).length
      }))
    }

    /**
     * Группировка по модулям для секционного показа под «Все проекты».
     * Пустые модули не возвращаются; свои модули идут после фиксированных.
     */
    function groupByModule(projects, today = todayISO()) {
      return railModules(projects, today)
        .filter((entry) => entry.total > 0)
        .map((entry) => ({
          module: entry.name,
          projects: sortByRisk(projects.filter((project) => (project?.module || 'Другие проекты') === entry.name), today)
            .map((item) => item.project),
          stats: summarize(projects.filter((project) => (project?.module || 'Другие проекты') === entry.name), today)
        }))
    }

    module.exports = { ATTENTION_LEVELS, SMART_VIEWS, smartView, matchesSmartView, searchText, selectProjects, summarize, railModules, railViews, groupByModule }
  }
  __factories["shared/sample.js"] = function (exports, module, __require) {
    /**
     * Демо-проекты: типичная работа бэкенд/фулстек-инженера, по 4 на каждый модуль.
     * Покрывают просрочку, срочность, отставание, блокер, «не начат» и «завершён»; даты считаются относительно "сегодня",
     * поэтому набор корректен в любой день. У записей тег «Пример» — их легко узнать и удалить.
     */
    const { todayISO } = __require("shared/analysis.js")
    const pad = (value) => String(value).padStart(2, '0')

    /** Локальный календарный день со сдвигом на несколько дней от сегодня. */
    function shift(today, days) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(today))
      if (!match) return today
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      date.setDate(date.getDate() + days)
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    /** ISO-метка времени со сдвигом на несколько дней от сегодня. */
    function stamp(today, days) {
      return `${shift(today, days)}T09:00:00.000Z`
    }

    const update = (id, today, days, kind, text) => ({ id, at: stamp(today, days), kind, text })
    const todo = (id, title, owner, today, days, done = false) => ({
      id, title, owner, dueDate: shift(today, days), done, doneAt: done ? stamp(today, days) : ''
    })

    function make(today, spec) {
      return {
        id: spec.id,
        name: spec.name,
        module: spec.module,
        status: spec.status ?? 'В работе',
        owner: spec.owner ?? 'Я',
        dueDate: shift(today, spec.due),
        startedOn: shift(today, spec.start),
        progress: spec.progress ?? 0,
        link: spec.link ?? '',
        summary: spec.summary ?? '',
        tags: ['Пример', ...(spec.tags ?? [])],
        createdAt: stamp(today, spec.start),
        updatedAt: stamp(today, spec.last ?? -1),
        updates: spec.updates ?? [],
        todos: spec.todos ?? []
      }
    }

    /**
     * Сгенерировать демо-проекты: 4 рабочих, 4 текущих задачи, 4 других проекта.
     * @param today — локальный день YYYY-MM-DD, по умолчанию сегодня.
     */
    function buildSampleProjects(today = todayISO()) {
      const specs = [
        // ---------------------------------------------------------- Рабочие проекты
        {
          id: 'demo-company-1', name: 'Переработка сервиса расчётов', module: 'Рабочие проекты', progress: 55, start: -30, due: -2, last: -2,
          summary: 'Разложить расчёты из монолита в отдельный сервис, перерезать API по доменам, исторические данные должны сойтись.', tags: ['Бэкенд', 'Рефакторинг'],
          updates: [
            update('demo-company-1-u1', today, -12, 'progress', 'Цепочку расчётов вынесли в отдельный сервис, основная интеграция прошла'),
            update('demo-company-1-u2', today, -4, 'blocker', 'Не подтверждён легаси-формат купонов — приёмочные кейсы не дописать')
          ],
          todos: [
            todo('demo-company-1-t1', 'Дописать контрактные тесты для API расчётов', 'Я', today, -3),
            todo('demo-company-1-t2', 'Согласовать с финансами формат расчётов по историческим заказам', 'Я', today, 1)
          ]
        },
        {
          id: 'demo-company-2', name: 'Подключение домена заказов к платформе данных', module: 'Рабочие проекты', progress: 40, start: -20, due: 2, last: -1,
          summary: 'Стримить изменения заказов в платформу данных в реальном времени; сначала одна широкая таблица домена заказов.', tags: ['Данные', 'CDC'],
          updates: [update('demo-company-2-u1', today, -5, 'progress', 'Маппинг полей домена заказов согласован, CDC-пайплайн локально работает')],
          todos: [todo('demo-company-2-t1', 'Интеграция инкрементальной синхронизации домена заказов, проверка задержки в 24 часа', 'Я', today, 2)]
        },
        {
          id: 'demo-company-3', name: 'Ускорение первого экрана мобильного клиента', module: 'Рабочие проекты', progress: 20, start: -25, due: 8, last: -6,
          summary: 'Первый экран с 1.8 с до 1 с: разбить бандл, картинки по требованию, параллельные запросы.', tags: ['Фронтенд', 'Производительность'],
          updates: [update('demo-company-3-u1', today, -6, 'note', 'Замеры первого экрана готовы: виноваты большой основной бандл и последовательные запросы')],
          todos: [todo('demo-company-3-t1', 'Разбить JS первого экрана, убрать неиспользуемые зависимости', 'Я', today, 3)]
        },
        {
          id: 'demo-company-4', name: 'Запуск платформы канареечных релизов', module: 'Рабочие проекты', status: 'Завершён', progress: 100, start: -45, due: -12, last: -12,
          summary: 'Платформа релизов с канарейкой по пользователям, подключены все ключевые сервисы.', tags: ['Платформа', 'CI/CD'],
          updates: [update('demo-company-4-u1', today, -12, 'decision', 'Полный релиз выполнен, план отката и регламент дежурств заархивированы')],
          todos: []
        },

        // ---------------------------------------------------------- Текущие задачи
        {
          id: 'demo-daily-1', name: 'Подготовка доклада «Разбор инцидентов на проде»', module: 'Текущие задачи', progress: 45, start: -8, due: 2, last: -1,
          summary: 'Внутренний доклад в следующий четверг: три реальных кейса о том, как искать причину — от флеймграфов до логов трассировки.', tags: ['Доклад', 'Наблюдаемость'],
          updates: [update('demo-daily-1-u1', today, -1, 'progress', 'План и два кейса готовы, остался разбор утечки памяти')],
          todos: [
            todo('demo-daily-1-t1', 'Добавить флеймграф и выводы по третьему кейсу', 'Я', today, 0),
            todo('demo-daily-1-t2', 'Прогнать доклад на коллегах, уложиться в 40 минут', 'Я', today, 1)
          ]
        },
        {
          id: 'demo-daily-2', name: 'Квартальный техотчёт Q3', module: 'Текущие задачи', progress: 35, start: -14, due: 9, last: -3,
          summary: 'Доложить руководителю итоги квартала: стабильность, производительность, эффективность и планы на следующий квартал.', tags: ['Отчёт', 'OKR'],
          updates: [update('demo-daily-2-u1', today, -3, 'progress', 'Метрики стабильности и производительности собраны, ждём данные по эффективности')],
          todos: [todo('demo-daily-2-t1', 'Добавить сравнение производительности до и после с графиками', 'Я', today, 5)]
        },
        {
          id: 'demo-daily-3', name: 'Дежурство по алертам и разбор инцидентов', module: 'Текущие задачи', progress: 70, start: -9, due: -3, last: -3,
          summary: 'Дежурство на неделе: разобрать P2-алерты, написать постмортемы, занести выводы в регламент.', tags: ['Дежурство', 'Стабильность'],
          updates: [update('demo-daily-3-u1', today, -3, 'note', 'Черновики постмортемов по двум P2 готовы, ждём подтверждения корневой причины от владельца')],
          todos: [todo('demo-daily-3-t1', 'Перенести выводы в регламент дежурств и в правила мониторинга', 'Я', today, -2)]
        },
        {
          id: 'demo-daily-4', name: 'Обновление зависимостей и разбор техдолга', module: 'Текущие задачи', progress: 15, start: -10, due: 5, last: -2,
          summary: 'Поднять несколько опасных зависимостей до безопасных версий и заодно убрать слой совместимости, оставшийся с прошлых итераций.', tags: ['Техдолг', 'Зависимости'],
          updates: [update('demo-daily-4-u1', today, -2, 'note', 'Найдено 3 опасные зависимости и 1 устаревший слой совместимости; ветка для обновления создана')],
          todos: [todo('demo-daily-4-t1', 'Обновить и прогнать полную регрессию', 'Я', today, -1)]
        },

        // ---------------------------------------------------------- Другие проекты
        {
          id: 'demo-other-1', name: 'Свой мини-инструмент мониторинга', module: 'Другие проекты', status: 'Блокер', progress: 15, start: -8, due: 20, last: -2,
          summary: 'Свой маленький инструмент: следить за P99 API и медленными SQL, при аномалиях — пуш в мессенджер.', tags: ['Инструмент', 'Наблюдаемость'],
          updates: [update('demo-other-1-u1', today, -2, 'blocker', 'Ждём от эксплуатации доступ на чтение к агенту сбора, локально пока только на фейковых данных')],
          todos: [todo('demo-other-1-t1', 'Согласовать с эксплуатацией объём прав и аккаунт', 'Эксплуатация', today, 2)]
        },
        {
          id: 'demo-other-2', name: 'Ведение issue и PR в open-source', module: 'Другие проекты', progress: 50, start: -8, due: 3, last: -1,
          summary: 'Поддерживать свою небольшую открытую библиотеку: отвечать на issue, ревьюить PR, выпустить минорную версию.', tags: ['Open-source', 'Сообщество'],
          updates: [update('demo-other-2-u1', today, -1, 'progress', 'Смёржено два PR из сообщества, CI зелёный')],
          todos: [todo('demo-other-2-t1', 'Ответить на оставшиеся 6 issue и проставить метки', 'Я', today, 2)]
        },
        {
          id: 'demo-other-3', name: 'Заметки и блог', module: 'Другие проекты', progress: 25, start: -5, due: 14, last: -4,
          summary: 'Собрать разрозненные заметки по разборам и чтению кода в блог с поиском.', tags: ['Обучение', 'Тексты'],
          updates: [update('demo-other-3-u1', today, -4, 'note', 'Разложил по 6 темам: конкурентность, хранилища, сеть, JVM, исходники фреймворков, разборы')],
          todos: [todo('demo-other-3-t1', 'Дописать раздел «распределённые транзакции» и нарисовать схему', 'Я', today, 7)]
        },
        {
          id: 'demo-other-4', name: 'Прототип мини-приложения', module: 'Другие проекты', status: 'Не начат', progress: 0, start: 0, due: 25, last: 0,
          summary: 'За две недели собрать минимальный рабочий цикл и понять, стоит ли идея продолжения.', tags: ['Пет-проект', 'Прототип'],
          updates: [],
          todos: [todo('demo-other-4-t1', 'Написать страницу с целью проверки и выбором технологий', 'Я', today, 3)]
        }
      ]
      return specs.map((spec) => make(today, spec))
    }

    /** Подсказка при генерации демо-данных. */
    function sampleSummary(projects) {
      const byModule = {}
      for (const project of projects) byModule[project.module] = (byModule[project.module] ?? 0) + 1
      const detail = Object.entries(byModule).map(([name, count]) => `${name}: ${count}`).join(', ')
      return `демо-проектов: ${projects.length} (${detail})`
    }

    module.exports = { buildSampleProjects, sampleSummary }
  }
  __factories["shared/aiplan.js"] = function (exports, module, __require) {
    /**
     * AI-заполнение: превращает команду на естественном языке в «план изменений», сначала показывает его пользователю, потом пишет одним разом.
     *
     * Этот слой — чистые функции: модель только выдаёт JSON-план, а **проверка, сопоставление, предпросмотр, применение** делаются здесь,
     * поэтому ошибка модели не меняет данные; если модель недоступна — локальный разбор правилами.
     */
    const { MODULES, STATUSES, clampProgress, todayISO } = __require("shared/analysis.js")
    const { answerQuestion } = __require("shared/query.js")
    const AI_INTENTS = ['add', 'update', 'delete', 'todo', 'log', 'query']
    const AI_OPS = ['add', 'update', 'delete', 'addTodo', 'doneTodo', 'addLog']
    const LOG_KINDS = ['note', 'progress', 'blocker', 'decision']
    const EDITABLE = ['name', 'module', 'status', 'owner', 'dueDate', 'startedOn', 'progress', 'summary', 'link']
    const FIELD_LABELS = {
      name: 'Название', module: 'Модуль', status: 'Статус', owner: 'Ответственный', dueDate: 'Дедлайн', startedOn: 'Начало',
      progress: 'Прогресс', summary: 'Описание', link: 'Ссылка'
    }
    const KIND_LABELS = { note: 'Запись', progress: 'Прогресс', blocker: 'Блокер', decision: 'Решение' }

    const pad = (value) => String(value).padStart(2, '0')
    const dayOf = (value) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim())
      if (!match) return null
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      return Number.isNaN(date.getTime()) ? null : date
    }
    const iso = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    const shift = (today, days) => {
      const date = dayOf(today) ?? new Date()
      date.setDate(date.getDate() + days)
      return iso(date)
    }

    /** Разбирает дату из текста модели или пользователя в YYYY-MM-DD; если не вышло — пустая строка. */
    function resolveDate(value, today = todayISO()) {
      const raw = String(value ?? '').trim()
      if (raw === '') return ''
      const absolute = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw)
      if (absolute) return `${absolute[1]}-${pad(absolute[2])}-${pad(absolute[3])}`
      const MONTHS = { янв: 1, фев: 2, мар: 3, апр: 4, май: 5, мая: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12 }
      const monthWord = /(\d{1,2})\s*(?:-?(?:го|е))?\s+(янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)[а-яё]*/i.exec(raw)
      if (monthWord) {
        const year = Number(today.slice(0, 4))
        return `${year}-${pad(MONTHS[monthWord[2].toLowerCase()])}-${pad(monthWord[1])}`
      }
      const dayMonth = /(?:^|\s)(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?:\s|$)/.exec(raw)
      if (dayMonth) {
        const year = dayMonth[3] ? Number(dayMonth[3].length === 2 ? '20' + dayMonth[3] : dayMonth[3]) : Number(today.slice(0, 4))
        return `${year}-${pad(dayMonth[2])}-${pad(dayMonth[1])}`
      }
      if (/сегодня|нынче/i.test(raw)) return today
      if (/послезавтра/i.test(raw)) return shift(today, 2)
      if (/завтра/i.test(raw)) return shift(today, 1)
      const longWeekday = /(следующ[а-яё]*|ближайш[а-яё]*|эту|этот)?\s*(воскресень[а-яё]*|понедельник[а-яё]*|вторник[а-яё]*|сред[ауы]|четверг[а-яё]*|пятниц[ауы]|суббот[ауы])/i.exec(raw)
      const shortWeekday = longWeekday ? null : /(?:^|[\s,;.(])(пн|вт|ср|чт|пт|сб|вс)(?=$|[\s,;.)])/i.exec(raw)
      const weekday = longWeekday
        ? { modifier: longWeekday[1], day: longWeekday[2] }
        : shortWeekday ? { modifier: '', day: shortWeekday[1] } : null
      if (weekday) {
        const base = dayOf(today) ?? new Date()
        const key = weekday.day.toLowerCase()
        const map = {
          понедельник: 1, вторник: 2, среда: 3, среду: 3, среды: 3, четверг: 4,
          пятница: 5, пятницу: 5, пятницы: 5, суббота: 6, субботу: 6, субботы: 6,
          воскресенье: 7, воскресенья: 7, пн: 1, вт: 2, ср: 3, чт: 4, пт: 5, сб: 6, вс: 7
        }
        const target = map[key]
        if (!target) return ''
        const current = base.getDay() === 0 ? 7 : base.getDay()
        let delta = target - current
        if (weekday.modifier && /следующ|ближайш/i.test(weekday.modifier)) delta += 7
        else if (delta < 0) delta += 7
        return shift(today, delta)
      }
      if (/конец месяца|конце месяца|концу месяца/i.test(raw)) {
        const date = dayOf(today) ?? new Date()
        return iso(new Date(date.getFullYear(), date.getMonth() + 1, 0))
      }
      if (/следующ[а-яё]* месяц|через месяц/i.test(raw)) {
        const date = dayOf(today) ?? new Date()
        return iso(new Date(date.getFullYear(), date.getMonth() + 1, 1))
      }
      const plusDays = /\+?\s*(\d+)\s*(?:дн|день|дня|дней)/i.exec(raw)
      if (plusDays) return shift(today, Number(plusDays[1]))
      const plusWeeks = /\+?\s*(\d+)\s*(?:нед|неделю|недели|недель)/i.exec(raw)
      if (plusWeeks) return shift(today, Number(plusWeeks[1]) * 7)
      return ''
    }

    const normalizeName = (value) => String(value ?? '').replace(/[\s«»"'()\[\],.;:!?—–]/g, '').toLowerCase()

    /** Найти проект по id → точному имени → вхождению; при неоднозначности или отсутствии возвращает причину. */
    function matchProject(target, projects) {
      const raw = String(target ?? '').trim()
      if (raw === '') return { reason: 'Не указано, о каком проекте речь' }
      const list = Array.isArray(projects) ? projects : []
      const byId = list.find((project) => project.id === raw)
      if (byId) return { project: byId }
      const wanted = normalizeName(raw)
      const exact = list.filter((project) => normalizeName(project.name) === wanted)
      if (exact.length === 1) return { project: exact[0] }
      if (exact.length > 1) return { reason: `«${raw}» — несколько проектов, уточните название` }
      const partial = list.filter((project) => normalizeName(project.name).includes(wanted) || wanted.includes(normalizeName(project.name)))
      if (partial.length === 1) return { project: partial[0] }
      if (partial.length > 1) return { reason: `«${raw}» совпадает с несколькими проектами (${partial.slice(0, 3).map((p) => p.name).join(', ')}), уточните название` }
      return { reason: `Проект «${raw}» не найден` }
    }

    function cleanTags(value) {
      if (!Array.isArray(value)) return []
      return value.map((tag) => String(tag ?? '').trim()).filter(Boolean).slice(0, 8)
    }

    function cleanProgress(value) {
      const number = typeof value === 'number' ? value : Number(String(value ?? '').replace('%', '').trim())
      if (!Number.isFinite(number)) return null
      return clampProgress({ progress: number })
    }

    function normalizeAdd(raw, today, issues) {
      const name = String(raw?.name ?? raw?.title ?? '').trim()
      if (!name) {
        issues.push('В добавлении нет названия проекта — пропущено')
        return null
      }
      const status = STATUSES.includes(raw?.status) ? raw.status : 'В работе'
      const progress = cleanProgress(raw?.progress)
      return {
        op: 'add',
        project: {
          name,
          module: String(raw?.module ?? '').trim() || 'Другие проекты',
          status,
          owner: String(raw?.owner ?? '').trim(),
          startedOn: resolveDate(raw?.startedOn, today),
          dueDate: resolveDate(raw?.dueDate, today),
          progress: progress === null ? 0 : progress,
          summary: String(raw?.summary ?? '').trim(),
          link: String(raw?.link ?? '').trim(),
          tags: cleanTags(raw?.tags)
        }
      }
    }

    function normalizeUpdate(raw, projects, today, issues) {
      const found = matchProject(raw?.target ?? raw?.name, projects)
      if (!found.project) {
        issues.push(`${found.reason} — изменение пропущено`)
        return null
      }
      const source = raw?.changes && typeof raw.changes === 'object' ? raw.changes : raw
      const changes = {}
      for (const key of EDITABLE) {
        if (source?.[key] === undefined || source?.[key] === null || source?.[key] === '') continue
        if (key === 'progress') {
          const progress = cleanProgress(source[key])
          if (progress === null) { issues.push(`Значение прогресса не распознано — пропущено`); continue }
          changes.progress = progress
          continue
        }
        if (key === 'status') {
          if (!STATUSES.includes(source[key])) { issues.push(`Статус «${source[key]}» вне допустимых — пропущено`); continue }
          changes.status = source[key]
          continue
        }
        if (key === 'dueDate' || key === 'startedOn') {
          const date = resolveDate(source[key], today)
          if (!date) { issues.push(`Дата «${source[key]}» не распознана — пропущено`); continue }
          changes[key] = date
          continue
        }
        changes[key] = String(source[key]).trim()
      }
      if (Object.keys(changes).length === 0) {
        issues.push(`Не понято, что менять в «${found.project.name}» — пропущено`)
        return null
      }
      return { op: 'update', projectId: found.project.id, name: found.project.name, changes }
    }

    function normalizeSimple(op, raw, projects, today, issues) {
      const found = matchProject(raw?.target ?? raw?.project ?? raw?.name, projects)
      if (!found.project) {
        issues.push(`${found.reason} — ${op === 'delete' ? 'удаление' : op === 'addTodo' ? 'новая задача' : op === 'doneTodo' ? 'закрытие задачи' : 'запись'} пропущено`)
        return null
      }
      const project = found.project
      if (op === 'delete') return { op, projectId: project.id, name: project.name }
      if (op === 'addTodo') {
        const title = String(raw?.title ?? raw?.todo ?? raw?.text ?? '').trim()
        if (!title) { issues.push('В задаче нет текста — пропущено'); return null }
        return { op, projectId: project.id, name: project.name, title, owner: String(raw?.owner ?? '').trim(), dueDate: resolveDate(raw?.dueDate, today) }
      }
      if (op === 'doneTodo') {
        const wanted = normalizeName(raw?.title ?? raw?.todo ?? raw?.text ?? '')
        const open = (project.todos ?? []).filter((todo) => todo.done !== true)
        let todo = null
        if (wanted) todo = open.find((item) => normalizeName(item.title).includes(wanted)) ?? null
        else if (open.length === 1) todo = open[0]
        if (!todo) { issues.push(`В «${project.name}» не найдена задача для закрытия — пропущено`); return null }
        return { op, projectId: project.id, name: project.name, todoId: todo.id, title: todo.title }
      }
      const text = String(raw?.text ?? raw?.content ?? raw?.summary ?? '').trim()
      if (!text) { issues.push('Пустая запись о прогрессе — пропущено'); return null }
      const kind = LOG_KINDS.includes(raw?.kind) ? raw.kind : 'note'
      return { op, projectId: project.id, name: project.name, kind, text }
    }

    /**
     * Проверить и нормализовать сырой план, полученный от модели.
     * @returns { intent, reply, actions, issues }
     */
    function normalizePlan(raw, projects, today = todayISO()) {
      const issues = []
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { intent: 'query', reply: '', actions: [], issues: ['Модель не вернула пригодный план'] }
      }
      const actions = []
      for (const action of Array.isArray(raw.actions) ? raw.actions.slice(0, 20) : []) {
        const op = String(action?.op ?? '').trim()
        if (!AI_OPS.includes(op)) {
          if (op) issues.push(`Неизвестное действие «${op}» — пропущено`)
          continue
        }
        const normalized = op === 'add' ? normalizeAdd(action, today, issues)
          : op === 'update' ? normalizeUpdate(action, projects, today, issues)
            : normalizeSimple(op, action, projects, today, issues)
        if (normalized) actions.push(normalized)
      }
      const intent = AI_INTENTS.includes(raw.intent) ? raw.intent : ''
      const inferred = actions.length === 0
        ? (intent || 'query')
        : actions.some((action) => action.op === 'add') ? 'add'
          : actions.some((action) => action.op === 'delete') ? 'delete'
            : actions.some((action) => action.op === 'update') ? 'update'
              : actions.some((action) => action.op === 'addTodo' || action.op === 'doneTodo') ? 'todo' : 'log'
      return {
        intent: intent && actions.length > 0 && intent !== 'query' ? intent : inferred,
        reply: String(raw.reply ?? '').trim(),
        actions,
        issues
      }
    }

    /** Перед применением на клиенте сверить ещё раз: за время разбора проекты могли измениться. */
    function revalidatePlan(plan, projects) {
      const ids = new Set((Array.isArray(projects) ? projects : []).map((project) => project.id))
      const actions = []
      const issues = [...(plan?.issues ?? [])]
      let dropped = 0
      for (const action of plan?.actions ?? []) {
        if (action.op === 'add' || ids.has(action.projectId)) actions.push(action)
        else dropped += 1
      }
      if (dropped > 0) issues.push(`пропущено из-за изменений в проектах: ${dropped}`)
      return { ...plan, actions, issues }
    }

    /** Читаемый предпросмотр изменений: окно подтверждения рисуется именно по нему. */
    function previewPlan(plan, projects = [], today = todayISO()) {
      const find = (id) => projects.find((project) => project.id === id)
      const groups = []
      const push = (key, title, lines) => { if (lines.length > 0) groups.push({ key, title, lines }) }

      push('add', 'Новый проект', (plan.actions ?? []).filter((action) => action.op === 'add').map((action) => {
        const project = action.project
        const bits = [project.module, project.status, project.dueDate ? `DDL ${project.dueDate}` : 'Без срока']
        if (project.owner) bits.push(project.owner)
        return `«${project.name}» (${bits.join(' · ')})${project.summary ? ' — ' + project.summary : ''}`
      }))

      push('update', 'Изменение проекта', (plan.actions ?? []).filter((action) => action.op === 'update').map((action) => {
        const project = find(action.projectId)
        const changes = Object.entries(action.changes).map(([key, value]) => {
          const before = key === 'progress' ? `${clampProgress(project ?? {})}%` : String(project?.[key] ?? 'пусто') || 'пусто'
          const after = key === 'progress' ? `${value}%` : String(value)
          return `${FIELD_LABELS[key] ?? key} ${before} → ${after}`
        })
        return `«${action.name}»: ${changes.join('; ')}`
      }))

      push('delete', 'Удалить проект', (plan.actions ?? []).filter((action) => action.op === 'delete').map((action) => {
        const project = find(action.projectId)
        return `«${action.name}»${project ? ' (' + (project.module || 'Другие проекты') + ' · ' + (project.status || 'В работе') + ' · ' + clampProgress(project) + '%)' : ''}`
      }))

      push('todo', 'На контроле', (plan.actions ?? []).filter((action) => action.op === 'addTodo' || action.op === 'doneTodo').map((action) => (action.op === 'addTodo'
        ? `В «${action.name}» добавлено: ${action.title}${action.dueDate ? ' (срок ' + action.dueDate + ')' : ''}`
        : `Задача «${action.title}» в «${action.name}» закрыта`)))

      push('log', 'Запись о прогрессе', (plan.actions ?? []).filter((action) => action.op === 'addLog').map((action) =>
        `Дописано в «${action.name}» (${KIND_LABELS[action.kind] ?? 'запись'}): ${action.text}`))

      const total = (plan.actions ?? []).length
      return { groups, total, issues: plan.issues ?? [] }
    }

    /** Короткая сводка изменений предпросмотра — для сообщения после выполнения. */
    function planSummary(plan) {
      const count = (op) => (plan.actions ?? []).filter((action) => action.op === op).length
      const parts = []
      if (count('add')) parts.push(`добавлено: ${count('add')}`)
      if (count('update')) parts.push(`изменено: ${count('update')}`)
      if (count('delete')) parts.push(`удалено: ${count('delete')}`)
      const todos = count('addTodo') + count('doneTodo')
      if (todos) parts.push(`задач: ${todos}`)
      if (count('addLog')) parts.push(`записей: ${count('addLog')}`)
      return parts.join(', ') || 'Изменений нет'
    }

    /**
     * Применить план к состоянию и вернуть новое состояние. Одна запись, при сбое не остаётся половины.
     * @param makeId — функция генерации id; в тестах можно подставить фиксированное значение.
     */
    function applyPlan(state, plan, today = todayISO(), makeId = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`) {
      let projects = Array.isArray(state?.projects) ? [...state.projects] : []
      let applied = 0
      const now = new Date().toISOString()
      const touch = (project) => ({ ...project, updatedAt: now })

      for (const action of plan?.actions ?? []) {
        if (action.op === 'add') {
          projects = [{
            id: makeId('proj'),
            name: action.project.name,
            module: action.project.module,
            status: action.project.status,
            owner: action.project.owner,
            dueDate: action.project.dueDate,
            startedOn: action.project.startedOn,
            progress: action.project.progress,
            link: action.project.link,
            summary: action.project.summary,
            tags: action.project.tags,
            createdAt: now,
            updatedAt: now,
            updates: [],
            todos: []
          }, ...projects]
          applied += 1
          continue
        }
        const index = projects.findIndex((project) => project.id === action.projectId)
        if (index < 0) continue
        const project = projects[index]
        if (action.op === 'update') {
          projects[index] = touch({ ...project, ...action.changes })
        } else if (action.op === 'delete') {
          projects = projects.filter((item) => item.id !== action.projectId)
        } else if (action.op === 'addTodo') {
          projects[index] = touch({
            ...project,
            todos: [...(project.todos ?? []), {
              id: makeId('todo'), title: action.title, owner: action.owner, dueDate: action.dueDate, done: false, doneAt: ''
            }]
          })
        } else if (action.op === 'doneTodo') {
          projects[index] = touch({
            ...project,
            todos: (project.todos ?? []).map((todo) => (todo.id === action.todoId
              ? { ...todo, done: true, doneAt: now }
              : todo))
          })
        } else if (action.op === 'addLog') {
          projects[index] = touch({
            ...project,
            updates: [...(project.updates ?? []), { id: makeId('upd'), at: now, kind: action.kind, text: action.text }]
          })
        }
        applied += 1
      }
      return { next: { ...state, projects }, applied }
    }

    /* --------------------------------------------------------- Локальные правила (фолбэк) */

    const has = (text, pattern) => pattern.test(text)

    function pickProjectName(instruction, projects) {
      const normalized = normalizeName(instruction)
      const candidates = (projects ?? [])
        .map((project) => ({ project, key: normalizeName(project.name) }))
        .filter((item) => item.key.length >= 2 && normalized.includes(item.key))
        .sort((a, b) => b.key.length - a.key.length)
      return candidates[0]?.project ?? null
    }

    function detectStatus(text) {
      if (/заверш|закончен|готово|сдал|сдано/i.test(text)) return 'Завершён'
      if (/блок|застр|застрял|стопор/i.test(text)) return 'Блокер'
      if (/пауз|приостанов|замороз/i.test(text)) return 'На паузе'
      if (/не начат|не начинали|ещё не|еще не|не стартовал/i.test(text)) return 'Не начат'
      if (/в работе|делаю|работаю|в процессе|взял в работу/i.test(text)) return 'В работе'
      return ''
    }

    /**
     * Разбор правилами без модели: распознаёт частые формулировки, структура плана та же, что у модели.
     * Используется как фолбэк, когда модель недоступна; интерфейс помечает источник.
     */
    function planFromRules(instruction, projects = [], today = todayISO()) {
      const text = String(instruction ?? '').trim()
      const issues = []
      if (!text) return { intent: 'query', reply: 'Скажите, что сделать, например: «перенеси дедлайн проекта «Переработка сервиса расчётов» на следующую пятницу».', actions: [], issues }

      if (has(text, /^(что|какие|как|где|когда|сколько|кто|покажи|список|обзор|расскажи)(?=\s|$)/i) || /[?]\s*$/.test(text)) {
        return { intent: 'query', reply: answerQuestion(text, projects, today).text, actions: [], issues }
      }

      const target = pickProjectName(text, projects)

      if (has(text, /удали|удалить|убери|убрать|снеси|удаление/i)) {
        if (!target) {
          issues.push('Не понял, какой проект удалить — назовите его точнее')
          return { intent: 'delete', reply: '', actions: [], issues }
        }
        return { intent: 'delete', reply: `Удалить «${target.name}»`, actions: [{ op: 'delete', projectId: target.id, name: target.name }], issues }
      }

      if (has(text, /задач|напомни|напоминание|на контроль/i)) {
        if (!target) {
          issues.push('Не понял, к какому проекту задача — назовите проект')
          return { intent: 'todo', reply: '', actions: [], issues }
        }
        const marker = /задачу|задача|задачи|напомни|напоминание|на контроль/i.exec(text)
        const rest = marker ? text.slice(marker.index + marker[0].length) : ''
        const cleaned = rest.replace(/^[\s:,.;—–-]+/, '').replace(/[.;\s]+$/, '').trim()
        if (!cleaned) {
          issues.push('Не указан текст задачи')
          return { intent: 'todo', reply: '', actions: [], issues }
        }
        return {
          intent: 'todo',
          reply: `Добавить задачу в «${target.name}»`,
          actions: [{ op: 'addTodo', projectId: target.id, name: target.name, title: cleaned, owner: '', dueDate: resolveDate(text, today) }],
          issues
        }
      }

      if (has(text, /закрой|закрыть|закрыта|выполнено|выполнил|готово|сделано/i) && target) {
        const open = (target.todos ?? []).filter((todo) => todo.done !== true)
        if (open.length === 1) {
          return { intent: 'todo', reply: `Закрыть задачу в «${target.name}»`, actions: [{ op: 'doneTodo', projectId: target.id, name: target.name, todoId: open[0].id, title: open[0].title }], issues }
        }
        if (open.length === 0) issues.push(`В «${target.name}» нет открытых задач`)
        else issues.push(`В «${target.name}» открытых задач: ${open.length} — уточните, какая`)
        return { intent: 'todo', reply: '', actions: [], issues }
      }

      if (has(text, /запись|запиши|допиши|отметь|зафиксируй/i)) {
        if (!target) {
          issues.push('Не понял, о каком проекте речь — назовите проект')
          return { intent: 'log', reply: '', actions: [], issues }
        }
        const marker = /запись|запиши|допиши|отметь|зафиксируй/i.exec(text)
        const body = marker ? text.slice(marker.index + marker[0].length) : ''
        const cleaned = body.replace(/^[\s:,.;—–-]+/, '').replace(/[.;\s]+$/, '').trim()
        if (!cleaned) {
          issues.push('Не указано, что записать')
          return { intent: 'log', reply: '', actions: [], issues }
        }
        const kind = /блок|застр/i.test(cleaned) ? 'blocker' : /решил|решение|договорил/i.test(cleaned) ? 'decision' : /готово|сделал|закончил/i.test(cleaned) ? 'progress' : 'note'
        return { intent: 'log', reply: `Дописать запись в «${target.name}»`, actions: [{ op: 'addLog', projectId: target.id, name: target.name, kind, text: cleaned }], issues }
      }

      const progress = /(\d{1,3})\s*%/.exec(text)
      const status = detectStatus(text)
      const dueDate = has(text, /дедлайн|срок|ddl|deadline|перенеси|сдвинь|продли|отложи|до\s+[а-яё]/i) || /\d{1,2}\s*(?:янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)/i.test(text)
        ? resolveDate(text, today)
        : ''
      const owner = /ответственн[а-яё]*\s*[:—-]?\s*([^\s,;.]{1,20})/i.exec(text)?.[1] ?? ''

      if (target && (progress || status || dueDate || owner)) {
        const changes = {}
        if (progress) changes.progress = clampProgress({ progress: Number(progress[1]) })
        if (status) changes.status = status
        if (dueDate) changes.dueDate = dueDate
        if (owner) changes.owner = owner
        return { intent: 'update', reply: `Изменить «${target.name}»`, actions: [{ op: 'update', projectId: target.id, name: target.name, changes }], issues }
      }

      if (has(text, /добавь|добавить|новый проект|создай|создать|заведи|записать/i)) {
        const module = MODULES.find((name) => text.includes(name)) ?? 'Другие проекты'
        const name = text
          .replace(/^(добавь|добавить|создай|создать|заведи|записать|новый проект|проект)?\s*/i, '')
          .replace(/^(проект|задачу)?\s*:?\s*/i, '')
          .split(/[,;.(]/)[0]
          .replace(new RegExp(module, 'g'), '')
          .replace(/в\s+«?\s*$/, '')
          .replace(/^(в|на)\s+/i, '')
          .trim()
        if (!name) {
          issues.push('Не распознано название проекта')
          return { intent: 'add', reply: '', actions: [], issues }
        }
        return {
          intent: 'add',
          reply: `Новый проект «${name}»`,
          actions: [{
            op: 'add',
            project: {
              name, module, status: status || 'В работе', owner,
              startedOn: today, dueDate, progress: progress ? clampProgress({ progress: Number(progress[1]) }) : 0,
              summary: '', link: '', tags: []
            }
          }],
          issues
        }
      }

      issues.push('Не понял фразу. Можно так: «добавь проект X», «перенеси дедлайн X на следующую пятницу», «удали X», «добавь задачу в X: Y» — или спросите «что сдаём на этой неделе».')
      return { intent: 'query', reply: answerQuestion(text, projects, today).text, actions: [], issues }
    }

    /** Описание JSON-контракта для модели (используется и в подсказке о возможностях). */
    function planSchemaDoc(today = todayISO()) {
      return [
        `Сегодня ${today}. Переведи команду пользователя в один JSON-объект; никаких пояснений и текста вне блока Markdown.`,
        'JSON-структура: { "intent": "add|update|delete|todo|log|query", "reply": "одна фраза для пользователя", "actions": [...] }',
        'Каждый элемент actions — один из вариантов:',
        '- Новый проект: { "op":"add", "name":"название", "module":"Рабочие проекты|Текущие задачи|Другие проекты", "status":"В работе|Не начат|Блокер|На паузе|Завершён", "owner":"", "startedOn":"YYYY-MM-DD", "dueDate":"YYYY-MM-DD", "progress":0, "summary":"одна фраза", "tags":["тег"] }',
        '- Изменение проекта: { "op":"update", "target":"название или id", "changes":{ только изменяемые поля, имена те же } }',
        '- Удаление проекта: { "op":"delete", "target":"название или id" }',
        '- Новая задача: { "op":"addTodo", "target":"название или id", "title":"задача", "dueDate":"YYYY-MM-DD", "owner":"" }',
        '- Закрыть задачу: { "op":"doneTodo", "target":"название или id", "title":"ключевые слова задачи" }',
        '- Дописать запись: { "op":"addLog", "target":"название или id", "kind":"note|progress|blocker|decision", "text":"текст" }',
        'Правила: ссылайся только на реальные названия или id из списка выше; если это только вопрос — intent "query", actions пустой, ответ в reply;',
        'Даты всегда в формате YYYY-MM-DD; не выдумывай неизвестные поля — лучше меньше actions.'
      ].join('\n')
    }

    /** Снимок проектов для модели (с ограничением длины, чтобы не раздувать контекст). */
    function projectSnapshot(projects, today = todayISO(), limit = 40) {
      return (Array.isArray(projects) ? projects : []).slice(0, limit).map((project) => ({
        id: project.id,
        name: project.name,
        module: project.module || 'Другие проекты',
        status: project.status || 'В работе',
        owner: project.owner || '',
        dueDate: project.dueDate || '',
        progress: clampProgress(project),
        todo: (project.todos ?? []).filter((todo) => todo.done !== true).slice(0, 8).map((todo) => ({ title: todo.title, dueDate: todo.dueDate || '' })),
        lastUpdate: (project.updates ?? []).slice(-2).map((item) => item.text)
      }))
    }

    module.exports = { AI_INTENTS, AI_OPS, resolveDate, matchProject, normalizePlan, revalidatePlan, previewPlan, planSummary, applyPlan, planFromRules, planSchemaDoc, projectSnapshot }
  }
  __factories["shared/insights.js"] = function (exports, module, __require) {
    /**
     * Слой данных доски: раскладывает проекты в модели разных «разрезов».
     * Чистые функции без DOM; вызываются и серверными, и клиентскими тестами.
     *
     * Разрезы: распределение рисков / колонки статусов (доска) / нагрузка модулей / распределение прогресса / нагрузка ответственных /
     *       календарь (по дням) / таймлайн (по интервалам) / задачи (по срочности срока).
     */
    const { DANGER_LEVELS, WATCH_LEVELS, RISK_META, STATUSES, clampProgress, dayStart, daysLeft, endOfWeek, moduleNames, openTodos, projectRisk, sortByRisk, todayISO } = __require("shared/analysis.js")
    const { summarize } = __require("shared/views.js")
    const MODULE_ACCENTS = ['indigo', 'teal', 'amber', 'violet', 'rose', 'cyan']

    const STATUS_TONE = { 'В работе': 'info', 'Не начат': 'muted', 'Блокер': 'danger', 'На паузе': 'warn', 'Завершён': 'ok' }

    /** У каждого модуля свой постоянный акцентный цвет (порядок стабилен, при обновлении не меняется). */
    function moduleAccentMap(projects) {
      const map = {}
      moduleNames(projects).forEach((name, index) => {
        map[name] = MODULE_ACCENTS[index % MODULE_ACCENTS.length]
      })
      return map
    }

    function statusTone(status) {
      return STATUS_TONE[status] ?? 'muted'
    }

    /** Все числа для верхних KPI, посчитанные за один проход. */
    function kpis(projects, today = todayISO()) {
      const stats = summarize(projects, today)
      const risks = projects.map((project) => projectRisk(project, today))
      const count = (level) => risks.filter((risk) => risk.level === level).length
      const open = projects.reduce((sum, project) => sum + openTodos(project).length, 0)
      const todoOverdue = projects.reduce((sum, project) => sum
        + openTodos(project).filter((todo) => (daysLeft(todo.dueDate, today) ?? 1) < 0).length, 0)
      const weekDue = projects.filter((project) => {
        const left = daysLeft(project.dueDate, today)
        return left !== null && left >= 0 && project.dueDate <= endOfWeek(today)
      }).length
      return {
        total: stats.total,
        active: stats.active,
        done: stats.done,
        avgProgress: stats.avgProgress,
        openTodos: open,
        todoOverdue,
        weekDue,
        attention: stats.danger + stats.watch,
        danger: stats.danger,
        watch: stats.watch,
        overdue: count('overdue'),
        blocked: count('blocked'),
        urgent: count('urgent'),
        slipping: count('slipping'),
        soon: count('soon'),
        normal: count('normal'),
        unscheduled: count('unscheduled')
      }
    }

    /** Распределение рисков (для пирога/кольца): от высокого к низкому, только непустые уровни. */
    function riskBreakdown(projects, today = todayISO()) {
      const total = projects.length
      const counts = new Map()
      for (const project of projects) {
        const risk = projectRisk(project, today)
        counts.set(risk.level, (counts.get(risk.level) ?? 0) + 1)
      }
      return [...counts.entries()]
        .map(([level, count]) => ({
          level, count,
          label: RISK_META[level].label,
          tone: RISK_META[level].tone,
          rank: RISK_META[level].rank,
          percent: total === 0 ? 0 : Math.round((count / total) * 100)
        }))
        .sort((a, b) => a.rank - b.rank)
    }

    /** Колонки статусов (вид доски): порядок колонок фиксирован, внутри — сортировка по риску. */
    function statusColumns(projects, today = todayISO()) {
      const extra = [...new Set(projects.map((project) => project?.status || 'В работе'))]
        .filter((status) => !STATUSES.includes(status))
      return [...STATUSES, ...extra].map((status) => {
        const items = sortByRisk(projects.filter((project) => (project?.status || 'В работе') === status), today)
        return {
          status,
          tone: statusTone(status),
          projects: items.map((item) => ({ project: item.project, risk: item.risk })),
          stats: summarize(projects.filter((project) => (project?.status || 'В работе') === status), today)
        }
      })
    }

    /** Нагрузка модуля: число проектов, состав критично/внимание/в норме и средний прогресс. */
    function moduleWorkload(projects, today = todayISO()) {
      const accents = moduleAccentMap(projects)
      return moduleNames(projects)
        .map((module) => {
          const items = projects.filter((project) => (project?.module || 'Другие проекты') === module)
          const risks = items.map((project) => projectRisk(project, today))
          return {
            module,
            accent: accents[module],
            total: items.length,
            danger: risks.filter((risk) => DANGER_LEVELS.includes(risk.level)).length,
            watch: risks.filter((risk) => WATCH_LEVELS.includes(risk.level)).length,
            normal: risks.filter((risk) => !DANGER_LEVELS.includes(risk.level) && !WATCH_LEVELS.includes(risk.level)).length,
            avgProgress: summarize(items, today).avgProgress,
            openTodos: items.reduce((sum, project) => sum + openTodos(project).length, 0)
          }
        })
        .filter((entry) => entry.total > 0)
    }

    /** Гистограмма распределения прогресса. */
    function progressBuckets(projects) {
      const buckets = [
        { label: '0%', test: (value) => value === 0 },
        { label: '1-25%', test: (value) => value > 0 && value <= 25 },
        { label: '26-50%', test: (value) => value > 25 && value <= 50 },
        { label: '51-75%', test: (value) => value > 50 && value <= 75 },
        { label: '76-99%', test: (value) => value > 75 && value < 100 },
        { label: '100%', test: (value) => value >= 100 }
      ]
      const values = projects.map((project) => clampProgress(project))
      return buckets.map((bucket) => ({ label: bucket.label, count: values.filter(bucket.test).length }))
    }

    /** Нагрузка по ответственным. */
    function ownerWorkload(projects, today = todayISO()) {
      const owners = new Map()
      for (const project of projects) {
        const owner = project?.owner?.trim() || 'Не указан'
        if (!owners.has(owner)) owners.set(owner, [])
        owners.get(owner).push(project)
      }
      return [...owners.entries()]
        .map(([owner, items]) => {
          const risks = items.map((project) => projectRisk(project, today))
          return {
            owner,
            total: items.length,
            danger: risks.filter((risk) => DANGER_LEVELS.includes(risk.level)).length,
            openTodos: items.reduce((sum, project) => sum + openTodos(project).length, 0),
            avgProgress: summarize(items, today).avgProgress,
            projects: items
          }
        })
        .sort((a, b) => b.total - a.total || a.owner.localeCompare(b.owner, 'zh-Hans-CN'))
    }

    /* ------------------------------------------------------------------ Календарь */

    const pad = (value) => String(value).padStart(2, '0')

    const monthKeyOf = (today = todayISO()) => String(today).slice(0, 7)

    /** Сдвиг месяца, возвращает YYYY-MM. */
    function shiftMonth(key, delta) {
      const match = /^(\d{4})-(\d{2})$/.exec(String(key))
      if (!match) return monthKeyOf()
      const date = new Date(Number(match[1]), Number(match[2]) - 1 + delta, 1)
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
    }

    function monthLabel(key) {
      const match = /^(\d{4})-(\d{2})$/.exec(String(key))
      return match ? `${Number(match[2])}.${match[1]}` : String(key)
    }

    /**
     * Модель календаря на месяц: сетка на 6 недель, в клетке — проекты с дедлайном и задачи на этот день.
     */
    function calendarMonth(projects, today = todayISO(), key = monthKeyOf(today)) {
      const match = /^(\d{4})-(\d{2})$/.exec(String(key))
      const year = match ? Number(match[1]) : Number(today.slice(0, 4))
      const month = match ? Number(match[2]) : Number(today.slice(5, 7))
      const first = new Date(year, month - 1, 1)
      const lead = first.getDay()
      const daysInMonth = new Date(year, month, 0).getDate()
      const total = Math.ceil((lead + daysInMonth) / 7) * 7

      const cells = []
      let monthItems = 0
      for (let index = 0; index < total; index += 1) {
        const date = new Date(year, month - 1, index - lead + 1)
        const iso = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        const items = []
        for (const project of projects) {
          if (project?.dueDate === iso) {
            const risk = projectRisk(project, today)
            items.push({
              key: `${project.id}::due`,
              kind: 'due',
              tone: risk.tone,
              label: risk.label,
              title: project.name,
              projectId: project.id,
              module: project.module || 'Другие проекты'
            })
          }
          for (const todo of openTodos(project)) {
            if (todo.dueDate !== iso) continue
            const overdue = (daysLeft(iso, today) ?? 1) < 0
            items.push({
              key: `${project.id}::${todo.id}`,
              kind: 'todo',
              todoId: todo.id,
              tone: overdue ? 'danger' : 'muted',
              label: 'На контроле',
              title: todo.title,
              projectId: project.id,
              projectName: project.name,
              module: project.module || 'Другие проекты'
            })
          }
        }
        items.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'due' ? -1 : 1))
        if (index - lead + 1 >= 1 && index - lead + 1 <= daysInMonth) monthItems += items.length
        cells.push({
          iso,
          day: date.getDate(),
          inMonth: index - lead + 1 >= 1 && index - lead + 1 <= daysInMonth,
          isToday: iso === today,
          isWeekend: date.getDay() === 0 || date.getDay() === 6,
          items
        })
      }

      const weeks = []
      for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7))
      const daysWithItems = cells.filter((cell) => cell.inMonth && cell.items.length > 0).length
      return { key, label: monthLabel(key), weeks, cells, monthItems, daysWithItems }
    }

    /* -------------------------------------------------------------- Таймлайн */

    /**
     * Модель таймлайна (Ганта): по горизонтали даты, по строке на проект.
     * Диапазон берётся из дат проектов, дополняется до недель и не длиннее 210 дней.
     */
    function timelineModel(projects, today = todayISO()) {
      const rows = []
      if (projects.length === 0) return { from: today, to: today, totalDays: 0, ticks: [], rows, padded: false }

      const now = dayStart(today)
      const points = [now]
      for (const project of projects) {
        const start = dayStart(project?.startedOn) ?? now
        const due = dayStart(project?.dueDate) ?? now
        points.push(start, due)
      }
      const rawFrom = Math.min(...points)
      const rawTo = Math.max(...points)
      const DAY = 24 * 60 * 60 * 1000
      // Дополняем до понедельника/воскресенья и задаём минимальный диапазон, чтобы клетки не слипались при одном-двух днях
      const fromDate = new Date(Math.min(rawFrom, now - 3 * DAY))
      fromDate.setDate(fromDate.getDate() - fromDate.getDay())
      const toDate = new Date(Math.max(rawTo, now + 3 * DAY))
      toDate.setDate(toDate.getDate() + (6 - toDate.getDay()))
      let span = Math.round((toDate - fromDate) / DAY) + 1
      let padded = false
      if (span > 210) {
        padded = true
        const end = new Date(fromDate.getTime() + 209 * DAY)
        toDate.setTime(end.getTime())
        span = 210
      }
      const totalDays = span
      const offsetOf = (millis) => Math.max(0, Math.min(totalDays, (millis - fromDate.getTime()) / DAY))
      const percent = (value) => (totalDays === 0 ? 0 : (value / totalDays) * 100)
      const isoOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

      const ticks = []
      for (let index = 0; index < totalDays; index += 7) {
        const date = new Date(fromDate.getTime() + index * DAY)
        ticks.push({ index, percent: percent(index), label: `${date.getMonth() + 1}/${date.getDate()}` })
      }

      for (const project of [...projects].sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')))) {
        const startMillis = dayStart(project?.startedOn) ?? now
        const dueMillis = dayStart(project?.dueDate) ?? now
        const left = offsetOf(Math.min(startMillis, dueMillis))
        const right = offsetOf(Math.max(startMillis, dueMillis)) + 1
        rows.push({
          project,
          risk: projectRisk(project, today),
          startIso: isoOf(new Date(Math.min(startMillis, dueMillis))),
          endIso: isoOf(new Date(Math.max(startMillis, dueMillis))),
          leftPercent: percent(left),
          widthPercent: percent(Math.max(1, right - left))
        })
      }
      return {
        from: isoOf(fromDate),
        to: isoOf(toDate),
        totalDays,
        ticks,
        rows,
        todayPercent: percent(offsetOf(now)),
        padded
      }
    }

    /* ------------------------------------------------------------ На контроле */

    const BUCKETS = [
      { key: 'overdue', label: 'Просрочено', tone: 'danger' },
      { key: 'today', label: 'Срок сегодня', tone: 'warn' },
      { key: 'week', label: 'На этой неделе', tone: 'warn' },
      { key: 'later', label: 'Позже', tone: 'muted' },
      { key: 'none', label: 'Без срока', tone: 'muted' }
    ]

    /** Задачи раскладываются по корзинам срочности срока. */
    function followUpBuckets(projects, today = todayISO()) {
      const weekEnd = endOfWeek(today)
      const buckets = BUCKETS.map((bucket) => ({ ...bucket, items: [] }))
      const byKey = Object.fromEntries(buckets.map((bucket) => [bucket.key, bucket]))
      for (const project of projects) {
        for (const todo of openTodos(project)) {
          const left = daysLeft(todo.dueDate, today)
          const key = left === null ? 'none' : left < 0 ? 'overdue' : left === 0 ? 'today' : todo.dueDate <= weekEnd ? 'week' : 'later'
          byKey[key].items.push({
            key: `${project.id}::${todo.id}`,
            todoId: todo.id,
            projectId: project.id,
            projectName: project.name,
            module: project.module || 'Другие проекты',
            title: todo.title,
            owner: todo.owner || project.owner || '',
            dueDate: todo.dueDate,
            overdueDays: left === null || left >= 0 ? 0 : Math.abs(left)
          })
        }
      }
      for (const bucket of buckets) {
        bucket.items.sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')))
        bucket.total = bucket.items.length
      }
      return buckets
    }

    /** Вывод одной фразой вверху обзора. */
    function headline(projects, today = todayISO()) {
      const data = kpis(projects, today)
      if (data.total === 0) return 'Проектов пока нет — добавьте несколько, и доска наполнится.'
      if (data.overdue > 0) {
        return `Из ${data.total} проектов: ${data.overdue} просрочено, ${data.danger} требуют немедленного внимания — начните с колонки «Требуют внимания».`
      }
      if (data.attention > 0) return `${data.total} проектов идут, ${data.attention} требуют присмотра, на этой неделе сдаётся ${data.weekDue}.`
      return `${data.total} проектов в графике, средний прогресс ${data.avgProgress}%, просрочек нет.`
    }

    module.exports = { MODULE_ACCENTS, moduleAccentMap, statusTone, kpis, riskBreakdown, statusColumns, moduleWorkload, progressBuckets, ownerWorkload, monthKeyOf, shiftMonth, monthLabel, calendarMonth, timelineModel, followUpBuckets, headline }
  }
    return __require("client/index.js")
  }
})
