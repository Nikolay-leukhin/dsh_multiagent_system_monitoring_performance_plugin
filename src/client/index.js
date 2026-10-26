/** Клиентская точка входа воркбенча: регистрирует бизнес-панель в Desktop. */
import React from 'react'
import { ConsoleView, ProjectConsole } from './panel.js'
const REPOSITORY = 'https://github.com/OliverLiy/projectHub'

export function apply(ctx) {
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

export const inject = ['desktopWorkbenches']

// Дополнительный экспорт нужен, чтобы рендерить панель в автотестах без Desktop; загрузчик модулей читает только apply/inject.
export { ConsoleView, ProjectConsole }
