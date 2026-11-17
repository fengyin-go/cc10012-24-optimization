/** CSV 拼装：页面导出统一走这里，避免每处各写一遍转义规则。 */

export function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function csvLine(values: (string | number)[]): string {
  return values.map(csvCell).join(',')
}

export function csvDocument(header: string[], rows: (string | number)[][]): string {
  return `﻿${[csvLine(header), ...rows.map(csvLine)].join('\n')}`
}
