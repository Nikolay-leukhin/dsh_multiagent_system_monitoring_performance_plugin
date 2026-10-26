/** Компоненты доски по каждому разрезу. */
import React from 'react'
import { Donut, Histogram, Legend, RankBars, StackedBars } from './charts.js'
import { Badge, Btn, Empty, Icon, IconBtn, Progress, RiskBadge, Stat } from './ui.js'
import { clampProgress, formatRemaining, latestUpdate, openTodos, projectRisk } from '../shared/analysis.js'
const h = React.createElement
const PROGRESS_TONE = { overdue: 'danger', blocked: 'danger', urgent: 'danger', slipping: 'warn', soon: 'warn', done: 'ok' }
const accentOf = (accents, module) => accents?.[module] ?? 'indigo'

/* ---------------------------------------------------------------- Карточка проекта */

export function ProjectCard({ project, risk, today, accents, onOpen }) {
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

export function BoardScreen({ groups, today, accents, onOpen }) {
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

export function ListScreen({ rows, today, accents, onOpen }) {
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

export function KanbanScreen({ columns, accents, onOpen }) {
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

export function CalendarScreen({ model, today, selectedIso, onSelect, onShift, onToday, onOpen, onToggleTodo }) {
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

export function TimelineScreen({ model, today, accents, onOpen }) {
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

export function FollowUpsScreen({ buckets, today, onToggle, onOpen }) {
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

export function OverviewScreen({
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
