/**
 * Демо-проекты: типичная работа бэкенд/фулстек-инженера, по 4 на каждый модуль.
 * Покрывают просрочку, срочность, отставание, блокер, «не начат» и «завершён»; даты считаются относительно "сегодня",
 * поэтому набор корректен в любой день. У записей тег «Пример» — их легко узнать и удалить.
 */
import { todayISO } from './analysis.js'
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
export function buildSampleProjects(today = todayISO()) {
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
export function sampleSummary(projects) {
  const byModule = {}
  for (const project of projects) byModule[project.module] = (byModule[project.module] ?? 0) + 1
  const detail = Object.entries(byModule).map(([name, count]) => `${name}: ${count}`).join(', ')
  return `демо-проектов: ${projects.length} (${detail})`
}
