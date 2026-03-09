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
  analyser: number;
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

  // Output columns: use mapping if provided, else detect by default names
  const reasoningName = mapping?.reasoning?.toLowerCase();
  const resultsName = mapping?.results?.toLowerCase();
  const analyserName = mapping?.analyser?.toLowerCase();

  map.comment = (reasoningName && headerIndex.get(reasoningName)) || headerIndex.get('comment');
  map.priority = (resultsName && headerIndex.get(resultsName)) || headerIndex.get('priority');
  map.fixApplied = headerIndex.get('fixapplied');
  map.analyser = (analyserName && headerIndex.get(analyserName)) || headerIndex.get('analyser') || headerIndex.get('analyzer');

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

  // Create Comment/Reasoning column if not found
  if (!map.comment) {
    const lastCol = worksheet.columnCount + 1;
    headerRow.getCell(lastCol).value = mapping?.reasoning || 'Comment';
    map.comment = lastCol;
  }

  // Create Priority/Results column if not found
  if (!map.priority) {
    const lastCol = worksheet.columnCount + 1;
    headerRow.getCell(lastCol).value = mapping?.results || 'Priority';
    map.priority = lastCol;
  }

  // Create FixApplied column if not found
  if (!map.fixApplied) {
    const lastCol = worksheet.columnCount + 1;
    headerRow.getCell(lastCol).value = 'FixApplied';
    map.fixApplied = lastCol;
  }

  // Create Analyser column if not found and an analyser mapping was specified
  if (!map.analyser && mapping?.analyser) {
    const lastCol = worksheet.columnCount + 1;
    headerRow.getCell(lastCol).value = mapping.analyser;
    map.analyser = lastCol;
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
  columnMapping?: ColumnMapping,
  analyserName?: string
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
  if (colMap.analyser && analyserName) {
    row.getCell(colMap.analyser).value = analyserName;
  }
  row.commit();

  await workbook.xlsx.writeFile(filePath);
}
