import type {
  MemoryFlowColumnId,
  MemoryFlowColumnView,
  MemoryFlowDisplayStatus,
  MemoryFlowViewModel,
} from './types.js';

export interface MemoryFlowStatusBadge {
  label: '..' | '>>' | 'OK' | '!!' | 'XX';
  text: 'waiting' | 'active' | 'complete' | 'warning' | 'failed';
}

export interface MemoryFlowVisualColumn {
  id: MemoryFlowColumnId;
  title: string;
  status: MemoryFlowDisplayStatus;
  badge: MemoryFlowStatusBadge;
  pulse: boolean;
}

export interface MemoryFlowVisualModel {
  columns: MemoryFlowVisualColumn[];
  connectorLine: string;
  pulseColumnId: MemoryFlowColumnId;
}

export function memoryFlowStatusBadge(status: MemoryFlowDisplayStatus): MemoryFlowStatusBadge {
  if (status === 'active') return { label: '>>', text: 'active' };
  if (status === 'complete') return { label: 'OK', text: 'complete' };
  if (status === 'warning') return { label: '!!', text: 'warning' };
  if (status === 'failed') return { label: 'XX', text: 'failed' };
  return { label: '..', text: 'waiting' };
}

function firstColumnWithStatus(
  columns: MemoryFlowColumnView[],
  status: MemoryFlowDisplayStatus,
): MemoryFlowColumnView | undefined {
  return columns.find((column) => column.status === status);
}

function lastCompletedColumn(columns: MemoryFlowColumnView[]): MemoryFlowColumnView {
  return [...columns].reverse().find((column) => column.status === 'complete') ?? columns[0];
}

function selectPulseColumn(columns: MemoryFlowColumnView[]): MemoryFlowColumnView {
  return (
    firstColumnWithStatus(columns, 'active') ??
    firstColumnWithStatus(columns, 'warning') ??
    firstColumnWithStatus(columns, 'failed') ??
    lastCompletedColumn(columns)
  );
}

function renderColumn(column: MemoryFlowVisualColumn): string {
  return `${column.badge.label} ${column.title}`;
}

export function buildMemoryFlowVisualModel(view: MemoryFlowViewModel): MemoryFlowVisualModel {
  const pulseColumn = selectPulseColumn(view.columns);
  const columns = view.columns.map((column) => ({
    id: column.id,
    title: column.title,
    status: column.status,
    badge: memoryFlowStatusBadge(column.status),
    pulse: column.id === pulseColumn.id,
  }));

  return {
    columns,
    connectorLine: columns.map(renderColumn).join(' -> '),
    pulseColumnId: pulseColumn.id,
  };
}

export function renderMemoryFlowConnectorLine(view: MemoryFlowViewModel): string {
  return buildMemoryFlowVisualModel(view).connectorLine;
}
