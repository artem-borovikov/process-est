#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Выгружает представление (или таблицу) PostgreSQL в лист Google Sheets через Sheets API.
 * Лист полностью перезаписывается: первая строка - имена колонок, далее данные.
 *
 * Использование:
 *   node tmp/pg-view-to-gsheet.js --view <schema.view> [--spreadsheet <id>] [--sheet <имя>] [--chunk 5000]
 *
 * Читает ровно два файла, без запасных вариантов (никаких .env проекта, DATABASE_URL, DB_*, значений по умолчанию
 * и переменных оболочки):
 *   1. tmp/gsheet.env - PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, GOOGLE_APPLICATION_CREDENTIALS
 *      (и необязательно GSHEET_VIEW / GSHEET_ID / GSHEET_SHEET / GSHEET_CHUNK);
 *   2. JSON-ключ service account по пути из GOOGLE_APPLICATION_CREDENTIALS (таблица должна быть расшарена на его email).
 * Если чего-то не хватает, скрипт останавливается с понятной ошибкой.
 * doc: https://docs.google.com/spreadsheets/d/1WTlANVAUYpH3ypQNy7B_7MMcl6z1HwJqcn9nXaw01dY/edit?gid=801388477#gid=801388477
 *
 * @example
 * cd ~/Projects/cde-collector
 * node tmp/pg-view-to-gsheet.js --view public.v_cde_log
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");

const { Pool } = require("pg");

const ENV_FILE = path.resolve(__dirname, "gsheet.env");
const REQUIRED_ENV = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "GOOGLE_APPLICATION_CREDENTIALS"];

/** Читает только tmp/gsheet.env: process.env не используется, значения по умолчанию не подставляются */
function readEnvFile() {
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error(`Нет файла ${ENV_FILE}`);
  }
  const env = parseEnv(fs.readFileSync(ENV_FILE, "utf8"));
  const missing = REQUIRED_ENV.filter(name => !env[name]);
  if (missing.length) {
    throw new Error(`В ${ENV_FILE} не заданы: ${missing.join(", ")}`);
  }
  if (!fs.existsSync(env.GOOGLE_APPLICATION_CREDENTIALS)) {
    throw new Error(`Нет файла ключа Google: ${env.GOOGLE_APPLICATION_CREDENTIALS}`);
  }
  return env;
}

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
/** Таблица по умолчанию; переопределяется --spreadsheet или GSHEET_ID */
const DEFAULT_SPREADSHEET_ID = "0000";
/** Вкладка по умолчанию (полностью перезаписывается при каждом запуске); переопределяется --sheet или GSHEET_SHEET */
const DEFAULT_SHEET_NAME = "log";
const MAX_CELLS = 10_000_000;
const MAX_ATTEMPTS = 5;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split(/=(.*)/s);
      args[key] = inline !== undefined ? inline : argv[++i];
    }
  }
  return args;
}

function usage() {
  return [
    "Использование:",
    "  node tmp/pg-view-to-gsheet.js --view <schema.view> [--spreadsheet <id>] [--sheet <имя>] [--chunk <строк>]",
    "",
    "  --view         представление или таблица в PG (или GSHEET_VIEW)",
    "  --spreadsheet  id Google-таблицы (или GSHEET_ID)",
    "  --sheet        имя листа (или GSHEET_SHEET), по умолчанию - log; создаётся, если его нет",
    "  --chunk        сколько строк отправлять за один запрос (или GSHEET_CHUNK), по умолчанию 5000",
    "",
    "Файлы (других источников нет):",
    "  tmp/gsheet.env  PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, GOOGLE_APPLICATION_CREDENTIALS",
    "  JSON-ключ service account по пути из GOOGLE_APPLICATION_CREDENTIALS"
  ].join("\n");
}

function dbConfig(env) {
  return {
    host: env.PGHOST,
    port: Number(env.PGPORT),
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD
  };
}

const base64url = input => Buffer.from(input).toString("base64url");

/** "my_schema.my_view" -> "my_schema"."my_view" */
const quoteIdentifier = name =>
  name
    .split(".")
    .map(part => `"${part.replace(/"/g, '""')}"`)
    .join(".");

/** Диапазон в A1-нотации с экранированием имени листа; без cell - весь лист */
const a1 = (sheet, cell) => `'${sheet.replace(/'/g, "''")}'${cell ? `!${cell}` : ""}`;

/** Дата/время PG в серийный номер Google Sheets (дни от 30.12.1899) по локальному времени, как его вернул драйвер */
const SHEETS_EPOCH_UTC = Date.UTC(1899, 11, 30);
const toSerial = date =>
  (Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  ) -
    SHEETS_EPOCH_UTC) /
  86_400_000;

