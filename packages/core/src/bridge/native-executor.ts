import { createRequire } from "node:module";
import { NexusError } from "../errors/index.js";
import {
  compileFilterAST,
  compileSelectSQL,
   coerceBindParam,
  hydrateDatabaseRow,
  prepareInsertStatement,
  type InternalModelMeta,
} from "../query/sql-compiler.js";
import {
  toSnakeCase,
  type FieldMeta,
  type RelationMeta,
  type SerializedSchemaManifest,
} from "../schema/index.js";

interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface RegisteredNativeModel extends InternalModelMeta {
  fields: FieldMeta[];
  relations: Map<string, Omit<RelationMeta, "targetModel">>;
}

export class NativeSqliteExecutor {
  private db: SqliteDatabase | null = null;
  private models = new Map<string, RegisteredNativeModel>();
  private stmtCache = new Map<string, SqliteStatement>();
  private activeTxId: string | null = null;

  private openDatabase(rawUrl: string): SqliteDatabase {
    let dsn = rawUrl.replace(/^file:/, "");
    if (!dsn || dsn === ":memory:" || dsn.startsWith(":memory:")) {
      dsn = ":memory:";
    }

    const req = createRequire(import.meta.url);
    const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";

    if (isBun) {
      const bunSqlite = req("bun:sqlite") as { Database: new (path: string) => SqliteDatabase };
      return new bunSqlite.Database(dsn);
    }

    const nodeSqlite = req("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
    return new nodeSqlite.DatabaseSync(dsn);
  }

  private getStmt(sql: string): SqliteStatement {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db!.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  public async handleRequest(method: string, params: Record<string, any> = {}): Promise<any> {
    switch (method) {
      case "engine.handshake":
        return { engineVersion: "0.2.0-native", protocolVersion: 1 };

      case "engine.connect": {
        if (this.db) {
          this.stmtCache.clear();
          this.db.close();
        }
        this.db = this.openDatabase(String(params.url ?? ":memory:"));
        this.db.exec("PRAGMA foreign_keys = ON;");
        return { connected: true, dialect: "sqlite", mode: "native" };
      }

      case "schema.register": {
        const manifest = params as SerializedSchemaManifest;
        this.models.clear();
        for (const m of manifest.models ?? []) {
          const fieldsByName = new Map<string, FieldMeta>();
          const fieldsByCol = new Map<string, FieldMeta>();
          let primaryKey: FieldMeta | undefined;
          for (const f of m.fields) {
            fieldsByName.set(f.name, f);
            fieldsByCol.set(f.column, f);
            if (f.primaryKey) primaryKey = f;
          }
          const relations = new Map<string, Omit<RelationMeta, "targetModel">>();
          for (const r of m.relations ?? []) {
            relations.set(r.name, r);
          }
          this.models.set(m.name, {
            name: m.name,
            tableName: m.tableName,
            fields: m.fields,
            fieldsByName,
            fieldsByCol,
            primaryKey,
            relations,
          });
        }
        return { registeredModels: this.models.size };
      }

      case "schema.push": {
        this.pushSchemaWithDiff();
        return { pushed: true };
      }

      case "query.execute": {
        return this.executeQuery(params);
      }

      case "tx.begin": {
        const txId = `tx_native_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.db!.exec("BEGIN IMMEDIATE;");
        this.activeTxId = txId;
        return { txId };
      }

      case "tx.commit": {
        if (this.activeTxId) {
          this.db!.exec("COMMIT;");
          this.activeTxId = null;
        }
        return { committed: true };
      }

      case "tx.rollback": {
        if (this.activeTxId) {
          this.db!.exec("ROLLBACK;");
          this.activeTxId = null;
        }
        return { rolledBack: true };
      }

      case "engine.ping":
        return { pong: true };

      case "engine.shutdown":
        this.close();
        return { shutdown: true };

      default:
        throw new NexusError({
          code: "NEXUS_VALIDATION_ERROR",
          message: `Method '${method}' requires the Go engine daemon`,
          retryable: false,
        });
    }
  }

  private pushSchemaWithDiff(): void {
    if (!this.db) throw new Error("Database not connected");
    this.stmtCache.clear();

    for (const m of this.models.values()) {
      const existingCols = this.db
        .prepare(`PRAGMA table_info("${m.tableName}");`)
        .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;

      if (existingCols.length === 0) {
        this.db.exec(this.buildCreateTableSQL(m.tableName, m.fields));
      } else {
        const byName = new Map(existingCols.map((c) => [c.name.toLowerCase(), c]));
        const missing: FieldMeta[] = [];
        let needsRebuild = false;

        for (const f of m.fields) {
          const existing = byName.get(f.column.toLowerCase());
          if (!existing) {
            missing.push(f);
            continue;
          }
          if (!f.primaryKey && Boolean(existing.notnull) !== !f.nullable) {
            needsRebuild = true;
          }
        }

        const currentSet = new Set(m.fields.map((f) => f.column.toLowerCase()));
        for (const c of existingCols) {
          if (!currentSet.has(c.name.toLowerCase())) {
            needsRebuild = true;
          }
        }

        if (needsRebuild) {
          this.rebuildTable(m, byName);
        } else {
          for (const f of missing) {
            const defVal =
              f.defaultKind === "static" && f.defaultValue !== undefined
                ? this.formatLiteral(f.defaultValue)
                : f.type === "integer" || f.type === "float" || f.type === "boolean"
                  ? "0"
                  : "''";
            const nullClause = f.nullable ? "" : ` NOT NULL DEFAULT ${defVal}`;
            this.db.exec(
              `ALTER TABLE "${m.tableName}" ADD COLUMN "${f.column}" ${this.mapSqlType(f)}${nullClause};`
            );
          }
        }
      }

      for (const f of m.fields) {
        if (f.primaryKey) continue;
        if (f.unique) {
          this.db.exec(
            `CREATE UNIQUE INDEX IF NOT EXISTS "uq_${m.tableName}_${f.column}" ON "${m.tableName}" ("${f.column}");`
          );
        } else if (f.index) {
          this.db.exec(
            `CREATE INDEX IF NOT EXISTS "idx_${m.tableName}_${f.column}" ON "${m.tableName}" ("${f.column}");`
          );
        }
      }

      for (const rel of m.relations.values()) {
        if (rel.kind === "manyToMany" && rel.joinTable) {
          const leftCol = `${toSnakeCase(m.name)}_id`;
          const rightCol = `${toSnakeCase(rel.target)}_id`;
          this.db.exec(
            `CREATE TABLE IF NOT EXISTS "${rel.joinTable}" ("${leftCol}" TEXT NOT NULL, "${rightCol}" TEXT NOT NULL, PRIMARY KEY ("${leftCol}", "${rightCol}"));`
          );
        }
      }
    }
  }

  private rebuildTable(
    m: RegisteredNativeModel,
    existingCols: Map<string, { name: string }>
  ): void {
    const tmpName = `_nexus_tmp_${m.tableName}_${Date.now()}`;
    this.db!.exec("PRAGMA foreign_keys = OFF;");
    try {
      this.db!.exec(this.buildCreateTableSQL(tmpName, m.fields));
      const destCols: string[] = [];
      const srcExprs: string[] = [];
      for (const f of m.fields) {
        if (existingCols.has(f.column.toLowerCase())) {
          destCols.push(`"${f.column}"`);
          srcExprs.push(`"${f.column}"`);
        } else if (!f.nullable) {
          destCols.push(`"${f.column}"`);
          srcExprs.push(
            f.defaultKind === "static" && f.defaultValue !== undefined
              ? this.formatLiteral(f.defaultValue)
              : "''"
          );
        }
      }
      if (destCols.length > 0) {
        this.db!.exec(
          `INSERT INTO "${tmpName}" (${destCols.join(", ")}) SELECT ${srcExprs.join(", ")} FROM "${m.tableName}";`
        );
      }
      this.db!.exec(`DROP TABLE "${m.tableName}";`);
      this.db!.exec(`ALTER TABLE "${tmpName}" RENAME TO "${m.tableName}";`);
    } finally {
      this.db!.exec("PRAGMA foreign_keys = ON;");
    }
  }

  private buildCreateTableSQL(tableName: string, fields: FieldMeta[]): string {
    const cols = fields.map((f) => {
      if (f.primaryKey && f.autoIncrement) {
        return `"${f.column}" INTEGER PRIMARY KEY AUTOINCREMENT`;
      }
      let def = `"${f.column}" ${this.mapSqlType(f)}`;
      if (f.primaryKey) {
        def += " PRIMARY KEY";
      } else {
        if (!f.nullable) def += " NOT NULL";
        if (f.unique) def += " UNIQUE";
        if (f.defaultKind === "static" && f.defaultValue !== undefined) {
          def += ` DEFAULT ${this.formatLiteral(f.defaultValue)}`;
        }
      }
      if (f.references?.model) {
        const refTbl = `${toSnakeCase(f.references.model)}s`;
        const refCol = toSnakeCase(f.references.column);
        def += ` REFERENCES "${refTbl}"("${refCol}") ON DELETE ${f.references.onDelete ?? "CASCADE"}`;
      }
      return def;
    });
    return `CREATE TABLE IF NOT EXISTS "${tableName}" (${cols.join(", ")});`;
  }

  private mapSqlType(f: FieldMeta): string {
    switch (f.type) {
      case "integer":
        return "INTEGER";
      case "float":
        return "REAL";
      case "boolean":
        return "BOOLEAN";
      case "date":
      case "timestamp":
        return "DATETIME";
      default:
        return "TEXT";
    }
  }

  private formatLiteral(val: unknown): string {
    if (typeof val === "boolean") return val ? "1" : "0";
    if (typeof val === "number") return String(val);
    return `'${String(val).replace(/'/g, "''")}'`;
  }

  private executeQuery(ast: Record<string, any>): any {
    const model = this.models.get(ast.model);
    if (!model) {
      throw new NexusError({
        code: "NEXUS_VALIDATION_ERROR",
        message: `Model '${ast.model}' is not registered`,
        retryable: false,
      });
    }

    try {
      switch (ast.operation) {
        case "findMany": {
          const rows = this.execFindMany(model, ast);
          return { rows, affectedRows: 0 };
        }
        case "findFirst":
        case "findUnique": {
          const rows = this.execFindMany(model, { ...ast, limit: 1 });
          return { rows, row: rows[0] ?? null, affectedRows: 0 };
        }
        case "create": {
          const { sql, params, pkValue } = prepareInsertStatement(model, ast.data ?? {});
          const res = this.getStmt(sql).run(...params);
          const lookupVal = pkValue ?? res.lastInsertRowid;
          if (model.primaryKey && lookupVal !== undefined) {
            const rows = this.execFindMany(model, {
              where: { field: model.primaryKey.name, op: "eq", value: lookupVal },
              select: ast.select,
              include: ast.include,
              limit: 1,
            });
            return { row: rows[0], rows, affectedRows: 1 };
          }
          return { row: ast.data, rows: [ast.data], affectedRows: 1 };
        }
        case "createMany": {
          const list: Array<Record<string, unknown>> = ast.dataList ?? [];
          let count = 0;
          for (const item of list) {
            const { sql, params } = prepareInsertStatement(model, item);
            this.getStmt(sql).run(...params);
            count++;
          }
          return { count, affectedRows: count };
        }
        case "update": {
          const existing = this.execFindMany(model, { where: ast.where, limit: 1 });
          if (existing.length === 0) {
            throw new NexusError({
              code: "NEXUS_NOT_FOUND",
              message: `No ${model.name} record matched update filter`,
              model: model.name,
              retryable: false,
            });
          }
          this.execUpdateWhere(model, ast.where, ast.data ?? {});
          if (model.primaryKey && existing[0]?.[model.primaryKey.name] !== undefined) {
            const updated = this.execFindMany(model, {
              where: {
                field: model.primaryKey.name,
                op: "eq",
                value: existing[0][model.primaryKey.name],
              },
              select: ast.select,
              include: ast.include,
              limit: 1,
            });
            return { row: updated[0], affectedRows: 1 };
          }
          return { row: existing[0], affectedRows: 1 };
        }
        case "updateMany": {
          const changes = this.execUpdateWhere(model, ast.where, ast.data ?? {});
          return { count: changes, affectedRows: changes };
        }
        case "delete": {
          const existing = this.execFindMany(model, { where: ast.where, limit: 1 });
          if (existing.length === 0) {
            throw new NexusError({
              code: "NEXUS_NOT_FOUND",
              message: `No ${model.name} record matched delete filter`,
              model: model.name,
              retryable: false,
            });
          }
          this.execDeleteWhere(model, ast.where);
          return { row: existing[0], affectedRows: 1 };
        }
        case "deleteMany": {
          const changes = this.execDeleteWhere(model, ast.where);
          return { count: changes, affectedRows: changes };
        }
        case "count": {
          const count = this.execCountWhere(model, ast.where);
          return { count };
        }
        case "exists": {
          const count = this.execCountWhere(model, ast.where);
          return { exists: count > 0, count };
        }
        default:
          throw new Error(`Unsupported operation ${ast.operation}`);
      }
    } catch (err) {
      if (err instanceof NexusError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/unique/i.test(msg)) {
        throw new NexusError({
          code: "NEXUS_UNIQUE_VIOLATION",
          message: msg,
          model: model.name,
          retryable: false,
        });
      }
      if (/foreign key/i.test(msg)) {
        throw new NexusError({
          code: "NEXUS_FOREIGN_KEY_VIOLATION",
          message: msg,
          model: model.name,
          retryable: false,
        });
      }
      throw new NexusError({
        code: "NEXUS_INTERNAL_ERROR",
        message: msg,
        model: model.name,
        retryable: false,
      });
    }
  }

  private execFindMany(
    model: RegisteredNativeModel,
    ast: Record<string, any>
  ): Array<Record<string, any>> {
    const compiled = compileSelectSQL(model, {
      where: ast.where,
      select: ast.select,
      orderBy: ast.orderBy,
      limit: ast.limit,
      offset: ast.offset,
    });
    const rawRows = this.getStmt(compiled.sql).all(...compiled.params);
    const rows = rawRows.map((r) => hydrateDatabaseRow(model, r));

    if (ast.include && rows.length > 0) {
      for (const [relName, incNode] of Object.entries<any>(ast.include)) {
        const rel = model.relations.get(relName);
        if (!rel) continue;
        const targetModel = this.models.get(rel.target);
        if (!targetModel) continue;

        if (rel.kind === "oneToMany" || rel.kind === "oneToOne") {
          const refField = rel.references || model.primaryKey?.name || "id";
          const parentIds = rows.map((r) => r[refField]).filter((v) => v !== undefined);
          const whereNode = incNode.where
            ? {
                AND: [
                  { field: rel.foreignKey, op: "in", value: parentIds },
                  incNode.where,
                ],
              }
            : { field: rel.foreignKey, op: "in", value: parentIds };

          const children = this.execFindMany(targetModel, {
            where: whereNode,
            select: incNode.select,
            orderBy: incNode.orderBy,
            include: incNode.include,
          });

          const grouped = new Map<string, Array<Record<string, any>>>();
          for (const c of children) {
            const k = String(c[rel.foreignKey]);
            const arr = grouped.get(k) ?? [];
            arr.push(c);
            grouped.set(k, arr);
          }

          for (const r of rows) {
            const matches = grouped.get(String(r[refField])) ?? [];
            r[relName] =
              rel.kind === "oneToOne"
                ? (matches[0] ?? null)
                : incNode.limit
                  ? matches.slice(0, incNode.limit)
                  : matches;
          }
        } else if (rel.kind === "manyToOne") {
          const refField = rel.references || targetModel.primaryKey?.name || "id";
          const fkVals = rows.map((r) => r[rel.foreignKey]).filter((v) => v != null);
          const targets = this.execFindMany(targetModel, {
            where: { field: refField, op: "in", value: fkVals },
            select: incNode.select,
            include: incNode.include,
          });
          const byId = new Map(targets.map((t) => [String(t[refField]), t]));
          for (const r of rows) {
            r[relName] = byId.get(String(r[rel.foreignKey])) ?? null;
          }
        }
      }
    }

    return rows;
  }

  private execUpdateWhere(
    model: RegisteredNativeModel,
    whereNode: any,
    data: Record<string, unknown>
  ): number {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      const f = model.fieldsByName.get(k);
      if (!f) continue;
      sets.push(`"${f.column}" = ?`);
      params.push(coerceBindParam(f, v));
    }
    let sql = `UPDATE "${model.tableName}" SET ${sets.join(", ")}`;
    const whereCompiled = compileFilterAST(model, whereNode);
    if (whereCompiled.sql) {
      sql += ` WHERE ${whereCompiled.sql}`;
      params.push(...whereCompiled.params);
    }
    const res = this.getStmt(sql + ";").run(...params);
    return Number(res.changes ?? 0);
  }

  private execDeleteWhere(model: RegisteredNativeModel, whereNode: any): number {
    let sql = `DELETE FROM "${model.tableName}"`;
    const params: unknown[] = [];
    const whereCompiled = compileFilterAST(model, whereNode);
    if (whereCompiled.sql) {
      sql += ` WHERE ${whereCompiled.sql}`;
      params.push(...whereCompiled.params);
    }
    const res = this.getStmt(sql + ";").run(...params);
    return Number(res.changes ?? 0);
  }

  private execCountWhere(model: RegisteredNativeModel, whereNode: any): number {
    let sql = `SELECT COUNT(*) as cnt FROM "${model.tableName}"`;
    const params: unknown[] = [];
    const whereCompiled = compileFilterAST(model, whereNode);
    if (whereCompiled.sql) {
      sql += ` WHERE ${whereCompiled.sql}`;
      params.push(...whereCompiled.params);
    }
    const rows = this.getStmt(sql + ";").all(...params);
    return Number(rows[0]?.cnt ?? 0);
  }

  public close(): void {
    this.stmtCache.clear();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
