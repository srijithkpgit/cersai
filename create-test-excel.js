const ExcelJS = require('exceljs');
const path = require('path');

async function createTestExcel() {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Warnings');

  ws.columns = [
    { header: 'Message', key: 'Message', width: 50 },
    { header: 'Path', key: 'Path', width: 30 },
    { header: 'Line-in-Code', key: 'Line-in-Code', width: 12 },
    { header: 'Column', key: 'Column', width: 8 },
    { header: 'Code-Line', key: 'Code-Line', width: 60 },
  ];

  // Style header
  ws.getRow(1).font = { bold: true };

  ws.addRow({
    'Message': 'INT31-C: Ensure that integer conversions do not result in lost or misinterpreted data - implicit conversion from uint32_t to uint16_t',
    'Path': 'src/main.c',
    'Line-in-Code': 21,
    'Column': 22,
    'Code-Line': '    uint16_t total = (uint16_t)result;',
  });

  ws.addRow({
    'Message': 'STR31-C: Guarantee that storage for strings has sufficient space for character data and the null terminator - use of strcpy without bounds check',
    'Path': 'src/main.c',
    'Line-in-Code': 29,
    'Column': 5,
    'Code-Line': '    strcpy(dest, src);',
  });

  ws.addRow({
    'Message': 'INT33-C: Ensure that division and remainder operations do not result in divide-by-zero errors',
    'Path': 'src/main.c',
    'Line-in-Code': 34,
    'Column': 12,
    'Code-Line': '    return a / b;',
  });

  const outPath = path.join(process.env.HOME, 'Desktop', 'certc-test-report.xlsx');
  await workbook.xlsx.writeFile(outPath);
  console.log('Test Excel created at:', outPath);
}

createTestExcel().catch(console.error);