function toCell(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return toSerial(value);
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

async function getAccessToken(keyFile) {
  const { client_email: clientEmail, private_key: privateKey } = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64url(JSON.stringify({ iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }))
  ].join(".");
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`
    })
  });
  if (!response.ok) {
    throw new Error(`Не удалось получить токен Google: ${response.status} ${await response.text()}`);
  }
  return (await response.json()).access_token;
}

function createSheetsClient(token, spreadsheetId) {
  return async function request(method, path, body) {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(`${SHEETS_API}/${spreadsheetId}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (response.ok) return response.json();

      const retriable = response.status === 429 || response.status >= 500;
      if (!retriable || attempt === MAX_ATTEMPTS) {
        throw new Error(`Sheets API ${method} ${path}: ${response.status} ${await response.text()}`);
      }
      const delay = 2 ** attempt * 1000;
      console.warn(`Sheets API ответил ${response.status}, повтор через ${delay / 1000} с`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  };
}

/** Создаёт лист, если его нет, и расширяет сетку до нужного размера */
async function prepareSheet(request, sheetName, rowCount, columnCount) {
  const { sheets } = await request("GET", "?fields=sheets.properties");
  const existing = sheets.map(sheet => sheet.properties).find(properties => properties.title === sheetName);

  if (!existing) {
    const reply = await request("POST", ":batchUpdate", {
      requests: [{ addSheet: { properties: { title: sheetName, gridProperties: { rowCount, columnCount } } } }]
    });
    return reply.replies[0].addSheet.properties.sheetId;
  }

  const grid = existing.gridProperties;
  if (grid.rowCount < rowCount || grid.columnCount < columnCount) {
    await request("POST", ":batchUpdate", {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId: existing.sheetId,
              gridProperties: {
                rowCount: Math.max(grid.rowCount, rowCount),
                columnCount: Math.max(grid.columnCount, columnCount)
              }
            },
            fields: "gridProperties(rowCount,columnCount)"
          }
        }
      ]
    });
  }
  return existing.sheetId;
}

/** OID типов PG: date, timestamp, timestamptz */
const DATE_OIDS = new Set([1082]);
const DATETIME_OIDS = new Set([1114, 1184]);

async function readView(view, env) {
  const pool = new Pool(dbConfig(env));
  try {
    const { rows, fields } = await pool.query({ text: `SELECT * FROM ${quoteIdentifier(view)}`, rowMode: "array" });
    // индекс колонки -> "DATE" | "DATE_TIME": им задаём формат ДД.ММ.ГГГГ
    const dateColumns = new Map();
    fields.forEach((field, index) => {
      if (DATE_OIDS.has(field.dataTypeID)) dateColumns.set(index, "DATE");
      if (DATETIME_OIDS.has(field.dataTypeID)) dateColumns.set(index, "DATE_TIME");
    });
    return { values: [fields.map(field => field.name), ...rows.map(row => row.map(toCell))], dateColumns };
  } finally {
    await pool.end();
  }
}

/** Цвета - токены из process-component (packages/frontend/src/vars.scss), RGB 0..1 */
const rgb = (r, g, b) => ({ red: r / 255, green: g / 255, blue: b / 255 });
const HEADER_BACKGROUND = rgb(224, 224, 224); // --gray-300
const HEADER_TEXT = rgb(20, 25, 26); // --primary-text-color
const HEADER_BORDER = rgb(189, 189, 189); // --gray-400
const SUCCESS_TEXT = rgb(46, 125, 50); // --green-800
const SUCCESS_BACKGROUND = rgb(232, 245, 233); // --green-50
const FAILURE_TEXT = rgb(244, 67, 54); // --red-500
const FAILURE_BACKGROUND = rgb(255, 235, 238); // --red-50
/** Шрифт проекта process-component - Formular (коммерческий, в Google Sheets его нет), берём ближайший доступный */
const FONT_FAMILY = "Roboto";
/** Высота каждой строки (пикселей): стандартная 21 x 2 */
const ROW_HEIGHT = 42;
/** Колонки шире на 1.5 от «по содержимому»; имя файла - ещё шире */
const WIDTH_FACTOR = 1.5;
const FILE_NAME_HEADER = "Имя файла";
const FILE_NAME_WIDTH = 640;
const DATE_PATTERNS = { DATE: "dd.mm.yyyy", DATE_TIME: "dd.mm.yyyy hh:mm:ss" };
/** Колонка с Да/Нет подсвечивается зелёным/красным */
const SUCCESS_HEADER = "Удалось отправить в адаптер";

/** Ширина колонки по самому длинному значению в первых строках (в пределах разумного) */
function columnWidth(values, index, isDate) {
  if (values[0][index] === FILE_NAME_HEADER) return FILE_NAME_WIDTH;
  if (isDate) return Math.round(120 * WIDTH_FACTOR);
  const sample = values.slice(0, 500);
  const longest = Math.max(...sample.map(row => String(row[index] ?? "").length));
  return Math.round(Math.min(Math.max(longest * 7 + 24, 90), 380) * WIDTH_FACTOR);
}

