import crypto from "node:crypto";
import { NexusError } from "../errors/index.js";
import {
  toSnakeCase,
  type AnyFieldBuilder,
  type AnyModelDefinition,
  type FieldMeta,
} from "../schema/index.js";
import type { FilterASTNode, OrderByASTNode } from "./index.js";

const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface CompiledSQLQuery {
  sql: string;
  params: unknown[];
}

export interface InternalModelMeta {
  name: string;
  tableName: string;
  fieldsByName: Map<string, FieldMeta>;
  fieldsByCol: Map<string, FieldMeta>;
  primaryKey?: FieldMeta;
}

export function buildModelMeta(model: AnyModelDefinition): InternalModelMeta {
  if (!VALID_IDENTIFIER.test(model.name) || !VALID_IDENTIFIER.test(model.tableName)) {
    throw new NexusError({
      code: "NEXUS_VALIDATION_ERROR",
      message: `Unsafe model or table identifier on ${model.name}`,
      retryable: false,
    });
  }

  const fieldsByName = new Map<string, FieldMeta>();
  const fieldsByCol = new Map<string, FieldMeta>();
  let primaryKey: FieldMeta | undefined;

  const fieldsRecord = model.fields as Record<string, AnyFieldBuilder>;
  for (const [fieldName, builder] of Object.entries(fieldsRecord)) {
    const col = builder.meta.column || toSnakeCase(fieldName);
    if (!VALID_IDENTIFIER.test(fieldName) || !VALID_IDENTIFIER.test(col)) {
      throw new NexusError({
        code: "NEXUS_VALIDATION_ERROR",
        message: `Unsafe field or column identifier ${fieldName} (${col})`,
        retryable: false,
      });
    }
    const meta: FieldMeta = {
      ...builder.meta,
      name: fieldName,
      column: col,
    };
    fieldsByName.set(fieldName, meta);
    fieldsByCol.set(col, meta);
    if (meta.primaryKey) {
      primaryKey = meta;
    }
  }

  return {
    name: model.name,
    tableName: model.tableName,
    fieldsByName,
    fieldsByCol,
    primaryKey,
  };
}

export function compileFilterAST(
  meta: InternalModelMeta,
  node?: FilterASTNode
): CompiledSQLQuery {
  if (!node) return { sql: "", params: [] };

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (node.AND && node.AND.length > 0) {
    const subClauses: string[] = [];
    for (const child of node.AND) {
      const compiled = compileFilterAST(meta, child);
      if (compiled.sql) {
        subClauses.push(compiled.sql);
        params.push(...compiled.params);
      }
    }
    if (subClauses.length > 0) {
      clauses.push(`(${subClauses.join(" AND ")})`);
    }
  }

  if (node.OR && node.OR.length > 0) {
    const subClauses: string[] = [];
    for (const child of node.OR) {
      const compiled = compileFilterAST(meta, child);
      if (compiled.sql) {
        subClauses.push(compiled.sql);
        params.push(...compiled.params);
      }
    }
    if (subClauses.length > 0) {
      clauses.push(`(${subClauses.join(" OR ")})`);
    }
  }

  if (node.NOT) {
    const compiled = compileFilterAST(meta, node.NOT);
    if (compiled.sql) {
      clauses.push(`(NOT ${compiled.sql})`);
      params.push(...compiled.params);
    }
  }

  if (node.field) {
    const fieldMeta = meta.fieldsByName.get(node.field);
    if (!fieldMeta) {
      throw new NexusError({
        code: "NEXUS_VALIDATION_ERROR",
        message: `Unknown field '${node.field}' on model '${meta.name}'`,
        model: meta.name,
        fields: [node.field],
        retryable: false,
      });
    }
    const qCol = `"${fieldMeta.column}"`;
    const op = node.op ?? "eq";

    switch (op) {
      case "eq":
        if (node.value === null) {
          clauses.push(`${qCol} IS NULL`);
        } else {
          clauses.push(`${qCol} = ?`);
          params.push(coerceBindParam(fieldMeta, node.value));
        }
        break;
      case "neq":
        if (node.value === null) {
          clauses.push(`${qCol} IS NOT NULL`);
        } else {
          clauses.push(`${qCol} <> ?`);
          params.push(coerceBindParam(fieldMeta, node.value));
        }
        break;
      case "gt":
        clauses.push(`${qCol} > ?`);
        params.push(coerceBindParam(fieldMeta, node.value));
        break;
      case "gte":
        clauses.push(`${qCol} >= ?`);
        params.push(coerceBindParam(fieldMeta, node.value));
        break;
      case "lt":
        clauses.push(`${qCol} < ?`);
        params.push(coerceBindParam(fieldMeta, node.value));
        break;
      case "lte":
        clauses.push(`${qCol} <= ?`);
        params.push(coerceBindParam(fieldMeta, node.value));
        break;
      case "in": {
        const list = Array.isArray(node.value) ? node.value : [node.value];
        if (list.length === 0) {
          clauses.push("1 = 0");
        } else {
          const placeholders = list.map(() => "?").join(", ");
          clauses.push(`${qCol} IN (${placeholders})`);
          for (const item of list) {
            params.push(coerceBindParam(fieldMeta, item));
          }
        }
        break;
      }
      case "notIn": {
        const list = Array.isArray(node.value) ? node.value : [node.value];
        if (list.length === 0) {
          clauses.push("1 = 1");
        } else {
          const placeholders = list.map(() => "?").join(", ");
          clauses.push(`${qCol} NOT IN (${placeholders})`);
          for (const item of list) {
            params.push(coerceBindParam(fieldMeta, item));
          }
        }
        break;
      }
      case "contains":
        clauses.push(`${qCol} LIKE ?`);
        params.push(`%${String(node.value)}%`);
        break;
      case "startsWith":
        clauses.push(`${qCol} LIKE ?`);
        params.push(`${String(node.value)}%`);
        break;
      case "endsWith":
        clauses.push(`${qCol} LIKE ?`);
        params.push(`%${String(node.value)}`);
        break;
      case "isNull":
        clauses.push(node.value ? `${qCol} IS NULL` : `${qCol} IS NOT NULL`);
        break;
      default:
        throw new NexusError({
          code: "NEXUS_VALIDATION_ERROR",
          message: `Unsupported filter operator '${op}'`,
          retryable: false,
        });
    }
  }

  return {
    sql: clauses.join(" AND "),
    params,
  };
}

