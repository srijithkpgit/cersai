import ExcelJS from 'exceljs';
import { WarningRow, AnalysisResult } from './types';

const REQUIRED_HEADERS = ['Message', 'Path', 'Line-in-Code', 'Column', 'Code-Line'] as const;

interface ColumnMap {
  message: number;
  path: number;
  lineInCode: number;
  column: number;
  codeLine: number;
  comment: number;
  priority: number;
  fixApplied: number;
}

function buildColumnMap(worksheet: ExcelJS.Worksheet): ColumnMap {
  const headerRow = worksheet.getRow(1);
  const map: Partial<ColumnMap> = {};

  headerRow.eachCell((cell, colNumber) => {
    const header = String(cell.value).trim().toLowerCase();
    switch (header) {
      case 'message': map.message = colNumber; break;
      case 'path': map.path = colNumber; break;
      case 'line-in-code': map.lineInCode = colNumber; break;
      case 'column': map.column = colNumber; break;
      case 'code-line': map.codeLine = colNumber; break;
      case 'comment': map.comment = colNumber; break;
      case 'priority': map.priority = colNumber; break;
      case 'fixapplied': map.fixApplied = colNumber; break;
    }
  });

  // Validate required columns
  const missing: string[] = [];
  if (!map.message) { missing.push('Message'); }
  if (!map.path) { missing.push('Path'); }
  if (!map.lineInCode) { missing.push('Line-in-Code'); }
  if (!map.column) { missing.push('Column'); }
  if (!map.codeLine) { missing.push('Code-Line'); }

  if (missing.length > 0) {
    throw new Error(`Missing required columns in Excel: ${missing.join(', ')}`);
  }

  // Create Comment column if not found
  if (!map.comment) {
    const lastCol = worksheet.columnCount + 1;
    headerRow.getCell(lastCol).value = 'Comment';
    map.comment = lastCol;
  }

  // Create Priority column if not found (column M = 13, but use dynamic)
  if (!map.priority) {
    const lastCol = worksheet.columnCount + 1;
    headerRow.getCell(lastCol).value = 'Priority';
    map.priority = lastCol;
  }

  // Create FixApplied column if not found
  if (!map.fixApplied) {
    const lastCol = worksheet.columnCount + 1;
    headerRow.getCell(lastCol).value = 'FixApplied';
    map.fixApplied = lastCol;
  }

  return map as ColumnMap;
}

export async function readWarnings(filePath: string): Promise<WarningRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const worksheet = workbook.getWorksheet(1);
  if (!worksheet) {
    throw new Error('No worksheet found in Excel file');
  }

  const colMap = buildColumnMap(worksheet);
  const warnings: WarningRow[] = [];

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) { return; }

    const message = String(row.getCell(colMap.message).value ?? '').trim();
    const filePath = String(row.getCell(colMap.path).value ?? '').trim();
    const lineInCode = Number(row.getCell(colMap.lineInCode).value) || 0;
    const column = Number(row.getCell(colMap.column).value) || 0;
    const codeLine = String(row.getCell(colMap.codeLine).value ?? '').trim();

    if (message && filePath) {
      const existingPriority = colMap.priority
        ? String(row.getCell(colMap.priority).value ?? '').trim()
        : '';
      warnings.push({ rowNumber, message, filePath, lineInCode, column, codeLine, existingPriority });
    }
  });

  return warnings;
}

export async function writeResult(
  filePath: string,
  rowNumber: number,
  result: AnalysisResult
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const worksheet = workbook.getWorksheet(1);
  if (!worksheet) {
    throw new Error('No worksheet found in Excel file');
  }

  const colMap = buildColumnMap(worksheet);
  const row = worksheet.getRow(rowNumber);

  row.getCell(colMap.priority).value = result.priority;
  row.getCell(colMap.comment).value = result.comment;
  row.getCell(colMap.fixApplied).value = result.fixApplied ? 'YES' : '';
  row.commit();

  await workbook.xlsx.writeFile(filePath);
}