/** Оформление: жирный заголовок, закрепление строки, фильтр, формат дат ДД.ММ.ГГГГ, ширины колонок, цвет Да/Нет */
async function formatSheet(request, sheetId, values, dateColumns) {
  const rowCount = values.length;
  const columnCount = values[0].length;
  const requests = [];

  // Условное форматирование не затирается values:clear - удаляем старые правила, чтобы не копились
  const { sheets } = await request("GET", "?fields=sheets(properties.sheetId,conditionalFormats)");
  const current = sheets.find(sheet => sheet.properties.sheetId === sheetId);
  for (let index = 0; index < (current?.conditionalFormats?.length ?? 0); index++) {
    requests.push({ deleteConditionalFormatRule: { sheetId, index: 0 } });
  }

  requests.push(
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount"
      }
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: HEADER_BACKGROUND,
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
            textFormat: { bold: true, foregroundColor: HEADER_TEXT, fontFamily: FONT_FAMILY }
          }
        },
        fields: "userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)"
      }
    },
    {
      updateBorders: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnCount },
        bottom: { style: "SOLID", color: HEADER_BORDER }
      }
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: rowCount },
        cell: { userEnteredFormat: { wrapStrategy: "CLIP", verticalAlignment: "MIDDLE" } },
        fields: "userEnteredFormat(wrapStrategy,verticalAlignment)"
      }
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: rowCount },
        cell: { userEnteredFormat: { textFormat: { fontFamily: FONT_FAMILY } } },
        fields: "userEnteredFormat.textFormat.fontFamily"
      }
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: rowCount },
        properties: { pixelSize: ROW_HEIGHT },
        fields: "pixelSize"
      }
    },
    {
      setBasicFilter: {
        // Без endRowIndex/endColumnIndex диапазон тянется до края сетки листа: фильтр охватывает все колонки и строки сам
        filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0 } }
      }
    }
  );

  for (let index = 0; index < columnCount; index++) {
    const dateKind = dateColumns.get(index);
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 },
        properties: { pixelSize: columnWidth(values, index, Boolean(dateKind)) },
        fields: "pixelSize"
      }
    });
    if (dateKind) {
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: index, endColumnIndex: index + 1 },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: dateKind, pattern: DATE_PATTERNS[dateKind] },
              horizontalAlignment: "CENTER"
            }
          },
          fields: "userEnteredFormat(numberFormat,horizontalAlignment)"
        }
      });
    }
  }

  const successIndex = values[0].indexOf(SUCCESS_HEADER);
  if (successIndex >= 0) {
    const range = { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: successIndex, endColumnIndex: successIndex + 1 };
    const rule = (text, textColor, backgroundColor) => ({
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [range],
          booleanRule: {
            condition: { type: "TEXT_EQ", values: [{ userEnteredValue: text }] },
            format: { textFormat: { bold: true, foregroundColor: textColor }, backgroundColor }
          }
        }
      }
    });
    requests.push(
      rule("Да", SUCCESS_TEXT, SUCCESS_BACKGROUND),
      rule("Нет", FAILURE_TEXT, FAILURE_BACKGROUND)
    );
  }

  await request("POST", ":batchUpdate", { requests });
  console.log("Форматирование применено");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const env = readEnvFile();
  const view = args.view || env.GSHEET_VIEW;
  const spreadsheetId = args.spreadsheet || env.GSHEET_ID || DEFAULT_SPREADSHEET_ID;
  const keyFile = env.GOOGLE_APPLICATION_CREDENTIALS;
  const sheetName = args.sheet || env.GSHEET_SHEET || DEFAULT_SHEET_NAME;
  const chunkSize = Number(args.chunk || env.GSHEET_CHUNK || 5000);

  const missing = [
    !view && "--view (или GSHEET_VIEW)",
    !spreadsheetId && "--spreadsheet (или GSHEET_ID)"
  ].filter(Boolean);
  if (missing.length || !Number.isInteger(chunkSize) || chunkSize < 1) {
    console.error(missing.length ? `Не задано: ${missing.join(", ")}` : "--chunk должен быть целым числом больше 0");
    console.error(`\n${usage()}`);
    process.exitCode = 1;
    return;
  }

  const { values, dateColumns } = await readView(view, env);
  const rowCount = values.length;
  const columnCount = values[0].length;
  console.log(`Прочитано из ${view}: строк ${rowCount - 1}, колонок ${columnCount}`);

  if (rowCount * columnCount > MAX_CELLS) {
    throw new Error(`Выгрузка не поместится в Google Sheets: ${rowCount * columnCount} ячеек при лимите ${MAX_CELLS}`);
  }

  const request = createSheetsClient(await getAccessToken(keyFile), spreadsheetId);
  const sheetId = await prepareSheet(request, sheetName, rowCount, columnCount);
  await request("POST", `/values/${encodeURIComponent(a1(sheetName))}:clear`, {});

  for (let offset = 0; offset < rowCount; offset += chunkSize) {
    const chunk = values.slice(offset, offset + chunkSize);
    const range = encodeURIComponent(a1(sheetName, `A${offset + 1}`));
    await request("PUT", `/values/${range}?valueInputOption=RAW`, { values: chunk });
    console.log(`Записано строк: ${Math.min(offset + chunkSize, rowCount)} из ${rowCount}`);
  }

  await formatSheet(request, sheetId, values, dateColumns);

  console.log(`Готово: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