export function compileSelectSQL(
  meta: InternalModelMeta,
  opts: {
    where?: FilterASTNode;
    select?: string[];
    orderBy?: OrderByASTNode[];
    limit?: number;
    offset?: number;
  }
): CompiledSQLQuery {
  const selectCols: string[] = [];
  if (opts.select && opts.select.length > 0) {
    for (const fName of opts.select) {
      const f = meta.fieldsByName.get(fName);
      if (!f) {
        throw new NexusError({
          code: "NEXUS_VALIDATION_ERROR",
          message: `Unknown select field '${fName}' on model '${meta.name}'`,
          retryable: false,
        });
      }
      selectCols.push(`"${f.column}"`);
    }
  } else {
    for (const f of meta.fieldsByName.values()) {
      selectCols.push(`"${f.column}"`);
    }
  }

  let sql = `SELECT ${selectCols.join(", ")} FROM "${meta.tableName}"`;
  const params: unknown[] = [];

  const whereCompiled = compileFilterAST(meta, opts.where);
  if (whereCompiled.sql) {
    sql += ` WHERE ${whereCompiled.sql}`;
    params.push(...whereCompiled.params);
  }

  if (opts.orderBy && opts.orderBy.length > 0) {
    const orderParts: string[] = [];
    for (const o of opts.orderBy) {
      const f = meta.fieldsByName.get(o.field);
      if (!f) {
        throw new NexusError({
          code: "NEXUS_VALIDATION_ERROR",
          message: `Unknown orderBy field '${o.field}' on model '${meta.name}'`,
          retryable: false,
        });
      }
      const dir = o.dir.toUpperCase() === "DESC" ? "DESC" : "ASC";
      orderParts.push(`"${f.column}" ${dir}`);
    }
    sql += ` ORDER BY ${orderParts.join(", ")}`;
  }

  if (typeof opts.limit === "number" && opts.limit > 0) {
    sql += ` LIMIT ${Math.floor(opts.limit)}`;
  }
  if (typeof opts.offset === "number" && opts.offset > 0) {
    sql += ` OFFSET ${Math.floor(opts.offset)}`;
  }

  return { sql: sql + ";", params };
}

export function prepareInsertStatement(
  meta: InternalModelMeta,
  data: Record<string, unknown>
): { sql: string; params: unknown[]; pkValue: unknown } {
  const colNames: string[] = [];
  const placeholders: string[] = [];
  const params: unknown[] = [];
  let pkValue: unknown;

  const providedCols = new Set<string>();

  for (const [fieldName, rawVal] of Object.entries(data)) {
    if (rawVal === undefined) continue;
    const f = meta.fieldsByName.get(fieldName);
    if (!f) continue;
    providedCols.add(f.column);
    colNames.push(`"${f.column}"`);
    placeholders.push("?");
    const bound = coerceBindParam(f, rawVal);
    params.push(bound);
    if (f.primaryKey) {
      pkValue = bound;
    }
  }

  for (const f of meta.fieldsByName.values()) {
    if (providedCols.has(f.column)) continue;
    if (f.defaultKind === "uuid") {
      const id = crypto.randomUUID();
      colNames.push(`"${f.column}"`);
      placeholders.push("?");
      params.push(id);
      if (f.primaryKey) pkValue = id;
    } else if (f.defaultKind === "now") {
      const now = new Date().toISOString();
      colNames.push(`"${f.column}"`);
      placeholders.push("?");
      params.push(now);
    } else if (f.defaultKind === "static") {
      const bound = coerceBindParam(f, f.defaultValue);
      colNames.push(`"${f.column}"`);
      placeholders.push("?");
      params.push(bound);
    }
  }

  const sql = `INSERT INTO "${meta.tableName}" (${colNames.join(", ")}) VALUES (${placeholders.join(", ")});`;
  return { sql, params, pkValue };
}

export function coerceBindParam(f: FieldMeta, val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val === "boolean") return val ? 1 : 0;
  if (val instanceof Date) return val.toISOString();
  if (f.type === "json" && typeof val !== "string") {
    return JSON.stringify(val);
  }
  return val;
}

export function hydrateDatabaseRow(
  meta: InternalModelMeta,
  raw: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [col, rawVal] of Object.entries(raw)) {
    const f = meta.fieldsByCol.get(col);
    if (!f) {
      out[col] = rawVal;
      continue;
    }
    let val = rawVal;
    if (val !== null && val !== undefined) {
      if (f.type === "boolean") {
        val = val === 1 || val === true || val === "1" || val === "true";
      } else if (f.type === "json" && typeof val === "string") {
        try {
          val = JSON.parse(val);
        } catch {
          // keep string if not valid JSON
        }
      }
    }
    out[f.name] = val;
  }
  return out;
}
