import ExcelJS from 'exceljs';
import { WarningRow, AnalysisResult, ColumnMapping } from './types';

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

export async function readHeaders(filePath: string): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.getWorksheet(1);
  if (!worksheet) { return []; }

  const headers: string[] = [];
  const headerRow = worksheet.getRow(1);
  headerRow.eachCell((cell) => {
    const val = String(cell.value ?? '').trim();
    if (val) { headers.push(val); }
  });
  return headers;
}

function buildColumnMap(worksheet: ExcelJS.Worksheet, mapping?: ColumnMapping): ColumnMap {
  const headerRow = worksheet.getRow(1);
  const map: Partial<ColumnMap> = {};

  // Build a lookup: lowercase header name → column number
  const headerIndex = new Map<string, number>();
  headerRow.eachCell((cell, colNumber) => {
    const header = String(cell.value).trim();
    headerIndex.set(header.toLowerCase(), colNumber);
  });

  if (mapping) {
    // Use user-provided mapping
    map.message = headerIndex.get(mapping.message.toLowerCase());
    map.path = headerIndex.get(mapping.path.toLowerCase());
    map.lineInCode = headerIndex.get(mapping.lineInCode.toLowerCase());
    map.column = headerIndex.get(mapping.column.toLowerCase());
    map.codeLine = headerIndex.get(mapping.codeLine.toLowerCase());
  } else {
    // Fallback: match by hardcoded names
    map.message = headerIndex.get('message');
    map.path = headerIndex.get('path');
    map.lineInCode = headerIndex.get('line-in-code');
    map.column = headerIndex.get('column');
    map.codeLine = headerIndex.get('code-line');
  }

  // Always detect output columns by name
  map.comment = headerIndex.get('comment');
  map.priority = headerIndex.get('priority');
  map.fixApplied = headerIndex.get('fixapplied');

  // Validate required columns
  const missing: string[] = [];
  if (!map.message) { missing.push(mapping?.message || 'Message'); }
  if (!map.path) { missing.push(mapping?.path || 'Path'); }
  if (!map.lineInCode) { missing.push(mapping?.lineInCode || 'Line-in-Code'); }
  if (!map.column) { missing.push(mapping?.column || 'Column'); }
  if (!map.codeLine) { missing.push(mapping?.codeLine || 'Code-Line'); }

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

export async function readWarnings(filePath: string, columnMapping?: ColumnMapping): Promise<WarningRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const worksheet = workbook.getWorksheet(1);
  if (!worksheet) {
    throw new Error('No worksheet found in Excel file');
  }

  const colMap = buildColumnMap(worksheet, columnMapping);
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
  result: AnalysisResult,
  columnMapping?: ColumnMapping
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const worksheet = workbook.getWorksheet(1);
  if (!worksheet) {
    throw new Error('No worksheet found in Excel file');
  }

  const colMap = buildColumnMap(worksheet, columnMapping);
  const row = worksheet.getRow(rowNumber);

  row.getCell(colMap.priority).value = result.priority;
  row.getCell(colMap.comment).value = result.comment;
  row.getCell(colMap.fixApplied).value = result.fixApplied ? 'YES' : '';
  row.commit();

  await workbook.xlsx.writeFile(filePath);
}
